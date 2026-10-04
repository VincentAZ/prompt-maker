// Prompt Maker: local web server. Zero dependencies; serves the UI, talks to LM Studio (prompts)
// and, optionally, to a local ComfyUI (renders).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import * as store from './lib/store.js';
import { listLlms, streamCompletion, EMPTY_THINK, assertLocalUrl, startServer } from './lib/lmstudio.js';
import * as assistant from './lib/assistant.js';
import * as autostart from './lib/autostart.js';
import * as services from './lib/services.js';
import * as cloud from './lib/cloud.js';
import * as folders from './lib/folders.js';
import * as videotools from './lib/videotools.js';
import { brainRecords, looksRefused, countWords, wordRange, CHECK_THEMES, testImageDataUrl } from './lib/brains.js';
import { buildGenerateMessages, buildRefineMessages, buildDraftGuideMessages, cleanPrompt, masterFor, modelFor, ADULT_CONTENT, DEFAULT_MASTER_PROMPT } from './lib/prompt.js';
import * as comfy from './lib/comfy.js';
import * as wf from './lib/workflows.js';
import * as models from './lib/models.js';
import { convertUiWorkflow, isApiWorkflow, isUiWorkflow, pruneToOutputs, ConvertError } from './lib/comfy-convert.js';

const PORT = Number(process.env.PORT) || 5317;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MAX_BODY = 30 * 1024 * 1024;
const BATCH_MAX = store.BATCH_MAX; // takes per request and renders per take (a batch is either)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
};

// The browser may only talk to this server: nothing external can load, even by accident.
// media-src blob: lets a motion video play in the page while it's read and uploaded.
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'";

// ---------- helpers ----------

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw store.httpError(413, 'Request too large.');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw store.httpError(400, 'Invalid JSON body.');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Live runs, so Stop can cancel the LLM call while the stream stays open to deliver finished takes.
const runs = new Map();

// Newline-delimited JSON stream for live token output.
function openStream(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const controller = new AbortController();
  const runId = crypto.randomUUID();
  runs.set(runId, controller);
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
    runs.delete(runId);
  });
  const send = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  return { send, runId, signal: controller.signal, end: () => { runs.delete(runId); res.end(); } };
}

// Renders and images aren't stored in the browser's cache, so a deleted one doesn't live on there.
const PRIVATE = { 'Cache-Control': 'no-store' };

// Serves a file, with byte ranges so videos can seek.
async function serveFile(req, res, file, extraHeaders = {}) {
  let data;
  try {
    data = await fs.readFile(file);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', ...extraHeaders };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const size = data.length;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return res.end(data.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.length });
  res.end(data);
}

// Blocks other websites (cross-site requests) and DNS-rebinding tricks from using this local API.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function isTrustedRequest(req) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '');
  const openToNetwork = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!openToNetwork && !LOOPBACK_HOSTS.has(hostname)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && origin !== `http://${host}`) return false;
  if (origin === 'null' && req.method !== 'GET') return false;
  return true;
}

function within(dir, rel) {
  const full = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  return full.startsWith(dir + path.sep) || full === dir ? full : null;
}

// Picks the LM Studio model to use and reports what we know about it: LM Studio's facts ({ id, name, vision,
// loaded, thinkSwitch, … }) plus its Thinking level (its own, else Settings) and how Thinking: Off works on it.
async function prepareLlm(settings, requested, needsVision) {
  const id = (requested || settings.llmModel || '').trim();
  // A cloud Brain doesn't need LM Studio at all.
  const llms = cloud.isCloudId(id) ? await cloud.listModels() : await listLlms(settings.lmStudioUrl);
  if (cloud.isCloudId(id) && !llms.some(m => m.id === id)) throw store.httpError(400, 'That cloud Brain is no longer available. Pick another one in the top bar.');
  let info;
  if (id) {
    info = llms.find(m => m.id === id) || { id, name: id, vision: null, loaded: null };
  } else {
    const loaded = llms.filter(m => m.loaded);
    info = (needsVision && loaded.find(m => m.vision)) || loaded[0];
    if (!info) throw store.httpError(400, 'No LLM selected. Pick one in the top bar (a vision model 👁 if you use images).');
  }
  if (needsVision && info.vision === false) {
    throw store.httpError(400, `"${info.name}" is text-only and can't see images. Pick a vision model (👁) in the top bar.`);
  }
  const notes = (await store.getBrainNotes())[info.id] || {};
  return { ...info, thinking: notes.thinking || settings.thinking, thinkOff: notes.thinkOff || null };
}

// Opens the event stream and tells the UI which LLM is working and whether it still has to load.
function startStream(res, info, count, hasImage) {
  const stream = openStream(res);
  stream.send({ type: 'start', runId: stream.runId, count, llmModel: info.id, llmName: info.name });
  if (info.loaded === false) stream.send({ type: 'status', text: `Loading ${info.name} into memory…` });
  else if (hasImage) stream.send({ type: 'status', text: 'Studying your image…' });
  return stream;
}

function sampling(settings, temperature, llm) {
  const t = Number(temperature);
  const opts = {
    temperature: Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.8,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
  };
  // Reasoning models think for thousands of tokens by default; prompt writing rarely needs it.
  if (llm.thinking !== 'default') opts.reasoning_effort = llm.thinking === 'off' ? 'none' : llm.thinking;
  return opts;
}

// Runs one completion with the Thinking setting applied. LM Studio can switch thinking off only for models it
// recognizes (llm.thinkSwitch). Other Brains are watched when Thinking is Off: one that starts thinking anyway is
// stopped and asked again with its thinking already over (EMPTY_THINK), and the app remembers which Brains need that.
async function complete(settings, llm, body, { signal, onUpdate, onStatus }) {
  const run = (b, stopIfThinking) => (llm.cloud
    ? cloud.stream(llm.id, b, { signal, onUpdate }, streamCompletion)
    : streamCompletion(settings.lmStudioUrl, b, { signal, onUpdate, stopIfThinking }));
  if (llm.thinking !== 'off' || llm.thinkSwitch) return run(body, false);
  const learn = thinkOff => { llm.thinkOff = thinkOff; return store.noteBrain(llm.id, { thinkOff }); };
  const tricked = { ...body, messages: [...body.messages, EMPTY_THINK] };
  if (llm.thinkOff === 'trick') return run(tricked, false);
  if (llm.thinkOff === 'stubborn') return run(body, false);
  const first = await run(body, true);
  if (!first.thoughtAnyway) {
    if (!llm.thinkOff) await learn('quiet');
    return first;
  }
  onStatus?.(`${llm.name} ignores Thinking: Off. Switching it off another way…`);
  const second = await run(tricked, true);
  if (!second.thoughtAnyway) {
    await learn('trick');
    return second;
  }
  await learn('stubborn');
  onStatus?.(`${llm.name} keeps thinking even with Thinking: Off. Letting it think…`);
  return run(body, false);
}

// A completion that must produce text: its text, or a clear error when the Brain ran out of room first.
async function writeText(settings, llm, body, opts) {
  const out = await complete(settings, llm, body, opts);
  if (!out.text && out.finishReason === 'length') throw brainFailure('room', outOfRoom(llm, body.max_tokens, out.reasoningChars));
  return out.text;
}

function outOfRoom(llm, maxTokens, reasoningChars) {
  if (!reasoningChars) return `The LLM hit the ${maxTokens}-token limit before writing anything. Raise Max tokens in Settings.`;
  if (llm.thinking === 'off') return `${llm.name} kept thinking even with Thinking: Off and hit the ${maxTokens}-token limit before writing anything. Raise Max tokens in Settings, or pick another Brain in the top bar.`;
  return `The LLM hit the ${maxTokens}-token limit before writing anything (it spent them all thinking). Set Thinking to Off (in Settings, or for this Brain on Models → Brains) or raise Max tokens in Settings.`;
}

// An error that counts against the Brain in its record ('room' or 'empty').
const brainFailure = (outcome, message) => Object.assign(store.httpError(502, message), { outcome });
const EMPTY_HINT = 'The LLM returned an empty prompt. If it is a "thinking" model it may have used all its tokens reasoning. Raise Max tokens in Settings or pick a non-thinking model.';
const secondsSince = t0 => Math.round((Date.now() - t0) / 100) / 10;

// Adds a prompt-writing run to the Brain's record. Runs that included loading the model aren't timed.
async function recordRun(llm, outcome, t0, warm) {
  await store.recordBrainRun(llm.id, { outcome, seconds: warm ? secondsSince(t0) : null }).catch(() => {});
}

// The image role used: one the model offers (its imageRoles, else reference / recreate, plus animate for video).
function roleFor(model, wanted) {
  const offered = model.imageRoles?.length ? model.imageRoles : ['reference', 'recreate', ...(model.kind === 'video' ? ['animate'] : [])];
  return offered.includes(wanted) ? wanted : offered[0];
}

function pickParams(body, model) {
  return {
    theme: String(body.theme || '').trim(),
    imageRole: roleFor(model, body.imageRole),
    aspectRatio: String(body.aspectRatio || model.defaults.aspectRatio || ''),
    resolution: String(body.resolution || model.defaults.resolution || ''),
    duration: model.kind === 'video' ? String(body.duration || model.defaults.duration || '') : '',
    length: store.LENGTHS.includes(body.length) ? body.length : model.defaults.length,
  };
}

