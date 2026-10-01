// Prompt Maker: local web server. Zero dependencies; serves the UI, talks to LM Studio (prompts)
// and, optionally, to a local ComfyUI (renders).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from './lib/store.js';
import { listLlms, streamCompletion, EMPTY_THINK, assertLocalUrl, startServer } from './lib/lmstudio.js';
import * as assistant from './lib/assistant.js';
import * as autostart from './lib/autostart.js';
import * as services from './lib/services.js';
import * as cloud from './lib/cloud.js';
import { brainRecords, looksRefused, countWords, wordRange, CHECK_THEMES, testImageDataUrl } from './lib/brains.js';
import { buildGenerateMessages, buildRefineMessages, buildDraftGuideMessages, cleanPrompt, masterFor, ADULT_CONTENT, DEFAULT_MASTER_PROMPT } from './lib/prompt.js';
import * as comfy from './lib/comfy.js';
import * as wf from './lib/workflows.js';
import { convertUiWorkflow, isApiWorkflow, isUiWorkflow, pruneToOutputs, ConvertError } from './lib/comfy-convert.js';

const PORT = Number(process.env.PORT) || 5317;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MAX_BODY = 30 * 1024 * 1024;

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
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'";

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

function pickParams(body, model) {
  const role = ['reference', 'recreate', 'animate'].includes(body.imageRole) ? body.imageRole : 'reference';
  return {
    theme: String(body.theme || '').trim(),
    imageRole: model.kind !== 'video' && role === 'animate' ? 'reference' : role,
    aspectRatio: String(body.aspectRatio || model.defaults.aspectRatio || ''),
    resolution: String(body.resolution || model.defaults.resolution || ''),
    duration: model.kind === 'video' ? String(body.duration || model.defaults.duration || '') : '',
    length: store.LENGTHS.includes(body.length) ? body.length : model.defaults.length,
  };
}

