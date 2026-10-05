// Client for a local ComfyUI server: status, saved workflows, image upload, queueing a prompt,
// live progress (WebSocket, with polling as a fallback) and downloading the results.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertLocalUrl } from './lmstudio.js';
import { httpError } from './store.js';

const NOT_RUNNING = base => `Can't reach ComfyUI at ${base}. Start it in Settings → Services (or as usual), then try again.`;

async function call(baseUrl, pathname, { method = 'GET', json, body, headers, timeout = 15000, signal, raw = false } = {}) {
  const base = assertLocalUrl(baseUrl);
  let res;
  try {
    res = await fetch(new URL(pathname, base), {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw httpError(502, NOT_RUNNING(base));
  }
  if (raw) {
    if (!res.ok) throw httpError(502, `ComfyUI returned ${res.status} for ${pathname}`);
    return res;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw Object.assign(httpError(res.status === 400 ? 400 : 502, describeError(data) || `ComfyUI error ${res.status}`), { comfy: data });
  return data;
}

// ComfyUI validation errors → one readable paragraph.
export function describeError(data) {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data.slice(0, 300) : '';
  const parts = [];
  if (data.error?.message) parts.push(data.error.message + (data.error.details ? `: ${data.error.details}` : ''));
  for (const [id, e] of Object.entries(data.node_errors || {})) {
    for (const err of e.errors || []) {
      // "Value not in list: ckpt_name: 'x' not in [every file it has]" → just the file it lacks.
      const details = String(err.details || '').replace(/ not in \[[\s\S]*\]$/, ' isn\'t in ComfyUI').replace(/ not in \(list of length \d+\)$/, ' isn\'t in ComfyUI');
      parts.push(`#${id} ${e.class_type}: ${err.message}${details ? ` (${details})` : ''}`);
    }
  }
  return parts.join(' · ').slice(0, 800);
}

export async function status(baseUrl) {
  const stats = await call(baseUrl, '/system_stats', { timeout: 4000 });
  const dev = stats?.devices?.[0];
  return {
    ok: true,
    version: stats?.system?.comfyui_version || '',
    gpu: (dev?.name || '').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, ''),
    vramTotal: dev?.vram_total || 0,
    vramFree: dev?.vram_free || 0,
  };
}

const objectInfoCache = new Map();
export async function objectInfo(baseUrl, { fresh = false } = {}) {
  const hit = objectInfoCache.get(baseUrl);
  if (hit && !fresh && Date.now() - hit.at < 5 * 60_000) return hit.data;
  const data = await call(baseUrl, '/object_info', { timeout: 60000 });
  objectInfoCache.set(baseUrl, { at: Date.now(), data });
  return data;
}

// Workflows saved in ComfyUI's own library (user/default/workflows).
export async function savedWorkflows(baseUrl) {
  const list = await call(baseUrl, '/api/userdata?dir=workflows&recurse=true&split=false&full_info=true');
  return (Array.isArray(list) ? list : [])
    .map(f => (typeof f === 'string' ? { path: f } : f))
    .filter(f => f.path?.endsWith('.json') && !f.path.split('/').pop().startsWith('.'))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

// Every LoRA ComfyUI can load, as paths relative to its loras folder (e.g. "krea2/film_grain.safetensors").
export async function loraList(baseUrl) {
  let list = await call(baseUrl, '/models/loras').catch(() => null);
  if (!Array.isArray(list)) {
    const info = await objectInfo(baseUrl);
    list = info?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] || info?.LoraLoader?.input?.required?.lora_name?.[0] || [];
  }
  return list.filter(x => typeof x === 'string').map(x => x.replace(/\\/g, '/')).sort((a, b) => a.localeCompare(b));
}

export async function readSavedWorkflow(baseUrl, filePath) {
  if (!filePath || filePath.includes('..')) throw httpError(400, 'Invalid workflow path.');
  return call(baseUrl, `/api/userdata/${encodeURIComponent(`workflows/${filePath}`)}`);
}

// Puts a file in ComfyUI's input folder. Load Video takes its files from there too (ComfyUI's editor uploads them
// the same way), so motion videos use this as well.
export async function uploadImage(baseUrl, buffer, name, mime) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime }), name);
  form.append('overwrite', 'true');
  form.append('type', 'input');
  const data = await call(baseUrl, '/upload/image', { method: 'POST', body: form, timeout: Math.max(60000, buffer.length / 1e4) });
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// One of ComfyUI's own workflow templates (the Templates panel), as your ComfyUI has it installed.
export async function readTemplate(baseUrl, name) {
  if (!/^[\w.-]{1,120}$/.test(name || '')) throw httpError(400, 'Invalid template name.');
  try {
    return await call(baseUrl, `/templates/${encodeURIComponent(name)}.json`, { timeout: 30000 });
  } catch (err) {
    if (err.status === 502 && /error 404/.test(err.message)) throw httpError(404, `Your ComfyUI doesn't have the "${name}" template yet. Update ComfyUI (its templates come with it), then try again.`);
    throw err;
  }
}