// ---------- generation ----------

// A motion video for a character-animation model (Wan Animate 2): the stored file, the contact sheet of its frames
// that the Brain sees, and its shape. Returns { file, sheet, seconds, frames, width, height }, or null.
async function motionVideo(v, model) {
  if (!model.motionVideo || !v || typeof v !== 'object') return null;
  const file = store.videoPath(v.file);
  if (!file || !(await fs.access(file).then(() => true, () => false))) throw store.httpError(400, 'The motion video is missing. Add it again in step 3.');
  const num = (x, max) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.min(max, Math.round(Number(x) * 100) / 100) : null);
  return {
    file: v.file,
    ...(v.preview === `${v.file.slice(0, 20)}.preview.mp4` ? { preview: v.preview } : {}), // what the page plays (H.265 and such)
    sheet: /^[a-f0-9]{20}\.(jpg|png|webp)$/.test(v.sheet || '') ? v.sheet : null,
    fps: num(v.fps, 1000),
    seconds: num(v.seconds, 36000),
    frames: num(v.frames, 64),
    width: num(v.width, 16384),
    height: num(v.height, 16384),
  };
}

// The motion video as the Brain gets it (its contact sheet's data URL added), or null.
async function videoForBrain(video) {
  if (!video) return null;
  const sheetDataUrl = video.sheet ? await store.readImageDataUrl(video.sheet).catch(() => null) : null;
  return { ...video, sheetDataUrl };
}

// A take started from an earlier render (e.g. a still that becomes a video's first frame). Returns the link
// to store on the new entry, or null if that render is gone.
async function resolveSource(src) {
  if (!src || typeof src !== 'object') return null;
  const parent = await store.getHistory(String(src.entryId || ''));
  const index = Number(src.index);
  const render = parent?.variations?.[index]?.renders?.find(r => r.id === src.renderId);
  const file = render?.files?.find(f => f.file === src.file && f.kind === 'image');
  if (!file) return null;
  return {
    entryId: parent.id,
    index,
    renderId: render.id,
    file: file.file,
    kind: 'image',
    modelId: parent.modelId,
    modelName: parent.modelName,
    workflowName: render.workflowName || '',
    seed: render.seed ?? null,
    text: render.text,
  };
}

// Which chain run (and step) a take belongs to. Step 0 also carries the run's steps, so it can be resumed.
function chainRef(c) {
  if (!c || typeof c !== 'object' || !/^[\w-]{1,64}$/.test(c.runId || '')) return null;
  const step = Math.min(9, Math.max(0, Math.round(Number(c.step) || 0)));
  const ref = { runId: c.runId, step };
  if (step === 0 && Array.isArray(c.steps) && c.steps.length > 1) ref.steps = c.steps.slice(0, 10).map((s, i) => store.normalizeStep(s, i));
  return ref;
}

async function generate(req, res) {
  const body = await readBody(req);
  const settings = await store.getSettings();
  const model = await store.getModel(body.modelId || '');
  if (!model) throw store.httpError(400, 'Pick a target model first.');
  const params = pickParams(body, model);

  let imageFile = null;
  let imageDataUrl = null;
  if (body.image) {
    imageFile = await store.saveImage(body.image);
    imageDataUrl = body.image;
  } else if (body.imageFile) {
    imageFile = body.imageFile;
    imageDataUrl = await store.readImageDataUrl(imageFile);
  }
  const video = await motionVideo(body.video, model);
  const brainVideo = await videoForBrain(video);
  if (!params.theme && !imageDataUrl && !video) throw store.httpError(400, 'Enter a theme, add an image, or both.');
  const source = imageDataUrl ? await resolveSource(body.source) : null;
  const chain = chainRef(body.chain);
  const batch = typeof body.batch === 'string' ? body.batch.trim().slice(0, 60) : ''; // the saved batch this run belongs to

  const llm = await prepareLlm(settings, body.llmModel, Boolean(imageDataUrl));
  if (llm.vision === false && brainVideo) brainVideo.sheetDataUrl = null; // a text-only Brain goes by the theme alone
  const seesImages = Boolean(imageDataUrl || brainVideo?.sheetDataUrl);
  const llmModel = llm.id;
  const count = Math.min(BATCH_MAX, Math.max(1, Math.round(Number(body.variations) || 1)));
  const opts = sampling(settings, body.temperature ?? model.defaults.temperature, llm);

  const stream = startStream(res, llm, count, seesImages);
  const texts = [];
  try {
    for (let index = 0; index < count; index++) {
      const messages = buildGenerateMessages(masterFor(settings), modelFor(model, settings), { ...params, sourcePrompt: source?.text, video: brainVideo }, imageDataUrl, { index, count, previous: texts });
      const t0 = Date.now();
      const warm = llm.loaded !== false;
      const raw = await writeText(settings, llm, { model: llmModel, messages, ...opts }, {
        signal: stream.signal,
        onUpdate: u => stream.send({ type: 'delta', index, text: u.text, thinking: u.thinking, reasoningChars: u.reasoningChars }),
        onStatus: text => stream.send({ type: 'status', text }),
      });
      llm.loaded = true;
      const text = cleanPrompt(raw);
      if (!text) throw brainFailure('empty', EMPTY_HINT);
      await recordRun(llm, looksRefused(text) ? 'refused' : 'ok', t0, warm);
      texts.push(text);
      stream.send({ type: 'done', index, text });
    }
  } catch (err) {
    if (err.outcome) await recordRun(llm, err.outcome);
    if (err.name !== 'AbortError') stream.send({ type: 'error', message: err.message, index: texts.length, partial: err.partial ? cleanPrompt(err.partial) : '' });
  }

  if (texts.length) {
    const now = new Date().toISOString();
    const entry = await store.addHistory({
      modelId: model.id,
      modelName: model.name,
      modelKind: model.kind,
      llmModel,
      llmName: llm.name,
      ...params,
      temperature: opts.temperature,
      imageFile,
      ...(video ? { video } : {}),
      ...(source ? { source } : {}),
      ...(chain ? { chain } : {}),
      ...(batch ? { batch } : {}),
      variations: texts.map(text => ({ versions: [{ text, instruction: null, createdAt: now }] })),
    });
    stream.send({ type: 'saved', entry });
  }
  stream.end();
}

async function refine(req, res) {
  const body = await readBody(req);
  const settings = await store.getSettings();
  const entry = await store.getHistory(body.historyId || '');
  if (!entry) throw store.httpError(404, 'That result is no longer in history.');
  const variation = entry.variations[body.index];
  if (!variation) throw store.httpError(400, 'Unknown variation.');
  const instruction = String(body.instruction || '').trim();
  if (!instruction) throw store.httpError(400, 'Describe what to change.');
  const model = await store.getModel(entry.modelId);
  if (!model) throw store.httpError(400, `The target model "${entry.modelName}" no longer exists.`);

  // The user may refine an older version; a manual edit is only logged if the text differs from that one.
  const base = variation.versions[Number.isInteger(body.baseIndex) ? body.baseIndex : -1] || variation.versions.at(-1);
  const current = typeof body.currentText === 'string' && body.currentText.trim() ? body.currentText.trim() : base.text;
  const imageDataUrl = entry.imageFile ? await store.readImageDataUrl(entry.imageFile) : null;
  const brainVideo = model.motionVideo ? await videoForBrain(entry.video) : null;
  const llm = await prepareLlm(settings, body.llmModel, Boolean(imageDataUrl));
  if (llm.vision === false && brainVideo) brainVideo.sheetDataUrl = null;
  const seesImages = Boolean(imageDataUrl || brainVideo?.sheetDataUrl);
  const llmModel = llm.id;
  const opts = sampling(settings, body.temperature ?? entry.temperature, llm);
  const params = pickParams(entry, model);

  const stream = startStream(res, llm, 1, seesImages);
  try {
    const messages = buildRefineMessages(masterFor(settings), modelFor(model, settings), { ...params, sourcePrompt: imageDataUrl ? entry.source?.text : '', video: brainVideo }, imageDataUrl, current, instruction);
    const t0 = Date.now();
    const raw = await writeText(settings, llm, { model: llmModel, messages, ...opts }, {
      signal: stream.signal,
      onUpdate: u => stream.send({ type: 'delta', index: body.index, text: u.text, thinking: u.thinking, reasoningChars: u.reasoningChars }),
      onStatus: text => stream.send({ type: 'status', text }),
    });
    const text = cleanPrompt(raw);
    if (!text) throw brainFailure('empty', EMPTY_HINT);
    await recordRun(llm, looksRefused(text) ? 'refused' : 'ok', t0, llm.loaded !== false);
    const now = new Date().toISOString();
    const saved = await store.updateHistory(entry.id, e => {
      const v = e.variations[body.index];
      if (current !== base.text) v.versions.push({ text: current, instruction: '(manual edit)', createdAt: now });
      v.versions.push({ text, instruction, createdAt: now });
    });
    stream.send({ type: 'done', index: body.index, text });
    stream.send({ type: 'saved', entry: await store.withPresentFiles(saved) });
  } catch (err) {
    if (err.outcome) await recordRun(llm, err.outcome);
    if (err.name !== 'AbortError') stream.send({ type: 'error', message: err.message });
  }
  stream.end();
}

