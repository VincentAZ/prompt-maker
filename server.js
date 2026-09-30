// Prompt Maker: local web server. Zero dependencies; serves the UI and talks to LM Studio.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from './lib/store.js';
import { listLlms, streamChat, assertLocalUrl } from './lib/lmstudio.js';
import { buildGenerateMessages, buildRefineMessages, buildDraftGuideMessages, cleanPrompt, DEFAULT_MASTER_PROMPT } from './lib/prompt.js';

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

async function serveFile(res, file, extraHeaders = {}) {
  try {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extraHeaders });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
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

  const llm = await prepareLlm(settings, body.llmModel, Boolean(imageDataUrl));
  const llmModel = llm.id;
  const count = Math.min(4, Math.max(1, Math.round(Number(body.variations) || 1)));
  const opts = sampling(settings, body.temperature ?? model.defaults.temperature);

  const stream = startStream(res, llm, count, Boolean(imageDataUrl));
  const texts = [];
  try {
    for (let index = 0; index < count; index++) {
      const messages = buildGenerateMessages(settings.masterPrompt, model, params, imageDataUrl, { index, count, previous: texts });
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
    const messages = buildRefineMessages(settings.masterPrompt, model, params, imageDataUrl, current, instruction);
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

// ---------- routing ----------

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const m = req.method;
  let match;

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
      return sendJson(res, 200, { ok: true });
    }
  }

  // Both responses carry the defaults the Settings page needs (e.g. for "Reset to default").
  const settingsView = s => ({ ...s, defaultMasterPrompt: DEFAULT_MASTER_PROMPT, dataDir: store.DATA_DIR });
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, settingsView(await store.getSettings()));
  if (p === '/api/settings' && m === 'PUT') {
    const body = await readBody(req);
    if (typeof body.lmStudioUrl === 'string') assertLocalUrl(body.lmStudioUrl.trim());
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

  if (p.startsWith('/images/') && m === 'GET') {
    const file = within(store.IMAGES_DIR, decodeURIComponent(p.slice('/images/'.length)));
    return file ? serveFile(res, file) : sendJson(res, 404, { error: 'Not found' });
  }

  if (m === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = within(PUBLIC_DIR, rel);
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
    return file ? serveFile(res, file, headers) : sendJson(res, 404, { error: 'Not found' });
  }

  sendJson(res, 404, { error: 'Not found' });
}

await store.init();

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