export async function queuePrompt(baseUrl, prompt, clientId) {
  const data = await call(baseUrl, '/prompt', { method: 'POST', json: { prompt, client_id: clientId }, timeout: 60000 });
  if (!data?.prompt_id) throw httpError(502, describeError(data) || 'ComfyUI did not accept the workflow.');
  // ComfyUI runs what it can and quietly skips outputs that fail its checks (a missing model, say): the render would
  // come back without its result. So any skipped output stops it, with ComfyUI's reasons.
  if (data.node_errors && Object.keys(data.node_errors).length) {
    await cancel(baseUrl, data.prompt_id);
    throw Object.assign(httpError(400, `ComfyUI would skip part of this workflow, so it wasn't rendered: ${describeError({ node_errors: data.node_errors })}`), { comfy: data });
  }
  return data.prompt_id;
}

export async function history(baseUrl, promptId) {
  const data = await call(baseUrl, `/history/${encodeURIComponent(promptId)}`);
  return data?.[promptId] || null;
}

export async function queuePosition(baseUrl, promptId) {
  const q = await call(baseUrl, '/queue');
  if ((q?.queue_running || []).some(item => item[1] === promptId)) return 0;
  const pending = (q?.queue_pending || []).slice().sort((a, b) => a[0] - b[0]);
  const i = pending.findIndex(item => item[1] === promptId);
  return i < 0 ? -1 : i + 1 + (q?.queue_running?.length ? 1 : 0);
}

export async function cancel(baseUrl, promptId) {
  await call(baseUrl, '/queue', { method: 'POST', json: { delete: [promptId] } }).catch(() => {});
  await call(baseUrl, '/interrupt', { method: 'POST', json: { prompt_id: promptId } }).catch(() => {});
}

export async function download(baseUrl, ref) {
  const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || '', type: ref.type || 'output' });
  const res = await call(baseUrl, `/view?${q}`, { raw: true, timeout: 300000 });
  return Buffer.from(await res.arrayBuffer());
}

const ON_THIS_COMPUTER = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/i;

// ComfyUI doesn't report its output folder. It sits next to custom_nodes unless ComfyUI was started with
// --output-directory (then set it in Settings). Only for a ComfyUI on this computer.
async function outputDir(baseUrl) {
  if (!ON_THIS_COMPUTER.test(baseUrl)) return null;
  const paths = await call(baseUrl, '/internal/folder_paths', { timeout: 4000 }).catch(() => null);
  const nodes = paths?.custom_nodes?.[0];
  const dir = nodes && path.join(path.dirname(nodes), 'output');
  return dir && (await fs.stat(dir).catch(() => null))?.isDirectory() ? dir : null;
}

// ComfyUI's model folders ({ checkpoints: [dir, …], loras: […], … }), only for a ComfyUI on this computer.
export async function modelFolders(baseUrl) {
  const base = assertLocalUrl(baseUrl).replace(/\/+$/, '');
  if (!ON_THIS_COMPUTER.test(base)) throw httpError(400, 'ComfyUI runs on another computer, so Prompt Maker can\'t put models in its folders.');
  return call(base, '/internal/folder_paths', { timeout: 5000 });
}

export async function detectOutputDir(baseUrl) {
  return outputDir(assertLocalUrl(baseUrl).replace(/\/+$/, ''));
}