async function draftGuide(req, res) {
  const body = await readBody(req);
  const docs = String(body.docs || '').trim();
  if (!docs) throw store.httpError(400, 'Paste some documentation or notes first.');
  const settings = await store.getSettings();
  const llm = await prepareLlm(settings, body.llmModel, false);
  const llmModel = llm.id;
  const stream = startStream(res, llm, 1, false);
  try {
    const messages = buildDraftGuideMessages(String(body.name || 'the model'), body.kind === 'video' ? 'video' : 'image', docs);
    const text = await writeText(settings, llm, { model: llmModel, messages, ...sampling(settings, 0.3, llm), max_tokens: Math.max(settings.maxTokens, 4096) }, {
      signal: stream.signal,
      onUpdate: u => stream.send({ type: 'delta', index: 0, text: u.text, thinking: u.thinking, reasoningChars: u.reasoningChars }),
      onStatus: text => stream.send({ type: 'status', text }),
    });
    if (!text) throw store.httpError(502, EMPTY_HINT);
    stream.send({ type: 'done', index: 0, text: text.replace(/^```(?:markdown|md)?\s*\n?|\n?```\s*$/g, '').trim() });
  } catch (err) {
    if (err.name !== 'AbortError') stream.send({ type: 'error', message: err.message });
  }
  stream.end();
}

// ---------- assistant ----------

// One turn of the assistant: the LLM answers, or asks for tools (which the page runs, then sends back).
async function assistantChat(req, res) {
  const body = await readBody(req);
  const settings = await store.getSettings();
  const chat = assistant.cleanMessages(body.messages);
  const llm = await prepareLlm(settings, body.llmModel, assistant.hasImages(chat)); // looking at images needs a 👁 Brain
  const messages = [{ role: 'system', content: assistant.systemPrompt(body.state) }, ...chat];
  const tools = assistant.cleanTools(body.tools);
  const stream = openStream(res);
  stream.send({ type: 'start', runId: stream.runId, llmName: llm.name });
  if (llm.loaded === false) stream.send({ type: 'status', text: `Loading ${llm.name} into memory…` });
  try {
    const maxTokens = Math.max(settings.maxTokens, 2048);
    const out = await complete(settings, llm, {
      model: llm.id,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...sampling(settings, 0.3, llm),
      max_tokens: maxTokens,
    }, {
      signal: stream.signal,
      onUpdate: u => stream.send({ type: 'delta', text: u.text, thinking: u.thinking }),
      onStatus: text => stream.send({ type: 'status', text }),
    });
    const { text, toolCalls } = out.toolCalls.length ? out : assistant.fallbackToolCalls(out.text);
    if (!text && !toolCalls.length) {
      throw store.httpError(502, out.finishReason === 'length'
        ? outOfRoom(llm, maxTokens, out.reasoningChars)
        : 'The brain sent back an empty answer. Try again, or pick a bigger model in the top bar.');
    }
    stream.send({ type: 'done', text, toolCalls });
  } catch (err) {
    if (err.name !== 'AbortError') stream.send({ type: 'error', message: err.message });
  }
  stream.end();
}

// ---------- services (Settings → Services) ----------

const comfyUp = settings => comfy.status(settings.comfyUrl).then(() => true, () => false);

// What's running, and whether each can be started or stopped from here. Seeing ComfyUI run also teaches the app
// how you start it (folder, Python, options), so its Start button does the same.
async function servicesStatus() {
  const settings = await store.getSettings();
  const [llms, comfyStatus, proc, unitActive, app, onService] = await Promise.all([
    listLlms(settings.lmStudioUrl).catch(() => null),
    comfy.status(settings.comfyUrl).catch(() => null),
    services.comfyProcess(settings.comfyUrl),
    services.comfyUnitActive(),
    autostart.status(),
    services.underService(),
  ]);
  if (proc) {
    const learned = { dir: proc.dir, python: proc.python, pre: proc.pre, args: proc.args };
    if (JSON.stringify(learned) !== JSON.stringify(settings.comfyLaunch)) Object.assign(settings, await store.updateSettings({ comfyLaunch: learned }));
  }
  const launch = await services.comfyLaunch(settings);
  return {
    app: { service: onService, autostart: app.autostart, supported: app.supported },
    lms: { running: Boolean(llms), loaded: llms ? llms.filter(m => m.loaded).length : 0, local: services.isLocalUrl(settings.lmStudioUrl) },
    comfy: {
      running: Boolean(comfyStatus),
      starting: !comfyStatus && unitActive,
      gpu: comfyStatus?.gpu || '',
      local: services.isLocalUrl(settings.comfyUrl),
      autostart: settings.comfyAutostart,
      launch: launch.dir ? { dir: launch.dir, command: [launch.python, ...launch.pre, 'main.py', ...launch.args].join(' '), from: launch.from } : null,
    },
  };
}

// ---------- Brains ----------

// What the app knows about a Brain beyond LM Studio's facts (see store.getBrainNotes).
const brainView = (n = {}) => ({ thinking: n.thinking || null, thinkOff: n.thinkOff || null, stats: n.stats || null, check: n.check || null });

// Quick check: a short test of one Brain on this machine. It writes an image prompt and a video prompt, and looks
// at a test image if it's a vision model. It uses the Brain's own Thinking level, so the times match Create.
async function checkBrain(req, res) {
  const body = await readBody(req);
  const settings = await store.getSettings();
  const llm = await prepareLlm(settings, String(body.id || ''), false);
  const models = await store.listModels();
  const target = (id, kind) => models.find(x => x.id === id) || models.find(x => x.kind === kind);
  const targets = [target('krea2-raw', 'image'), target('ltx-2-3', 'video')].filter(Boolean);
  const stream = openStream(res);
  stream.send({ type: 'start', runId: stream.runId });
  const status = text => stream.send({ type: 'status', text });
  const check = { at: new Date().toISOString() };
  try {
    if (llm.loaded === false) {
      status(`Loading ${llm.name}…`);
      const t0 = Date.now();
      await streamCompletion(settings.lmStudioUrl, { model: llm.id, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 1 }, { signal: stream.signal });
      check.loadSeconds = secondsSince(t0);
    }
    for (const model of targets) {
      status(`Writing ${model.kind === 'video' ? 'a video' : 'an image'} prompt for ${model.name}…`);
      check[model.kind] = await checkPrompt(settings, llm, model, stream.signal, status);
    }
    if (llm.vision !== false) {
      status('Looking at a test image…');
      check.vision = await checkVision(settings, llm, stream.signal, status);
    }
    await store.noteBrain(llm.id, { check });
    stream.send({ type: 'done', check });
  } catch (err) {
    if (err.name !== 'AbortError') stream.send({ type: 'error', message: err.message });
  }
  stream.end();
}

async function checkPrompt(settings, llm, model, signal, onStatus) {
  const params = pickParams({ theme: CHECK_THEMES[model.kind], length: 'medium' }, model);
  const messages = buildGenerateMessages(masterFor(settings), modelFor(model, settings), params, null, { index: 0, count: 1, previous: [] });
  const target = model.lengthGuide?.medium || null;
  const t0 = Date.now();
  try {
    const raw = await writeText(settings, llm, { model: llm.id, messages, ...sampling(settings, model.defaults.temperature, llm) }, { signal, onStatus });
    const text = cleanPrompt(raw);
    const words = countWords(text);
    const range = wordRange(target);
    const refused = looksRefused(text);
    return {
      model: model.name,
      seconds: secondsSince(t0),
      ok: Boolean(text) && !refused,
      refused,
      words,
      target,
      inRange: range ? words >= range[0] * 0.8 && words <= range[1] * 1.25 : null,
      tidy: text === raw.trim(), // no preamble, quotes or code fences to strip
      sample: text.slice(0, 600),
    };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { model: model.name, seconds: secondsSince(t0), ok: false, error: err.message };
  }
}

// Shows the Brain an image that is half red, half blue, and asks for the two colors.
async function checkVision(settings, llm, signal, onStatus) {
  const messages = [
    { role: 'system', content: 'You describe images in as few words as possible.' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: testImageDataUrl() } }, { type: 'text', text: 'Which two colors fill this image? Answer with just the two color names.' }] },
  ];
  const t0 = Date.now();
  try {
    const out = await complete(settings, llm, { model: llm.id, messages, ...sampling(settings, 0.2, llm) }, { signal, onStatus });
    const answer = out.text.trim();
    return { seconds: secondsSince(t0), ok: /\bred\b/i.test(answer) && /\bblue\b/i.test(answer), answer: answer.slice(0, 120) };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { seconds: secondsSince(t0), ok: false, error: err.message };
  }
}

// ---------- ComfyUI workflows & renders ----------

