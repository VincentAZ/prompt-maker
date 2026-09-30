// Client for a local ComfyUI server: status, saved workflows, image upload, queueing a prompt,
// live progress (WebSocket, with polling as a fallback) and downloading the results.
import crypto from 'node:crypto';
import { assertLocalUrl } from './lmstudio.js';
import { httpError } from './store.js';

const NOT_RUNNING = base => `Can't reach ComfyUI at ${base}. Start ComfyUI (e.g. \`python main.py\` in its folder), then try again.`;

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
    for (const err of e.errors || []) parts.push(`#${id} ${e.class_type}: ${err.message}${err.details ? ` (${err.details})` : ''}`);
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

export async function readSavedWorkflow(baseUrl, filePath) {
  if (!filePath || filePath.includes('..')) throw httpError(400, 'Invalid workflow path.');
  return call(baseUrl, `/api/userdata/${encodeURIComponent(`workflows/${filePath}`)}`);
}

export async function uploadImage(baseUrl, buffer, name, mime) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime }), name);
  form.append('overwrite', 'true');
  form.append('type', 'input');
  const data = await call(baseUrl, '/upload/image', { method: 'POST', body: form, timeout: 60000 });
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function queuePrompt(baseUrl, prompt, clientId) {
  const data = await call(baseUrl, '/prompt', { method: 'POST', json: { prompt, client_id: clientId }, timeout: 60000 });
  if (!data?.prompt_id) throw httpError(502, describeError(data) || 'ComfyUI did not accept the workflow.');
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
  const saved = files.filter(f => f.type === 'output');
  const unique = new Map((saved.length ? saved : files).map(f => [`${f.type}/${f.subfolder}/${f.filename}`, f]));
  return [...unique.values()];
}

/**
 * Follows one queued prompt until it finishes. onEvent receives:
 *   { type: 'queued', position } · { type: 'running' } · { type: 'node', node, title }
 *   { type: 'progress', value, max, node } · { type: 'preview', mime, data }
 * Resolves with ComfyUI's history entry; rejects with a readable error.
 */
export function watch(baseUrl, promptId, clientId, prompt, { signal, onEvent }) {
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
    let lastPos = null;
    poll = setInterval(async () => {
      if (done) return;
      if (await settle()) return;
      const pos = await queuePosition(base, promptId).catch(() => null);
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
            onEvent?.({ type: 'node', node: d.node, title: prompt[d.node]?._meta?.title || prompt[d.node]?.class_type || d.node });
          }
          break;
        case 'progress':
          onEvent?.({ type: 'progress', value: d.value, max: d.max, node: d.node });
          break;
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