// Deletes a render's original from ComfyUI's output folder once Prompt Maker has its own copy: only saved
// outputs (not previews), only inside that folder, and only if it's the very file copied (same size).
export async function removeOutput(baseUrl, ref, size, configuredDir = '') {
  if (ref.type !== 'output') return false;
  const dir = path.resolve(configuredDir || (await outputDir(baseUrl)) || '');
  if (!configuredDir && dir === path.resolve('')) return false;
  const file = path.resolve(dir, ref.subfolder || '', ref.filename);
  if (!file.startsWith(dir + path.sep)) return false;
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile() || st.size !== size) return false;
  await fs.rm(file);
  if (ref.subfolder) await fs.rmdir(path.dirname(file)).catch(() => {}); // a date folder left empty
  return true;
}

// ---------- forgetting a deleted take ----------
// Besides the copies Prompt Maker keeps, ComfyUI holds on to its own: the job in its history (with the prompt in
// it), the files the job saved, and the image Prompt Maker uploaded for it.

const isDir = async d => Boolean(d) && Boolean((await fs.stat(d).catch(() => null))?.isDirectory());

// ComfyUI's output, input and temp folders on this computer: from the running server, else from where it's installed
// (roots). A configured output folder wins. Folders that can't be found are left out.
export async function folders(baseUrl, { output = '', roots = [] } = {}) {
  const all = [];
  if (ON_THIS_COMPUTER.test(baseUrl)) {
    const paths = await call(baseUrl, '/internal/folder_paths', { timeout: 4000 }).catch(() => null);
    if (paths?.custom_nodes?.[0]) all.push(path.dirname(paths.custom_nodes[0]));
  }
  all.push(...roots.filter(Boolean));
  const found = {};
  if (await isDir(output)) found.output = path.resolve(output);
  for (const root of all) {
    for (const kind of ['output', 'input', 'temp']) if (!found[kind] && (await isDir(path.join(root, kind)))) found[kind] = path.join(root, kind);
  }
  return found;
}

// Files a job saved (outputs) or was given by Prompt Maker (inputs it uploaded), as { type, subfolder, filename }.
function jobFiles(job) {
  const files = [];
  for (const out of Object.values(job?.outputs || {})) {
    for (const list of Object.values(out || {})) {
      for (const f of [].concat(list)) if (f?.filename && ['output', 'temp'].includes(f.type || 'output')) files.push({ type: f.type || 'output', subfolder: f.subfolder || '', filename: f.filename });
    }
  }
  for (const node of Object.values(job?.prompt?.[2] || {})) {
    for (const v of Object.values(node?.inputs || {})) if (typeof v === 'string' && v.startsWith('prompt-maker_')) files.push({ type: 'input', subfolder: '', filename: v });
  }
  return files;
}

// Finds ComfyUI's jobs for a deleted take, by id or by a prompt text Prompt Maker gave them (a text input equal to
// it), stops them if they're queued or running, removes them from its history, and returns their files.
export async function forgetJobs(baseUrl, { promptIds = [], texts = [] }) {
  const ids = new Set(promptIds.filter(Boolean));
  const wanted = new Set(texts.filter(Boolean));
  const ours = (id, graph) => ids.has(id) || Object.values(graph || {}).some(n => Object.values(n?.inputs || {}).some(v => typeof v === 'string' && wanted.has(v)));
  const files = [];
  const stopped = [];
  const queue = await call(baseUrl, '/queue', { timeout: 5000 });
  for (const item of [...(queue?.queue_running || []), ...(queue?.queue_pending || [])]) {
    if (!ours(item[1], item[2])) continue;
    await cancel(baseUrl, item[1]);
    files.push(...jobFiles({ prompt: item }));
    stopped.push(item[1]);
  }
  const history = (await call(baseUrl, '/history', { timeout: 30000 })) || {};
  // A job that was running only lands in the history once it has stopped.
  for (const id of stopped) {
    for (let i = 0; i < 15 && !history[id]; i++) {
      await new Promise(r => setTimeout(r, 200));
      Object.assign(history, await call(baseUrl, `/history/${encodeURIComponent(id)}`).catch(() => ({})));
    }
  }
  const gone = Object.entries(history).filter(([id, job]) => ours(id, job?.prompt?.[2]));
  for (const [, job] of gone) files.push(...jobFiles(job));
  if (gone.length) await call(baseUrl, '/history', { method: 'POST', json: { delete: gone.map(([id]) => id) } });
  return files;
}

async function* filesUnder(dir, depth = 0) {
  for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 4) yield* filesUnder(p, depth + 1);
    else if (d.isFile()) yield p;
  }
}