// Turns an uploaded or ComfyUI-saved workflow into an API prompt plus a suggested input mapping.
async function prepareWorkflow(body) {
  const settings = await store.getSettings();
  let json = body.json;
  let name = String(body.name || '').replace(/\.json$/i, '');
  let source = 'upload';
  let sourceModified = null;
  if (body.comfyPath) {
    const listed = (await comfy.savedWorkflows(settings.comfyUrl)).find(f => f.path === body.comfyPath);
    if (!listed) throw store.httpError(404, `“${body.comfyPath}” isn't in ComfyUI's saved workflows anymore. Was it renamed or deleted?`);
    json = await comfy.readSavedWorkflow(settings.comfyUrl, body.comfyPath);
    name = body.comfyPath.split('/').pop().replace(/\.json$/i, '');
    source = `comfyui:${body.comfyPath}`;
    sourceModified = Number(listed.modified) || null;
  } else if (body.template) {
    json = await comfy.readTemplate(settings.comfyUrl, String(body.template));
    name = String(body.templateTitle || body.template).trim().slice(0, 120);
    source = `comfytemplate:${body.template}`;
  }
  if (!json || typeof json !== 'object') throw store.httpError(400, 'That file is not valid JSON.');
  let preset = null;
  if (json.format === wf.EXPORT_FORMAT) {
    preset = json;
    name = json.name || name;
    json = json.prompt;
  }
  let prompt;
  const info = await comfy.objectInfo(settings.comfyUrl).catch(() => null);
  const links = preset ? models.sanitizeLinks(preset.models) : models.modelLinks(json);
  if (isApiWorkflow(json)) {
    prompt = json;
  } else if (isUiWorkflow(json)) {
    if (!info) throw store.httpError(400, 'ComfyUI needs to be running to read this workflow (it is in editor format). Start ComfyUI and try again, or export it with Workflow → Export (API).');
    try {
      prompt = pruneToOutputs(convertUiWorkflow(json, info), info);
    } catch (err) {
      if (err instanceof ConvertError) throw store.httpError(400, err.message);
      throw err;
    }
  } else {
    throw store.httpError(400, 'This doesn\'t look like a ComfyUI workflow. In ComfyUI use Workflow → Save, or Workflow → Export (API).');
  }
  const fixed = wf.repair(prompt);
  if (fixed.length && info) prompt = pruneToOutputs(prompt, info);
  const analysis = wf.analyze(prompt, info);
  const { missing } = models.checkModels(prompt, info, links);
  return {
    name: name || 'Workflow',
    source,
    sourceModified,
    prompt,
    models: links,
    missing,
    mapping: preset?.mapping || analysis.mapping,
    options: preset?.options || analysis.options,
    candidates: analysis.candidates,
    warnings: [...fixed, ...analysis.warnings, ...(missing.length ? [models.describeMissing(missing).replace('in step ⑤', 'in step ⑤ once this is saved')] : [])],
    producesVideo: analysis.producesVideo,
    nodes: Object.keys(prompt).length,
  };
}

// Pulls in a newer version of a workflow: from ComfyUI (if it came from there) or from a file you pick.
async function refreshWorkflow(existing, body) {
  const fromComfy = existing.source.startsWith('comfyui:');
  const template = existing.source.startsWith('comfytemplate:') ? existing.source.slice('comfytemplate:'.length) : '';
  if (!body.json && !fromComfy && !template) throw store.httpError(400, 'This workflow was uploaded from a file. Pick the new version of the file to update it.');
  const fresh = await prepareWorkflow(body.json ? { json: body.json, name: existing.name } : template ? { template, templateTitle: existing.name } : { comfyPath: existing.source.slice('comfyui:'.length) });
  const { mapping, overrides, loras, lost, changes } = wf.carryOver(existing, fresh.prompt, fresh.mapping);
  if (!mapping.prompt.length) throw store.httpError(400, 'The new version has no text input for the prompt, so it can\'t be used for rendering.');
  const saved = await wf.saveWorkflow({ prompt: fresh.prompt, mapping, overrides, loras, models: fresh.models, sourceModified: fresh.sourceModified, ...(body.json ? { source: 'upload' } : {}) }, existing);
  return { ...saved, candidates: fresh.candidates, warnings: fresh.warnings, producesVideo: fresh.producesVideo, lost, changes };
}

const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// The names an entry's input image gets in ComfyUI's input folder (its render original, or the copy the LLM saw).
const uploadNames = e => [e.source?.file, e.imageFile, e.video?.file].filter(Boolean).map(name => `prompt-maker_${name}`);
const VIDEO_MIME = Object.fromEntries(Object.entries(store.VIDEO_TYPES).map(([mime, ext]) => [ext, mime]));
// And the names its renders got when a take was made from one of them (animating a still uploads the still).
const renderUploads = renders => renders.flatMap(r => (r.files || []).map(f => `prompt-maker_${f.file}`));

// Size and checksum of each of these renders' files, read before they're deleted, to find ComfyUI's own copies.
async function fingerprints(renders) {
  const out = [];
  for (const f of renders.flatMap(r => r.files || [])) {
    const buf = await fs.readFile(path.join(store.RENDERS_DIR, f.file)).catch(() => null);
    if (buf) out.push(comfy.fingerprint(buf));
  }
  return out;
}

// Drops copies with the same content as a render an entry still has (the same seed and prompt rendered twice):
// ComfyUI's file of that content may be that entry's.
async function notShared(copies, rest) {
  const sizes = new Set(copies.map(c => c.size));
  const shared = new Set();
  for (const f of rest.flatMap(e => e.variations.flatMap(v => (v.renders || []).flatMap(r => r.files || [])))) {
    const file = path.join(store.RENDERS_DIR, f.file);
    if (!sizes.has((await fs.stat(file).catch(() => null))?.size)) continue;
    const buf = await fs.readFile(file).catch(() => null);
    if (buf) shared.add(comfy.fingerprint(buf).sha1);
  }
  return copies.filter(c => !shared.has(c.sha1));
}

// Removes what ComfyUI keeps of deleted renders or takes: their jobs (found by id or prompt text), the files those
// jobs saved, ComfyUI's copies of the renders (found by content), and uploaded input images no entry left uses.
// Returns a note if some of it may be out of reach, else null.
async function forgetInComfy(settings, { promptIds = [], texts = [], copies = [], inputs = [], rest = [] }) {
  const base = settings.comfyUrl;
  const refs = inputs.map(filename => ({ type: 'input', subfolder: '', filename }));
  if (promptIds.some(Boolean) || texts.length) {
    // Not running: its history (kept in memory) is already gone, and its folders are still found below.
    refs.push(...await comfy.forgetJobs(base, { promptIds, texts }).catch(err => (console.warn(`ComfyUI: ${err.message}`), [])));
  }
  const keep = new Set(rest.flatMap(uploadNames));
  const dirs = await comfy.folders(base, { output: settings.comfyOutputDir, roots: [settings.comfyDir, settings.comfyLaunch?.dir] });
  await comfy.removeFiles(dirs, refs.filter(r => !(r.type === 'input' && keep.has(r.filename))), copies.length ? await notShared(copies, rest) : [])
    .catch(err => console.warn(`Couldn't remove ComfyUI's copies: ${err.message}`));
  if (copies.length && !dirs.output && !settings.comfyCleanup) return "ComfyUI's output folder wasn't found, so its own copies of the renders may still be there. Set the folder in Settings → ComfyUI, or delete them there.";
  return null;
}

async function deleteTake(id) {
  const settings = await store.getSettings();
  const found = await store.getHistory(id);
  if (!found) return { ok: true };
  const renders = found.variations.flatMap(v => v.renders || []);
  const copies = await fingerprints(renders);
  const { entry, rest } = await store.deleteHistory(id);
  if (!entry) return { ok: true };
  // A prompt another entry also has (word for word) may be that one's job, so it isn't used to find jobs.
  const others = new Set(rest.flatMap(e => e.variations.flatMap(v => v.versions.map(x => x.text))));
  const texts = [...new Set(entry.variations.flatMap(v => v.versions.map(x => x.text)))].filter(t => !others.has(t));
  const left = await forgetInComfy(settings, { promptIds: renders.map(r => r.promptId), texts, copies, inputs: [...uploadNames(entry), ...renderUploads(renders)], rest });
  return { ok: true, ...(left ? { left } : {}) };
}

async function deleteOneRender(entryId, renderId) {
  const settings = await store.getSettings();
  const render = (await store.getHistory(entryId))?.variations.flatMap(v => v.renders || []).find(r => r.id === renderId);
  const copies = render ? await fingerprints([render]) : [];
  const { entry, removed, rest } = await store.deleteRender(entryId, renderId);
  await forgetInComfy(settings, { promptIds: [removed.promptId], copies, inputs: renderUploads([removed]), rest });
  return entry;
}

// Download links for a workflow's model files: saved with it, or read again from where it came from (workflows added
// before Prompt Maker kept them).
async function workflowLinks(workflow, base) {
  if (workflow.models?.length) return workflow.models;
  const src = workflow.source || '';
  const json = src.startsWith('comfyui:') ? await comfy.readSavedWorkflow(base, src.slice('comfyui:'.length)).catch(() => null)
    : src.startsWith('comfytemplate:') ? await comfy.readTemplate(base, src.slice('comfytemplate:'.length)).catch(() => null)
      : null;
  return json && isUiWorkflow(json) ? models.modelLinks(json) : [];
}