// ---------- generation ----------

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
  if (!params.theme && !imageDataUrl) throw store.httpError(400, 'Enter a theme, add an image, or both.');
  const source = imageDataUrl ? await resolveSource(body.source) : null;
  const chain = chainRef(body.chain);

  const llm = await prepareLlm(settings, body.llmModel, Boolean(imageDataUrl));
  const llmModel = llm.id;
  const count = Math.min(4, Math.max(1, Math.round(Number(body.variations) || 1)));
  const opts = sampling(settings, body.temperature ?? model.defaults.temperature, llm);

  const stream = startStream(res, llm, count, Boolean(imageDataUrl));
  const texts = [];
  try {
    for (let index = 0; index < count; index++) {
      const messages = buildGenerateMessages(masterFor(settings), model, { ...params, sourcePrompt: source?.text }, imageDataUrl, { index, count, previous: texts });
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
      ...(source ? { source } : {}),
      ...(chain ? { chain } : {}),
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
  const llm = await prepareLlm(settings, body.llmModel, Boolean(imageDataUrl));
  const llmModel = llm.id;
  const opts = sampling(settings, body.temperature ?? entry.temperature, llm);
  const params = pickParams(entry, model);

  const stream = startStream(res, llm, 1, Boolean(imageDataUrl));
  try {
    const messages = buildRefineMessages(masterFor(settings), model, { ...params, sourcePrompt: imageDataUrl ? entry.source?.text : '' }, imageDataUrl, current, instruction);
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
    stream.send({ type: 'saved', entry: saved });
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
  const llm = await prepareLlm(settings, body.llmModel, false);
  const messages = [{ role: 'system', content: assistant.systemPrompt(body.state) }, ...assistant.cleanMessages(body.messages)];
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
  const messages = buildGenerateMessages(masterFor(settings), model, params, null, { index: 0, count: 1, previous: [] });
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
  const analysis = wf.analyze(prompt, info);
  return {
    name: name || 'Workflow',
    source,
    sourceModified,
    prompt,
    mapping: preset?.mapping || analysis.mapping,
    options: preset?.options || analysis.options,
    candidates: analysis.candidates,
    warnings: analysis.warnings,
    producesVideo: analysis.producesVideo,
    nodes: Object.keys(prompt).length,
  };
}

// Pulls in a newer version of a workflow: from ComfyUI (if it came from there) or from a file you pick.
async function refreshWorkflow(existing, body) {
  const fromComfy = existing.source.startsWith('comfyui:');
  if (!body.json && !fromComfy) throw store.httpError(400, 'This workflow was uploaded from a file. Pick the new version of the file to update it.');
  const fresh = await prepareWorkflow(body.json ? { json: body.json, name: existing.name } : { comfyPath: existing.source.slice('comfyui:'.length) });
  const { mapping, overrides, loras, lost, changes } = wf.carryOver(existing, fresh.prompt, fresh.mapping);
  if (!mapping.prompt.length) throw store.httpError(400, 'The new version has no text input for the prompt, so it can\'t be used for rendering.');
  const saved = await wf.saveWorkflow({ prompt: fresh.prompt, mapping, overrides, loras, sourceModified: fresh.sourceModified, ...(body.json ? { source: 'upload' } : {}) }, existing);
  return { ...saved, candidates: fresh.candidates, warnings: fresh.warnings, producesVideo: fresh.producesVideo, lost, changes };
}

const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function renderTake(req, res) {
  const body = await readBody(req);
  const settings = await store.getSettings();
  const entry = await store.getHistory(body.historyId || '');
  if (!entry) throw store.httpError(404, 'That take is no longer in history.');
  const variation = entry.variations[body.index];
  if (!variation) throw store.httpError(400, 'Unknown take.');
  const versionIndex = variation.versions[body.versionIndex] ? body.versionIndex : variation.versions.length - 1;
  const text = variation.versions[versionIndex].text;
  const workflow = await wf.getWorkflow(body.workflowId || '');
  if (!workflow) throw store.httpError(400, 'Pick a workflow to render with.');
  if (workflow.mapping.image && !entry.imageFile) {
    throw store.httpError(400, `"${workflow.name}" needs an input image (it has a Load Image node), but this take has none. Add an image on the Create page, or pick a text-to-image/video workflow.`);
  }
  const base = settings.comfyUrl;
  await comfy.status(base);
  const info = await comfy.objectInfo(base).catch(() => null);
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
  const count = Math.min(4, Math.max(1, Math.round(Number(body.count) || 1)));
  const seeds = await wf.takeSeeds(workflow.id, count, { fresh: body.newSeed === true });
  const stream = openStream(res);
  stream.send({ type: 'start', runId: stream.runId, count, workflowName: workflow.name });
  const clientId = comfy.newClientId();
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    let promptId = null;
    const onAbort = () => { if (promptId) comfy.cancel(base, promptId); };
    try {
      const seed = seeds[i];
      const { prompt, applied } = wf.buildPrompt(workflow, {
        text,
        imageName,
        aspectRatio: entry.aspectRatio,
        resolution: entry.resolution,
        duration: entry.duration,
        seed,
      }, info);
      promptId = await comfy.queuePrompt(base, prompt, clientId);
      stream.signal.addEventListener('abort', onAbort, { once: true });
      stream.send({ type: 'queued', i, applied });
      let lastPreview = 0;
      const done = await comfy.watch(base, promptId, clientId, prompt, {
        signal: stream.signal,
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
      // ComfyUI reuses its numbers (ComfyUI_00001_.png) once files are gone, so copies get their own names.
      const named = [store.slugify(entry.modelName), store.slugify(entry.theme || 'from-image').slice(0, 40), applied.seed ?? null, id.slice(0, 6)].filter(x => x !== null && x !== '').join('_');
      for (const [n, out] of outputs.entries()) {
        const ext = (path.extname(out.filename).toLowerCase() || '.bin').replace(/[^.\w]/g, '');
        const file = `${id}_${n}${ext}`;
        const buf = await comfy.download(base, out);
        await fs.writeFile(path.join(store.RENDERS_DIR, file), buf);
        files.push({ file, kind: out.kind, name: `${named}${outputs.length > 1 ? `-${n + 1}` : ''}${ext}` });
        if (settings.comfyCleanup) {
          await comfy.removeOutput(base, out, buf.length, settings.comfyOutputDir).catch(err => console.warn(`Couldn't remove ${out.filename} from ComfyUI's output folder: ${err.message}`));
        }
      }
      const render = {
        id,
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
        files,
        createdAt: new Date().toISOString(),
        secs: Math.round((Date.now() - t0) / 100) / 10,
      };
      await store.updateHistory(entry.id, e => { (e.variations[body.index].renders ||= []).push(render); });
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
  const settingsView = s => ({ ...s, defaultMasterPrompt: DEFAULT_MASTER_PROMPT, adultSection: ADULT_CONTENT, dataDir: store.DATA_DIR });
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
  if (p === '/api/images' && m === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { file: await store.saveImage(body.image) });
  }
  if ((match = p.match(/^\/api\/images\/([\w.]+)$/)) && m === 'GET') {
    const exists = await store.readImageDataUrl(match[1]).then(() => true, () => false);
    return sendJson(res, 200, { exists });
  }
  if (p === '/api/refine' && m === 'POST') return refine(req, res);

  if (p === '/api/history' && m === 'GET') return sendJson(res, 200, await store.listHistory());
  if ((match = p.match(/^\/api\/history\/([\w-]+)$/))) {
    const id = match[1];
    if (m === 'GET') {
      const entry = await store.getHistory(id);
      return entry ? sendJson(res, 200, entry) : sendJson(res, 404, { error: 'Not found' });
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
      return sendJson(res, 200, entry);
    }
    if (m === 'DELETE') {
      await store.deleteHistory(id);
      return sendJson(res, 200, { ok: true });
    }
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
  if ((match = p.match(/^\/api\/history\/([\w-]+)\/renders\/([\w-]+)$/)) && m === 'DELETE') {
    return sendJson(res, 200, await store.deleteRender(match[1], match[2]));
  }
  if (p.startsWith('/renders/') && m === 'GET') {
    const file = within(store.RENDERS_DIR, decodeURIComponent(p.slice('/renders/'.length)));
    return file ? serveFile(req, res, file) : sendJson(res, 404, { error: 'Not found' });
  }

  if (p.startsWith('/images/') && m === 'GET') {
    const file = within(store.IMAGES_DIR, decodeURIComponent(p.slice('/images/'.length)));
    return file ? serveFile(req, res, file) : sendJson(res, 404, { error: 'Not found' });
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
await wf.initWorkflows();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error' });
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
