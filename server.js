// Prompt Maker: local web server. Zero dependencies; serves the UI, talks to LM Studio (prompts)
// and, optionally, to a local ComfyUI (renders).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from './lib/store.js';
import { listLlms, streamChat, assertLocalUrl, startServer } from './lib/lmstudio.js';
import { buildGenerateMessages, buildRefineMessages, buildDraftGuideMessages, cleanPrompt, DEFAULT_MASTER_PROMPT } from './lib/prompt.js';
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

// Picks the LM Studio model to use and reports what we know about it: { id, name, vision, loaded }.
async function prepareLlm(settings, requested, needsVision) {
  const llms = await listLlms(settings.lmStudioUrl);
  const id = (requested || settings.llmModel || '').trim();
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
  return info;
}

// Opens the event stream and tells the UI which LLM is working and whether it still has to load.
function startStream(res, info, count, hasImage) {
  const stream = openStream(res);
  stream.send({ type: 'start', runId: stream.runId, count, llmModel: info.id, llmName: info.name });
  if (info.loaded === false) stream.send({ type: 'status', text: `Loading ${info.name} into memory…` });
  else if (hasImage) stream.send({ type: 'status', text: 'Studying your image…' });
  return stream;
}

function sampling(settings, temperature) {
  const t = Number(temperature);
  const opts = {
    temperature: Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.8,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
  };
  // Reasoning models think for thousands of tokens by default; prompt writing rarely needs it.
  if (settings.thinking !== 'default') opts.reasoning_effort = settings.thinking === 'off' ? 'none' : settings.thinking;
  return opts;
}

const EMPTY_HINT = 'The LLM returned an empty prompt. If it is a "thinking" model it may have used all its tokens reasoning. Raise Max tokens in Settings or pick a non-thinking model.';

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

  const llm = await prepareLlm(settings, body.llmModel, Boolean(imageDataUrl));
  const llmModel = llm.id;
  const count = Math.min(4, Math.max(1, Math.round(Number(body.variations) || 1)));
  const opts = sampling(settings, body.temperature ?? model.defaults.temperature);

  const stream = startStream(res, llm, count, Boolean(imageDataUrl));
  const texts = [];
  try {
    for (let index = 0; index < count; index++) {
      const messages = buildGenerateMessages(settings.masterPrompt, model, { ...params, sourcePrompt: source?.text }, imageDataUrl, { index, count, previous: texts });
      const raw = await streamChat(settings.lmStudioUrl, { model: llmModel, messages, ...opts }, {
        signal: stream.signal,
        onUpdate: u => stream.send({ type: 'delta', index, text: u.text, thinking: u.thinking, reasoningChars: u.reasoningChars }),
      });
      const text = cleanPrompt(raw);
      if (!text) throw store.httpError(502, EMPTY_HINT);
      texts.push(text);
      stream.send({ type: 'done', index, text });
    }
  } catch (err) {
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
  const opts = sampling(settings, body.temperature ?? entry.temperature);
  const params = pickParams(entry, model);

  const stream = startStream(res, llm, 1, Boolean(imageDataUrl));
  try {
    const messages = buildRefineMessages(settings.masterPrompt, model, { ...params, sourcePrompt: imageDataUrl ? entry.source?.text : '' }, imageDataUrl, current, instruction);
    const raw = await streamChat(settings.lmStudioUrl, { model: llmModel, messages, ...opts }, {
      signal: stream.signal,
      onUpdate: u => stream.send({ type: 'delta', index: body.index, text: u.text, thinking: u.thinking, reasoningChars: u.reasoningChars }),
    });
    const text = cleanPrompt(raw);
    if (!text) throw store.httpError(502, EMPTY_HINT);
    const now = new Date().toISOString();
    const saved = await store.updateHistory(entry.id, e => {
      const v = e.variations[body.index];
      if (current !== base.text) v.versions.push({ text: current, instruction: '(manual edit)', createdAt: now });
      v.versions.push({ text, instruction, createdAt: now });
    });
    stream.send({ type: 'done', index: body.index, text });
    stream.send({ type: 'saved', entry: saved });
  } catch (err) {
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
    const text = await streamChat(settings.lmStudioUrl, { model: llmModel, messages, ...sampling(settings, 0.3), max_tokens: Math.max(settings.maxTokens, 4096) }, {
      signal: stream.signal,
      onUpdate: u => stream.send({ type: 'delta', index: 0, text: u.text, thinking: u.thinking, reasoningChars: u.reasoningChars }),
    });
    if (!text) throw store.httpError(502, EMPTY_HINT);
    stream.send({ type: 'done', index: 0, text: text.replace(/^```(?:markdown|md)?\s*\n?|\n?```\s*$/g, '').trim() });
  } catch (err) {
    if (err.name !== 'AbortError') stream.send({ type: 'error', message: err.message });
  }
  stream.end();
}

// ---------- ComfyUI workflows & renders ----------

// Turns an uploaded or ComfyUI-saved workflow into an API prompt plus a suggested input mapping.
async function prepareWorkflow(body) {
  const settings = await store.getSettings();
  let json = body.json;
  let name = String(body.name || '').replace(/\.json$/i, '');
  let source = 'upload';
  if (body.comfyPath) {
    json = await comfy.readSavedWorkflow(settings.comfyUrl, body.comfyPath);
    name = body.comfyPath.split('/').pop().replace(/\.json$/i, '');
    source = `comfyui:${body.comfyPath}`;
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
    prompt,
    mapping: preset?.mapping || analysis.mapping,
    options: preset?.options || analysis.options,
    candidates: analysis.candidates,
    warnings: analysis.warnings,
    producesVideo: analysis.producesVideo,
    nodes: Object.keys(prompt).length,
  };
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
  const lockedSeed = Number.isSafeInteger(body.seed) ? body.seed : null;
  const stream = openStream(res);
  stream.send({ type: 'start', runId: stream.runId, count, workflowName: workflow.name });
  const clientId = comfy.newClientId();
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    let promptId = null;
    const onAbort = () => { if (promptId) comfy.cancel(base, promptId); };
    try {
      const seed = lockedSeed !== null ? lockedSeed + i : workflow.options.randomizeSeed ? wf.randomSeed() : null;
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
      for (const [n, out] of outputs.entries()) {
        const ext = (path.extname(out.filename).toLowerCase() || '.bin').replace(/[^.\w]/g, '');
        const file = `${id}_${n}${ext}`;
        await fs.writeFile(path.join(store.RENDERS_DIR, file), await comfy.download(base, out));
        files.push({ file, kind: out.kind, name: out.filename });
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
  const settingsView = s => ({ ...s, defaultMasterPrompt: DEFAULT_MASTER_PROMPT, dataDir: store.DATA_DIR });
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
      return sendJson(res, 200, { ok: true, url: base, models: await listLlms(base) });
    } catch (err) {
      return sendJson(res, 200, { ok: false, url: base, error: err.message, models: [] });
    }
  }

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
      return sendJson(res, 200, wf.summary(await wf.saveWorkflow({ name: body.name, mapping: body.mapping, options: body.options, overrides: body.overrides }, existing)));
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

server.listen(PORT, HOST, () => {
  console.log(`Prompt Maker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