// The model files a workflow needs that ComfyUI doesn't have (with their download links), as the render would use
// it: a LoRA switched off doesn't count. fresh: ask ComfyUI again (a model was just added). Returns { info, missing, fixes }.
async function workflowModels(workflow, base, { fresh = false } = {}) {
  let info = await comfy.objectInfo(base, { fresh }).catch(() => null);
  if (!info) return { info, missing: [], fixes: [], checked: false };
  let probe;
  try {
    probe = wf.buildPrompt(workflow, { text: '' }, info).prompt;
  } catch {
    probe = workflow.prompt;
  }
  let check = models.checkModels(probe, info);
  if (check.missing.length && !fresh) { // maybe added since Prompt Maker last asked
    info = await comfy.objectInfo(base, { fresh: true }).catch(() => info);
    check = models.checkModels(probe, info);
  }
  if (check.missing.length) check = models.checkModels(probe, info, await workflowLinks(workflow, base));
  return { info, ...check, checked: true };
}

// Stops a render before anything is sent when ComfyUI lacks a model file the workflow loads. Returns /object_info.
async function checkWorkflowModels(workflow, base) {
  const { info, missing } = await workflowModels(workflow, base);
  if (missing.length) throw Object.assign(store.httpError(400, models.describeMissing(missing)), { missingModels: missing });
  return info;
}

async function renderTake(req, res) {
  const body = await readBody(req);
  const settings = await store.getSettings();
  const entry = await store.getHistory(body.historyId || '');
  if (!entry) throw store.httpError(404, 'That take is no longer in history.');
  const variation = entry.variations[body.index];
  if (!variation) throw store.httpError(400, 'Unknown take.');
  const versionIndex = variation.versions[body.versionIndex] ? body.versionIndex : variation.versions.length - 1;
  const text = variation.versions[versionIndex].text;
  const workflow = wf.withSetup(await wf.getWorkflow(body.workflowId || ''), body.setup);
  if (!workflow) throw store.httpError(400, 'Pick a workflow to render with.');
  if (workflow.mapping.image && !entry.imageFile) {
    throw store.httpError(400, `"${workflow.name}" needs an input image (it has a Load Image node), but this take has none. Add an image on the Create page, or pick a text-to-image/video workflow.`);
  }
  if (workflow.mapping.video && !entry.video?.file) {
    throw store.httpError(400, `"${workflow.name}" needs a motion video (it has a Load Video node), but this take has none. Add a motion video in step 3 on the Create page, then Generate again.`);
  }
  const base = settings.comfyUrl;
  await comfy.status(base);
  const info = await checkWorkflowModels(workflow, base);
  let imageName = null;
  if (workflow.mapping.image && entry.imageFile) {
    // A take started from a render sends that original file (full size, lossless), not the smaller copy the LLM saw.
    const original = entry.source?.file ? within(store.RENDERS_DIR, entry.source.file) : null;
    const useOriginal = Boolean(original) && (await fs.access(original).then(() => true, () => false));
    const name = useOriginal ? entry.source.file : entry.imageFile;
    const buf = await fs.readFile(useOriginal ? original : path.join(store.IMAGES_DIR, entry.imageFile));
    const ext = name.split('.').pop().toLowerCase();
    imageName = await comfy.uploadImage(base, buf, `prompt-maker_${name}`, IMAGE_MIME[ext] || 'image/png');
  }
  let videoName = null;
  if (workflow.mapping.video && entry.video?.file) {
    const file = store.videoPath(entry.video.file);
    const buf = await fs.readFile(file).catch(() => { throw store.httpError(404, 'This take\'s motion video is missing from the data folder.'); });
    videoName = await comfy.uploadImage(base, buf, `prompt-maker_${entry.video.file}`, VIDEO_MIME[entry.video.file.split('.').pop()] || 'video/mp4');
  }
  const count = Math.min(BATCH_MAX, Math.max(1, Math.round(Number(body.count) || 1)));
  // How many frames the motion video has: a workflow made of pieces gets as many as it needs, and one that loops over
  // the whole video says how many pieces it's on.
  let videoFrames = null;
  if (workflow.mapping.video && entry.video?.file) {
    const info = entry.video.seconds && entry.video.fps ? entry.video : await videotools.probe(store.videoPath(entry.video.file));
    if (info?.seconds && info?.fps) videoFrames = Math.round(info.seconds * info.fps);
  }
  const pieces = videoFrames ? wf.loopPieces(workflow.prompt, videoFrames) : null;
  const seeds = await wf.takeSeeds(workflow.id, count, { fresh: body.newSeed === true });
  const stream = openRenderJob({ historyId: entry.id, index: body.index, versionIndex, count, workflowId: workflow.id, workflowName: workflow.name, theme: entry.theme || '', modelName: entry.modelName, modelId: entry.modelId, aspectRatio: entry.aspectRatio });
  stream.send({ type: 'start', runId: stream.runId, count, workflowName: workflow.name });
  watchRenderJob(stream.job, res);
  const clientId = comfy.newClientId();
  for (let i = 0; i < count; i++) {
    if (i > 0 && !(await store.getHistory(entry.id))) break; // deleted meanwhile: its prompt isn't sent again
    const t0 = Date.now();
    let promptId = null;
    const onAbort = () => { if (promptId) comfy.cancel(base, promptId); };
    try {
      const seed = seeds[i];
      const { prompt, applied } = wf.buildPrompt(workflow, {
        text,
        imageName,
        videoName,
        aspectRatio: entry.aspectRatio,
        resolution: entry.resolution,
        duration: entry.duration,
        seed,
        videoFrames,
      }, info);
      models.applyFixes(prompt, models.checkModels(prompt, info).fixes); // files ComfyUI keeps in a subfolder
      promptId = await comfy.queuePrompt(base, prompt, clientId);
      stream.signal.addEventListener('abort', onAbort, { once: true });
      stream.send({ type: 'queued', i, applied });
      let lastPreview = 0;
      const done = await comfy.watch(base, promptId, clientId, prompt, {
        signal: stream.signal,
        pieces,
        onEvent: ev => {
          if (ev.type !== 'preview') return stream.send({ ...ev, i });
          if (Date.now() - lastPreview < 350) return;
          lastPreview = Date.now();
          stream.send({ type: 'preview', i, src: `data:${ev.mime};base64,${ev.data.toString('base64')}` });
        },
      });
      stream.signal.removeEventListener('abort', onAbort);
      const outputs = comfy.outputFiles(done);
      if (!outputs.length) throw store.httpError(502, 'ComfyUI finished but saved no image, video or audio. Does the workflow end in a Save node?');
      const id = crypto.randomUUID();
      const files = [];
      const copies = [];
      // ComfyUI reuses its numbers (ComfyUI_00001_.png) once files are gone, so copies get their own names.
      const named = [store.slugify(entry.modelName), store.slugify(entry.theme || 'from-image').slice(0, 40), applied.seed ?? null, id.slice(0, 6)].filter(x => x !== null && x !== '').join('_');
      for (const [n, out] of outputs.entries()) {
        const ext = (path.extname(out.filename).toLowerCase() || '.bin').replace(/[^.\w]/g, '');
        const file = `${id}_${n}${ext}`;
        const buf = await comfy.download(base, out);
        await fs.writeFile(path.join(store.RENDERS_DIR, file), buf);
        copies.push(comfy.fingerprint(buf));
        files.push({ file, kind: out.kind, name: `${named}${outputs.length > 1 ? `-${n + 1}` : ''}${ext}` });
        if (settings.comfyCleanup) {
          await comfy.removeOutput(base, out, buf.length, settings.comfyOutputDir).catch(err => console.warn(`Couldn't remove ${out.filename} from ComfyUI's output folder: ${err.message}`));
        }
      }
      const render = {
        id,
        promptId,
        versionIndex,
        text,
        workflowId: workflow.id,
        workflowName: workflow.name,
        seed: applied.seed ?? null,
        sampler: applied.sampler,
        steps: applied.steps,
        cfg: applied.cfg,
        size: applied.size || null,
        aspect: applied.aspect || null,
        frames: applied.frames || null,
        duration: applied.duration || null,
        ...(applied.loras?.length ? { loras: applied.loras } : {}),
        // The rest of the setup, so opening this from History can put it all back.
        count,
        seedMode: workflow.options?.seedMode || 'random',
        overrides: workflow.overrides || {},
        files,
        createdAt: new Date().toISOString(),
        secs: Math.round((Date.now() - t0) / 100) / 10,
      };
      try {
        await store.updateHistory(entry.id, e => { (e.variations[body.index].renders ||= []).push(render); });
      } catch (err) {
        if (err.status !== 404) throw err;
        // The take was deleted while this rendered: none of it is kept, here or in ComfyUI.
        await store.removeRenderFiles([render]);
        await forgetInComfy(settings, { promptIds: [promptId], copies, inputs: [imageName, videoName].filter(Boolean), rest: await store.listHistory() });
        throw store.httpError(404, 'That take was deleted, so its render was thrown away.');
      }
      stream.send({ type: 'render', i, render });
    } catch (err) {
      stream.signal.removeEventListener('abort', onAbort);
      if (err.name === 'AbortError' || stream.signal.aborted) {
        if (promptId) await comfy.cancel(base, promptId);
        break;
      }
      stream.send({ type: 'error', i, message: err.message });
      break;
    }
  }
  stream.end();
}