export const fingerprint = buf => ({ size: buf.length, sha1: crypto.createHash('sha1').update(buf).digest('hex') });

// Deletes from ComfyUI's folders (from folders()) the files its jobs named (refs), and every file in its output
// folder with the same content as one of Prompt Maker's copies ({ size, sha1 }), wherever ComfyUI saved it.
// Never anything outside those folders. Returns how many files went.
export async function removeFiles(dirs, refs = [], copies = []) {
  const doomed = new Map();
  for (const r of refs) {
    const dir = dirs[r.type];
    if (!dir) continue;
    const file = path.resolve(dir, r.subfolder || '', r.filename);
    if (file.startsWith(dir + path.sep)) doomed.set(file, dir);
  }
  if (dirs.output && copies.length) {
    const sizes = new Set(copies.map(c => c.size));
    const sums = new Set(copies.map(c => c.sha1));
    for await (const file of filesUnder(dirs.output)) {
      const st = await fs.stat(file).catch(() => null);
      if (!st || !sizes.has(st.size) || doomed.has(file)) continue;
      const buf = await fs.readFile(file).catch(() => null);
      if (buf && sums.has(fingerprint(buf).sha1)) doomed.set(file, dirs.output);
    }
  }
  let removed = 0;
  for (const [file, dir] of doomed) {
    if (!(await fs.rm(file).then(() => true, () => false))) continue;
    removed++;
    if (path.dirname(file) !== dir) await fs.rmdir(path.dirname(file)).catch(() => {}); // a date folder left empty
  }
  return removed;
}

const VIDEO = /\.(mp4|webm|mov|mkv|m4v)$/i;
const AUDIO = /\.(wav|mp3|flac|ogg|m4a|opus)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