// A render keeps going when the page that started it closes or reloads: the page only watches it, and can pick it
// up again (GET /api/renders, then /api/renders/:id/watch). Stop and ✕ cancel it through /api/runs/:id/cancel.
// Each job keeps its events to replay to a page that comes back, except previews: only the latest per render.
const renderJobs = new Map();

function openRenderJob(meta) {
  const controller = new AbortController();
  const runId = crypto.randomUUID();
  const job = { ...meta, runId, events: [], previews: new Map(), watchers: new Set(), done: false, startedAt: Date.now(), now: { i: 0, finished: 0, pct: null, stage: 'Waiting for ComfyUI…' } };
  runs.set(runId, controller);
  renderJobs.set(runId, job);
  // What the Rendering panel shows: which render of the job, how far, doing what.
  const track = ev => {
    const now = job.now;
    if (ev.i != null && ev.type !== 'render' && ev.type !== 'preview') { if (ev.i !== now.i) Object.assign(now, { pct: null }); now.i = ev.i; }
    if (ev.type === 'queued') now.stage = ev.position > 1 ? `Waiting: ${ev.position - 1} ahead in ComfyUI` : ev.position === 1 ? 'Next up in ComfyUI' : 'Sent to ComfyUI…';
    else if (ev.type === 'running') Object.assign(now, { stage: 'Starting…', pct: 0 });
    else if (ev.type === 'node') now.stage = ev.title;
    else if (ev.type === 'progress' && ev.max) now.pct = Math.round(ev.overall ?? (ev.value / ev.max) * 100);
    else if (ev.type === 'render') Object.assign(now, { finished: now.finished + 1, pct: null, stage: 'Saving…' });
    else if (ev.type === 'error') now.stage = `⚠️ ${ev.message}`;
  };
  const send = obj => {
    track(obj);
    if (obj.type === 'preview') job.previews.set(obj.i, obj);
    else job.events.push(obj);
    for (const res of job.watchers) if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
  };
  const end = () => {
    job.done = true;
    runs.delete(runId);
    for (const res of job.watchers) res.end();
    setTimeout(() => renderJobs.delete(runId), 60_000); // a page reloading right now still gets the ending
  };
  return { send, end, runId, signal: controller.signal, job };
}

function watchRenderJob(job, res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  for (const ev of [...job.events, ...job.previews.values()]) res.write(JSON.stringify(ev) + '\n');
  if (job.done) return res.end();
  job.watchers.add(res);
  res.on('close', () => job.watchers.delete(res));
}

// When this server started: Create's "This session" box shows the renders made since then.
const STARTED_AT = new Date().toISOString();
// The version people see in Settings (for bug reports): package.json's, plus the exact commit when run from git.
const VERSION = await (async () => {
  const { version } = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'package.json'), 'utf8'));
  const git = path.join(import.meta.dirname, '.git');
  const head = (await fs.readFile(path.join(git, 'HEAD'), 'utf8').catch(() => '')).trim();
  const ref = head.startsWith('ref: ') ? head.slice(5) : '';
  const sha = ref ? (await fs.readFile(path.join(git, ref), 'utf8').catch(async () => {
    const packed = await fs.readFile(path.join(git, 'packed-refs'), 'utf8').catch(() => '');
    return packed.split('\n').find(l => l.endsWith(` ${ref}`))?.split(' ')[0] || '';
  })).trim() : head;
  return /^[0-9a-f]{7,}$/.test(sha) ? `${version} (${sha.slice(0, 7)})` : version;
})();