// Output files from a finished prompt, preferring saved outputs over temporary previews.
export function outputFiles(entry) {
  const files = [];
  for (const [node, out] of Object.entries(entry?.outputs || {})) {
    for (const key of ['images', 'gifs', 'videos', 'video', 'audio', 'files']) {
      for (const f of [].concat(out?.[key] || [])) {
        if (!f?.filename) continue;
        const kind = VIDEO.test(f.filename) ? 'video' : AUDIO.test(f.filename) ? 'audio' : IMAGE.test(f.filename) ? 'image' : null;
        if (kind) files.push({ node, kind, filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
      }
    }
  }
  // A Load Video node shows its own input too: never a result.
  const made = files.filter(f => f.type !== 'input');
  const saved = made.filter(f => f.type === 'output');
  const unique = new Map((saved.length ? saved : made).map(f => [`${f.type}/${f.subfolder}/${f.filename}`, f]));
  return [...unique.values()];
}

// A node's title for the progress line. Nodes a loop runs again (Wan Animate 2 makes a long video in pieces) get ids
// like "672:642.0.0.1_672:587": node 672:587 in the loop's second piece. The loop's own bookkeeping isn't shown.
// pieces: how many the loop makes, when known.
export function nodeTitle(prompt, id, pieces = null) {
  const title = n => prompt[n]?._meta?.title || prompt[n]?.class_type || n;
  if (prompt[id]) return title(id);
  const piece = pieceOf(id);
  if (piece && prompt[piece.node]) return `${title(piece.node)} · piece ${piece.n}${pieces ? ` of ${Math.max(pieces, piece.n)}` : ''}`;
  return /\.(progress|iteration)_\d+$|\.result$/.test(id) ? null : id;
}
const pieceOf = id => { const m = /\.(\d+)_([^_]+)$/.exec(String(id || '')); return m ? { n: Number(m[1]) + 1, node: m[2] } : null; };

/**
 * Follows one queued prompt until it finishes. onEvent receives:
 *   { type: 'queued', position } · { type: 'running' } · { type: 'node', node, title }
 *   { type: 'progress', value, max, node, overall? } · { type: 'preview', mime, data }
 * pieces: for a workflow that loops over a video in pieces, how many; progress then also says how far the whole
 * render is (overall, 0–100), since each piece's sampler counts from zero again.
 * Resolves with ComfyUI's history entry; rejects with a readable error.
 */
export function watch(baseUrl, promptId, clientId, prompt, { signal, onEvent, pieces = null }) {
  let piece = 0;
  const base = assertLocalUrl(baseUrl);
  return new Promise((resolve, reject) => {
    let done = false;
    let ws = null;
    let poll = null;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      try { ws?.close(); } catch { /* already closed */ }
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => finish(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = async () => {
      const h = await history(base, promptId).catch(() => null);
      if (!h) return false;
      const st = h.status || {};
      if (st.status_str === 'error') {
        const err = (st.messages || []).find(m => m[0] === 'execution_error')?.[1];
        finish(httpError(502, err ? `ComfyUI failed at #${err.node_id} ${err.node_type}: ${err.exception_message}`.trim() : 'ComfyUI reported an error while rendering.'));
      } else if (st.completed || h.outputs) {
        const interrupted = (st.messages || []).some(m => m[0] === 'execution_interrupted');
        if (interrupted) finish(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
        else finish(null, h);
      }
      return true;
    };

    // Polling: queue position while waiting, completion as a safety net if the socket drops.
    // ComfyUI that crashed (out of memory) or restarted has forgotten the prompt: it's in neither its queue nor its
    // history. A few polls like that in a row, or ComfyUI not answering for a minute, ends the wait instead of
    // leaving the render stuck on "Starting…" for good.
    let lastPos = null;
    let lost = 0;
    let unreachableSince = null;
    poll = setInterval(async () => {
      if (done) return;
      if (await settle()) return;
      const pos = await queuePosition(base, promptId).catch(() => null);
      if (done) return;
      if (pos === null) unreachableSince ??= Date.now(); else unreachableSince = null;
      lost = pos === -1 ? lost + 1 : 0;
      if (lost >= 4 || (unreachableSince && Date.now() - unreachableSince > 60000)) {
        return finish(httpError(502, 'ComfyUI stopped before this render finished. It may have run out of memory: close other big programs and try again.'));
      }
      if (pos !== null && pos !== lastPos) {
        lastPos = pos;
        onEvent?.(pos > 0 ? { type: 'queued', position: pos } : { type: 'running' });
      }
    }, 1500);

    if (typeof WebSocket !== 'function') return; // Node < 22: polling only
    ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
    ws.binaryType = 'arraybuffer';
    let ours = false;
    ws.addEventListener('message', ev => {
      if (done) return;
      if (typeof ev.data !== 'string') {
        if (!ours) return;
        const buf = Buffer.from(ev.data);
        const kind = buf.readUInt32BE(0);
        if (kind === 1) {
          const mime = buf.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg';
          onEvent?.({ type: 'preview', mime, data: buf.subarray(8) });
        } else if (kind === 4) {
          const len = buf.readUInt32BE(4);
          let meta = {};
          try { meta = JSON.parse(buf.subarray(8, 8 + len).toString()); } catch { /* ignore */ }
          if (!meta.prompt_id || meta.prompt_id === promptId) onEvent?.({ type: 'preview', mime: meta.image_type || 'image/jpeg', data: buf.subarray(8 + len) });
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const d = msg.data || {};
      if (d.prompt_id && d.prompt_id !== promptId) return;
      switch (msg.type) {
        case 'execution_start':
          ours = true;
          onEvent?.({ type: 'running' });
          break;
        case 'executing':
          if (d.node === null) settle();
          else if (d.node) {
            ours = true;
            piece = pieceOf(d.node)?.n || piece;
            const title = nodeTitle(prompt, d.node, pieces);
            if (title) onEvent?.({ type: 'node', node: d.node, title });
          }
          break;
        case 'progress': {
          const n = pieceOf(d.node)?.n || piece;
          const overall = pieces && n && d.max ? Math.min(100, ((Math.min(n, pieces) - 1 + d.value / d.max) / pieces) * 100) : null;
          onEvent?.({ type: 'progress', value: d.value, max: d.max, node: d.node, ...(overall != null ? { overall } : {}) });
          break;
        }
        case 'execution_success':
          settle();
          break;
        case 'execution_error':
          finish(httpError(502, `ComfyUI failed at #${d.node_id} ${d.node_type}: ${d.exception_message || 'unknown error'}`.trim()));
          break;
        case 'execution_interrupted':
          finish(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
          break;
        default:
      }
    });
    ws.addEventListener('error', () => { /* polling carries on */ });
  });
}

export const newClientId = () => crypto.randomUUID();