// ---------- routing ----------

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const m = req.method;
  let match;
  if (p.startsWith('/api/') && !isTrustedRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });

  if (p === '/api/models' && m === 'GET') return sendJson(res, 200, await store.listModels());
  if (p === '/api/models' && m === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body) ? body : [body];
    const overwrite = url.searchParams.get('overwrite') === '1';
    const saved = [];
    for (const item of items) saved.push(await store.saveModel(item, { overwrite }));
    return sendJson(res, 200, Array.isArray(body) ? saved : saved[0]);
  }
  if (p === '/api/models/draft' && m === 'POST') return draftGuide(req, res);
  if (p === '/api/chains' && m === 'GET') return sendJson(res, 200, await store.listChains());
  if (p === '/api/chains' && m === 'POST') return sendJson(res, 200, await store.saveChain(await readBody(req), { overwrite: url.searchParams.get('overwrite') === '1' }));
  if ((match = p.match(/^\/api\/chains\/([\w-]+)$/)) && m === 'DELETE') {
    await store.deleteChain(match[1]);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/models/hidden' && m === 'GET') return sendJson(res, 200, await store.hiddenBuiltins());
  if ((match = p.match(/^\/api\/models\/([\w-]+)\/reset$/)) && m === 'POST') return sendJson(res, 200, await store.resetModel(match[1]));
  if ((match = p.match(/^\/api\/models\/([\w-]+)$/))) {
    const id = match[1];
    if (m === 'GET') {
      const model = await store.getModel(id);
      return model ? sendJson(res, 200, model) : sendJson(res, 404, { error: 'Model not found' });
    }
    if (m === 'PUT') {
      const body = await readBody(req);
      // A changed name/id renames the file; refuse to clobber a different existing model.
      const renamed = store.slugify(body.id || body.name) !== id;
      return sendJson(res, 200, await store.saveModel(body, { overwrite: !renamed, previousId: id }));
    }
    if (m === 'DELETE') {
      await store.deleteModel(id);
      await wf.deleteWorkflowsForModel(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // Both responses carry the defaults the Settings page needs (e.g. for "Reset to default").
  const settingsView = s => ({ ...s, defaultMasterPrompt: DEFAULT_MASTER_PROMPT, defaultAdultPrompt: ADULT_CONTENT, dataDir: store.DATA_DIR, version: VERSION, startedAt: STARTED_AT });
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, settingsView(await store.getSettings()));
  if (p === '/api/settings' && m === 'PUT') {
    const body = await readBody(req);
    if (typeof body.lmStudioUrl === 'string') assertLocalUrl(body.lmStudioUrl.trim());
    if (typeof body.comfyUrl === 'string') assertLocalUrl(body.comfyUrl.trim());
    return sendJson(res, 200, settingsView(await store.updateSettings(body)));
  }

  if (p === '/api/llms' && m === 'GET') {
    const settings = await store.getSettings();
    const base = url.searchParams.get('url') || settings.lmStudioUrl;
    try {
      const [models, notes, history, clouds] = await Promise.all([listLlms(base), store.getBrainNotes(), store.listHistory(), cloud.listModels()]);
      const records = brainRecords(history);
      return sendJson(res, 200, { ok: true, url: base, models: [...models, ...clouds].map(m => ({ ...m, ...brainView(notes[m.id]), record: records[m.id] || null })) });
    } catch (err) {
      // LM Studio is down, but cloud Brains still work.
      const clouds = await cloud.listModels().catch(() => []);
      return sendJson(res, 200, { ok: false, url: base, error: err.message, models: clouds });
    }
  }

  // Starting with the computer (Settings): on/off, and whether the offline page's Start link works here.
  if (p === '/api/autostart' && m === 'GET') return sendJson(res, 200, await autostart.status());
  if (p === '/api/autostart' && m === 'PUT') {
    const body = await readBody(req);
    return sendJson(res, 200, await autostart.setAutostart(Boolean(body.enabled)));
  }

  // Settings → Services: what's running, and start / stop buttons for each.
  if (p === '/api/services' && m === 'GET') return sendJson(res, 200, await servicesStatus());
  if ((match = p.match(/^\/api\/services\/(comfy|lms|app|all)\/(start|stop)$/)) && m === 'POST') {
    const [, what, action] = match;
    const settings = await store.getSettings();
    if (what === 'comfy' && action === 'start') return sendJson(res, 200, { ok: true, launch: await services.startComfy(settings) });
    if (what === 'comfy') await services.stopComfy(settings, () => comfyUp(settings));
    else if (what === 'lms' && action === 'start') await startServer(settings.lmStudioUrl);
    else if (what === 'lms') await services.stopLmStudio();
    else if (what === 'all' && action === 'stop') {
      // Everything, then this server: frees the GPU. What fails to stop (e.g. a ComfyUI started elsewhere) doesn't block the rest.
      await services.stopComfy(settings, () => comfyUp(settings)).catch(() => {});
      if (services.isLocalUrl(settings.lmStudioUrl)) await services.stopLmStudio().catch(() => {});
      await services.stopApp();
    } else if (what === 'app' && action === 'stop') await services.stopApp();
    else throw store.httpError(400, 'Nothing to do.');
    return sendJson(res, 200, { ok: true });
  }

  // Cloud Brains (Settings): providers you add, with your keys. The page never gets a key back.
  if (p === '/api/providers' && m === 'GET') {
    await cloud.listModels(); // fills in each provider's model count
    return sendJson(res, 200, { catalog: cloud.CATALOG, providers: await cloud.listProviders() });
  }
  if (p === '/api/providers' && m === 'POST') return sendJson(res, 200, await cloud.addProvider(await readBody(req)));
  if (p === '/api/providers/trust' && m === 'PUT') {
    const body = await readBody(req);
    await cloud.setTrusted(body.id ?? null, body.trusted);
    return sendJson(res, 200, { providers: await cloud.listProviders() });
  }
  if ((match = p.match(/^\/api\/providers\/([\w-]+)$/)) && m === 'DELETE') {
    await cloud.removeProvider(match[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/brains' && m === 'PUT') {
    const body = await readBody(req);
    if (!body.id) throw store.httpError(400, 'Which Brain?');
    return sendJson(res, 200, brainView(await store.setBrainThinking(String(body.id), body.thinking || '')));
  }
  if (p === '/api/brains/check' && m === 'POST') return checkBrain(req, res);

  if (p === '/api/lmstudio/start' && m === 'POST') {
    const settings = await store.getSettings();
    await startServer(settings.lmStudioUrl);
    // A fresh server answers before it has finished indexing, so wait until chat models show up.
    let models = null;
    for (let i = 0; i < 40; i++) {
      models = await listLlms(settings.lmStudioUrl).catch(() => null);
      if (models?.length) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!models) throw store.httpError(502, 'LM Studio said it started, but its server is not answering yet. Try again in a few seconds.');
    return sendJson(res, 200, { ok: true, models });
  }
  if (p === '/api/generate' && m === 'POST') return generate(req, res);
  if ((match = p.match(/^\/api\/runs\/([\w-]+)\/cancel$/)) && m === 'POST') {
    runs.get(match[1])?.abort();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/videos' && m === 'POST') {
    // The raw file as the body (it can be big, so it isn't JSON), its type in Content-Type.
    if (Number(req.headers['content-length']) > store.MAX_VIDEO) throw store.httpError(413, `That video is too big (over ${store.MAX_VIDEO / 1024 / 1024} MB). Trim it to the part you need.`);
    return sendJson(res, 200, { file: await store.saveVideo(req, req.headers['content-type']) });
  }
  // What's in a motion video (when ffmpeg is installed), and a preview the browser can play when it can't play the file.
  if ((match = p.match(/^\/api\/videos\/([\w.]+)\/prepare$/)) && m === 'POST') {
    const file = store.videoPath(match[1]);
    if (!file || !store.VIDEO_NAME.test(match[1])) throw store.httpError(404, 'That video isn\'t stored.');
    const body = await readBody(req);
    const ffmpeg = await videotools.hasFfmpeg();
    const info = await videotools.probe(file);
    let preview = null;
    if (body.preview && ffmpeg) preview = path.basename(await videotools.preview(file).catch(err => { console.warn(`Couldn't make a preview of ${match[1]}: ${err.message}`); return ''; })) || null;
    const bars = info ? await videotools.bars(file, info).catch(() => null) : null;
    return sendJson(res, 200, { ffmpeg, info: info && bars ? { ...info, bars } : info, preview });
  }
  // A copy without the black bars around the picture (they'd be part of the moves, and set the video's shape).
  if ((match = p.match(/^\/api\/videos\/([\w.]+)\/crop$/)) && m === 'POST') {
    const file = store.videoPath(match[1]);
    if (!file || !store.VIDEO_NAME.test(match[1])) throw store.httpError(404, 'That video isn\'t stored.');
    if (!(await videotools.hasFfmpeg())) throw store.httpError(400, 'Making a copy needs ffmpeg, which isn\'t installed on this computer.');
    const box = await videotools.bars(file, await videotools.probe(file));
    if (!box) throw store.httpError(400, 'This video has no black bars to crop.');
    const tmp = await videotools.crop(file, box);
    try {
      const name = await store.saveVideo(createReadStream(tmp), 'video/mp4');
      return sendJson(res, 200, { file: name, info: await videotools.probe(store.videoPath(name)) });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  // A part of a long video (from start, this many seconds): the one stretch you want animated.
  if ((match = p.match(/^\/api\/videos\/([\w.]+)\/trim$/)) && m === 'POST') {
    const file = store.videoPath(match[1]);
    if (!file || !store.VIDEO_NAME.test(match[1])) throw store.httpError(404, 'That video isn\'t stored.');
    if (!(await videotools.hasFfmpeg())) throw store.httpError(400, 'Making a copy needs ffmpeg, which isn\'t installed on this computer.');
    const body = await readBody(req);
    const length = (await videotools.probe(file))?.seconds || 0;
    const start = Math.max(0, Number(body.start) || 0);
    const seconds = Math.min(Number(body.seconds) || 0, length ? length - start : Infinity);
    if (!(seconds >= 0.2) || (length && start >= length)) throw store.httpError(400, `Pick a part inside the video${length ? ` (it's ${Math.round(length * 10) / 10} s long)` : ''}.`);
    const tmp = await videotools.trim(file, Math.round(start * 1000) / 1000, Math.round(seconds * 1000) / 1000);
    try {
      const name = await store.saveVideo(createReadStream(tmp), 'video/mp4');
      return sendJson(res, 200, { file: name, info: await videotools.probe(store.videoPath(name)) });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  // A copy at a lower frame rate (Wan Animate 2 uses every frame: 120 fps takes 5× as long as 24).
  if ((match = p.match(/^\/api\/videos\/([\w.]+)\/retime$/)) && m === 'POST') {
    const file = store.videoPath(match[1]);
    if (!file || !store.VIDEO_NAME.test(match[1])) throw store.httpError(404, 'That video isn\'t stored.');
    if (!(await videotools.hasFfmpeg())) throw store.httpError(400, 'Making a copy needs ffmpeg, which isn\'t installed on this computer.');
    const fps = Math.min(60, Math.max(8, Math.round(Number((await readBody(req)).fps) || 24)));
    const tmp = await videotools.retime(file, fps);
    try {
      const name = await store.saveVideo(createReadStream(tmp), 'video/mp4');
      return sendJson(res, 200, { file: name, info: await videotools.probe(store.videoPath(name)) });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  if ((match = p.match(/^\/api\/videos\/([\w.]+)$/)) && m === 'GET') {
    const file = store.videoPath(match[1]);
    return sendJson(res, 200, { exists: Boolean(file) && (await fs.access(file).then(() => true, () => false)) });
  }
  if (p === '/api/images' && m === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { file: await store.saveImage(body.image) });
  }
  if ((match = p.match(/^\/api\/images\/([\w.]+)$/)) && m === 'GET') {
    const exists = await store.readImageDataUrl(match[1]).then(() => true, () => false);
    return sendJson(res, 200, { exists });
  }
  if ((match = p.match(/^\/api\/images\/([\w.]+)$/)) && m === 'DELETE') return sendJson(res, 200, { removed: await store.deleteImageIfUnused(match[1]) });
  if (p === '/api/refine' && m === 'POST') return refine(req, res);

  // The assistant's jobs: a folder's pictures to work through, and each job's plan and log.
  if (p === '/api/folder' && m === 'GET') return sendJson(res, 200, await folders.listFolder(url.searchParams.get('path')));
  if (p === '/api/folder/video' && m === 'GET') return serveFile(req, res, await folders.imagePath(url.searchParams.get('path'), { folder: url.searchParams.get('folder'), name: url.searchParams.get('name'), video: true }), PRIVATE);
  if (p === '/api/folder/image' && m === 'GET') return serveFile(req, res, await folders.imagePath(url.searchParams.get('path'), { folder: url.searchParams.get('folder'), name: url.searchParams.get('name') }), PRIVATE);
  if (p === '/api/jobs' && m === 'GET') return sendJson(res, 200, await store.listJobs());
  if ((match = p.match(/^\/api\/jobs\/([\w-]+)$/)) && m === 'PUT') {
    const body = await readBody(req);
    return sendJson(res, 200, await store.saveJob({ ...body, id: match[1] }));
  }
  if ((match = p.match(/^\/api\/jobs\/([\w-]+)$/)) && m === 'DELETE') {
    await store.deleteJob(match[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/history' && m === 'GET') return sendJson(res, 200, await store.withPresentFiles(await store.listHistory()));
  if ((match = p.match(/^\/api\/history\/([\w-]+)$/))) {
    const id = match[1];
    if (m === 'GET') {
      const entry = await store.getHistory(id);
      return entry ? sendJson(res, 200, await store.withPresentFiles(entry)) : sendJson(res, 404, { error: 'Not found' });
    }
    if (m === 'PATCH') {
      const body = await readBody(req);
      const entry = await store.updateHistory(id, e => {
        if (typeof body.favorite === 'boolean') e.favorite = body.favorite;
        if (typeof body.text === 'string' && e.variations[body.index]) {
          const v = e.variations[body.index];
          const text = body.text.trim();
          if (text && text !== v.versions.at(-1).text) v.versions.push({ text, instruction: '(manual edit)', createdAt: new Date().toISOString() });
        }
      });
      return sendJson(res, 200, await store.withPresentFiles(entry));
    }
    if (m === 'DELETE') return sendJson(res, 200, await deleteTake(id));
  }

  // ---- ComfyUI (optional renders) ----
  if (p === '/api/comfy/status' && m === 'GET') {
    const settings = await store.getSettings();
    const base = url.searchParams.get('url') || settings.comfyUrl;
    try {
      return sendJson(res, 200, { ...(await comfy.status(base)), url: base });
    } catch (err) {
      return sendJson(res, 200, { ok: false, url: base, error: err.message });
    }
  }
  if (p === '/api/assistant' && m === 'POST') return assistantChat(req, res);
  if (p === '/api/assistant/guide' && m === 'GET') return sendJson(res, 200, await assistant.searchGuide(url.searchParams.get('q')));
  if (p === '/api/assistant/chat' && m === 'GET') return sendJson(res, 200, await store.getAssistantChat());
  if (p === '/api/assistant/chat' && m === 'PUT') {
    await store.saveAssistantChat((await readBody(req)).messages);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/comfy/output-dir' && m === 'GET') {
    const settings = await store.getSettings();
    return sendJson(res, 200, { detected: await comfy.detectOutputDir(settings.comfyUrl).catch(() => null), configured: settings.comfyOutputDir });
  }
  if (p === '/api/comfy/loras' && m === 'GET') {
    const settings = await store.getSettings();
    try {
      return sendJson(res, 200, { loras: await comfy.loraList(settings.comfyUrl) });
    } catch (err) {
      return sendJson(res, 200, { loras: [], error: err.message });
    }
  }
  if (p === '/api/comfy/workflows' && m === 'GET') {
    const settings = await store.getSettings();
    return sendJson(res, 200, await comfy.savedWorkflows(settings.comfyUrl));
  }
  if (p === '/api/workflows' && m === 'GET') return sendJson(res, 200, await wf.listWorkflows());
  if (p === '/api/workflows/prepare' && m === 'POST') return sendJson(res, 200, await prepareWorkflow(await readBody(req)));
  if (p === '/api/workflows' && m === 'POST') {
    const body = await readBody(req);
    if (!(await store.getModel(body.modelId || ''))) throw store.httpError(400, 'Save the model first.');
    return sendJson(res, 200, wf.summary(await wf.saveWorkflow(body)));
  }
  // What model files the workflow needs that ComfyUI doesn't have (step ⑤ offers to download them).
  if ((match = p.match(/^\/api\/workflows\/([\w-]+)\/models$/)) && m === 'GET') {
    const existing = await wf.getWorkflow(match[1]);
    if (!existing) return sendJson(res, 404, { error: 'Workflow not found' });
    const settings = await store.getSettings();
    const { missing, fixes, checked } = await workflowModels(existing, settings.comfyUrl, { fresh: url.searchParams.has('fresh') });
    return sendJson(res, 200, { checked, missing, fixes: fixes.length });
  }
  if (p === '/api/comfy/downloads' && m === 'GET') return sendJson(res, 200, models.listDownloads());
  if (p === '/api/comfy/downloads' && m === 'POST') {
    const settings = await store.getSettings();
    const body = await readBody(req);
    return sendJson(res, 200, await models.startDownload(await comfy.modelFolders(settings.comfyUrl), { name: body.name, folder: body.folder, url: body.url }));
  }
  if ((match = p.match(/^\/api\/comfy\/downloads\/([\w-]+)\/cancel$/)) && m === 'POST') return sendJson(res, 200, { ok: models.cancelDownload(match[1]) });
  if ((match = p.match(/^\/api\/workflows\/([\w-]+)\/refresh$/)) && m === 'POST') {
    const existing = await wf.getWorkflow(match[1]);
    if (!existing) return sendJson(res, 404, { error: 'Workflow not found' });
    return sendJson(res, 200, await refreshWorkflow(existing, await readBody(req)));
  }
  if ((match = p.match(/^\/api\/workflows\/([\w-]+)$/))) {
    const existing = await wf.getWorkflow(match[1]);
    if (!existing) return sendJson(res, 404, { error: 'Workflow not found' });
    if (m === 'GET') {
      const settings = await store.getSettings();
      const info = await comfy.objectInfo(settings.comfyUrl).catch(() => null);
      const { candidates, warnings, producesVideo } = wf.analyze(existing.prompt, info);
      return sendJson(res, 200, { ...existing, candidates, warnings, producesVideo });
    }
    if (m === 'PUT') {
      const body = await readBody(req);
      // overridePatch changes single sampler values ({ "node|input": value, or null to drop it }) and keeps the rest.
      // seedPatch: { mode, value } for the seed mode and the next seed, keeping the other options.
      const sp = body.seedPatch && typeof body.seedPatch === 'object' ? body.seedPatch : null;
      const options = sp ? { ...existing.options, ...(sp.mode ? { seedMode: sp.mode } : {}), ...(sp.value != null ? { seed: sp.value } : {}) } : body.options;
      const overrides = body.overridePatch && typeof body.overridePatch === 'object'
        ? Object.fromEntries(Object.entries({ ...existing.overrides, ...body.overridePatch }).filter(([, v]) => v !== null))
        : body.overrides;
      return sendJson(res, 200, wf.summary(await wf.saveWorkflow({ name: body.name, mapping: body.mapping, options, overrides, loras: body.loras }, existing)));
    }
    if (m === 'DELETE') {
      await wf.deleteWorkflow(match[1]);
      return sendJson(res, 200, { ok: true });
    }
  }
  if (p === '/api/render' && m === 'POST') return renderTake(req, res);
  if (p === '/api/renders' && m === 'GET') {
    return sendJson(res, 200, [...renderJobs.values()].filter(j => !j.done).map(j => ({
      runId: j.runId, historyId: j.historyId, index: j.index, versionIndex: j.versionIndex, count: j.count,
      workflowId: j.workflowId, workflowName: j.workflowName, theme: j.theme, modelName: j.modelName, modelId: j.modelId,
      aspectRatio: j.aspectRatio, startedAt: j.startedAt, ...j.now,
      ...(url.searchParams.has('previews') ? { preview: j.previews.get(j.now.i)?.src || null } : {}),
    })));
  }
  if ((match = p.match(/^\/api\/renders\/([\w-]+)\/watch$/)) && m === 'GET') {
    const job = renderJobs.get(match[1]);
    return job ? watchRenderJob(job, res) : sendJson(res, 404, { error: 'That render has finished.' });
  }
  if ((match = p.match(/^\/api\/history\/([\w-]+)\/renders\/([\w-]+)$/)) && m === 'PATCH') {
    const body = await readBody(req);
    return sendJson(res, 200, await store.withPresentFiles(await store.updateHistory(match[1], e => {
      const r = e.variations.flatMap(v => v.renders || []).find(x => x.id === match[2]);
      if (!r) throw store.httpError(404, 'Render not found.');
      // How good it is: 1 pretty good, 2 very good, 3 excellent, 0 not rated. (Renders saved before ratings
      // have favorite: true, which counts as excellent until they're rated.)
      const rating = typeof body.rating === 'number' ? body.rating : typeof body.favorite === 'boolean' ? (body.favorite ? 3 : 0) : null;
      if (rating != null) {
        if (![0, 1, 2, 3].includes(rating)) throw store.httpError(400, 'A rating is 0 (none), 1, 2 or 3.');
        if (rating) r.rating = rating; else delete r.rating;
        delete r.favorite;
      }
    })));
  }
  if ((match = p.match(/^\/api\/history\/([\w-]+)\/renders\/([\w-]+)$/)) && m === 'DELETE') {
    return sendJson(res, 200, await store.withPresentFiles(await deleteOneRender(match[1], match[2])));
  }
  if (p.startsWith('/renders/') && m === 'GET') {
    const file = within(store.RENDERS_DIR, decodeURIComponent(p.slice('/renders/'.length)));
    return file ? serveFile(req, res, file, PRIVATE) : sendJson(res, 404, { error: 'Not found' });
  }

  if (p.startsWith('/videos/') && m === 'GET') {
    const file = store.videoPath(decodeURIComponent(p.slice('/videos/'.length)));
    return file ? serveFile(req, res, file, PRIVATE) : sendJson(res, 404, { error: 'Not found' });
  }
  if (p.startsWith('/images/') && m === 'GET') {
    const file = within(store.IMAGES_DIR, decodeURIComponent(p.slice('/images/'.length)));
    return file ? serveFile(req, res, file, PRIVATE) : sendJson(res, 404, { error: 'Not found' });
  }

  if (m === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = within(PUBLIC_DIR, rel);
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
    return file ? serveFile(req, res, file, headers) : sendJson(res, 404, { error: 'Not found' });
  }

  sendJson(res, 404, { error: 'Not found' });
}

const moved = await store.init();
if (moved.length) console.log(`Moved your data out of the app folder into ${store.DATA_DIR}: ${moved.join(', ')}`);
const swept = await store.sweepOrphans().catch(err => (console.warn(`Couldn't tidy the data folder: ${err.message}`), 0));
if (swept) console.log(`Removed ${swept} file${swept === 1 ? '' : 's'} no History entry uses anymore.`);
await wf.initWorkflows();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error', ...(err.missingModels ? { missing: err.missingModels } : {}) });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Prompt Maker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  // "Start ComfyUI too" (Settings → Services): bring it up along with Prompt Maker, unless it's already running.
  const settings = await store.getSettings().catch(() => null);
  if (settings?.comfyAutostart && !(await comfyUp(settings))) {
    services.startComfy(settings).then(() => console.log('Starting ComfyUI…'), err => console.warn(`Couldn't start ComfyUI: ${err.message}`));
  }
});
