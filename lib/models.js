// The model files a workflow loads (checkpoints, diffusion models, LoRAs, VAEs, CLIP vision…): which ones ComfyUI
// has, which ones it has under another folder (fixed on the way), and which are missing, with where to get them.
// Missing ones can be downloaded into ComfyUI's models folder, from the links the workflow itself carries (ComfyUI's
// templates and most shared workflows list each model's download link), only when you click Download.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpError } from './store.js';

export const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
const slashes = s => String(s).replace(/\\/g, '/');
const baseName = s => slashes(s).split('/').pop();

// A combo input's choices as /object_info lists them (old style [[...]] or COMBO with options).
function comboOptions(objectInfo, classType, input) {
  const spec = objectInfo?.[classType]?.input?.required?.[input] ?? objectInfo?.[classType]?.input?.optional?.[input];
  if (Array.isArray(spec?.[0])) return spec[0];
  if (spec?.[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

// Where a loader's file lives, for files the workflow has no link for (only to say where to put it).
function folderFor(classType, input) {
  if (input === 'ckpt_name') return 'checkpoints';
  if (input === 'unet_name') return 'diffusion_models';
  if (input === 'vae_name') return 'vae';
  if (input === 'lora_name') return 'loras';
  if (/^clip_name\d*$/.test(input)) return /vision/i.test(classType) ? 'clip_vision' : 'text_encoders';
  if (input === 'control_net_name') return 'controlnet';
  if (input === 'model_name' && /upscale/i.test(classType)) return 'upscale_models';
  return '';
}

// The download links a ComfyUI editor workflow carries: each node's properties.models ({ name, url, directory }),
// in subgraphs too, plus a top-level models list. One per file. (Which ones Prompt Maker may download is checked later.)
export function modelLinks(ui) {
  const out = new Map();
  const add = m => {
    if (!m || typeof m.name !== 'string' || typeof m.url !== 'string' || !/^https?:\/\//i.test(m.url) || !MODEL_FILE.test(m.name)) return;
    const key = baseName(m.name);
    if (!out.has(key)) out.set(key, { name: slashes(m.name).slice(0, 300), url: m.url.slice(0, 1000), directory: String(m.directory || '').replace(/[^\w-]/g, '').slice(0, 60) });
  };
  const walk = nodes => { for (const n of nodes || []) for (const m of [].concat(n?.properties?.models || [])) add(m); };
  walk(ui?.nodes);
  for (const sg of ui?.definitions?.subgraphs || []) walk(sg.nodes);
  for (const m of [].concat(ui?.models || [])) add(m);
  return [...out.values()];
}

export function sanitizeLinks(list) {
  return modelLinks({ models: Array.isArray(list) ? list.slice(0, 200) : [] });
}

/**
 * Checks every model file a prompt loads against what ComfyUI offers. Returns
 *   fixes:   [{ node, input, from, to }] files ComfyUI has under another folder (e.g. "wan-2.1/x.safetensors")
 *   missing: [{ name, file, folder, url, nodes }] files ComfyUI doesn't have at all, with a link when the workflow has one
 * Without /object_info nothing can be checked, and nothing is reported.
 */
export function checkModels(prompt, objectInfo, links = []) {
  const fixes = [];
  const missing = new Map();
  if (!objectInfo) return { fixes, missing: [] };
  for (const [id, node] of Object.entries(prompt || {})) {
    for (const [input, value] of Object.entries(node?.inputs || {})) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value)) continue;
      const options = comboOptions(objectInfo, node.class_type, input);
      if (!options || options.includes(value)) continue;
      const files = options.filter(o => typeof o === 'string');
      const same = files.filter(o => slashes(o) === slashes(value));
      const elsewhere = same.length ? same : files.filter(o => baseName(o) === baseName(value)).sort((a, b) => a.length - b.length || a.localeCompare(b));
      if (elsewhere.length) {
        fixes.push({ node: id, input, from: value, to: elsewhere[0] });
        continue;
      }
      const file = baseName(value);
      const link = links.find(l => baseName(l.name) === file);
      if (!missing.has(file)) missing.set(file, { name: link?.name || value, file, folder: link?.directory || folderFor(node.class_type, input), url: link?.url || null, download: Boolean(link && downloadable(link.url)), nodes: [] });
      missing.get(file).nodes.push(`#${id} ${node._meta?.title || node.class_type}`);
    }
  }
  return { fixes, missing: [...missing.values()] };
}

export function applyFixes(prompt, fixes) {
  for (const f of fixes) if (prompt[f.node]) prompt[f.node].inputs[f.input] = f.to;
}

export function describeMissing(missing) {
  const names = missing.map(m => `${m.file}${m.folder ? ` (models/${m.folder})` : ''}`);
  const one = missing.length === 1;
  return `Your ComfyUI doesn't have ${one ? 'a model' : `${missing.length} models`} this workflow needs: ${names.join(', ')}. ${missing.some(m => m.download) ? `Click ⬇ Download in step ⑤ to get ${one ? 'it' : 'them'}, or` : `Put ${one ? 'it' : 'them'} in that folder, or`} pick another workflow.`;
}

// ---------- downloads ----------
// One at a time per file, kept in memory (a restart forgets finished ones; a half-done file resumes where it stopped).

// Hugging Face only: where ComfyUI's templates and shared workflows link their models. (PM_MODEL_HOSTS replaces the
// list; a host on this computer may then be plain http, for tests.)
const ALLOWED_HOSTS = (process.env.PM_MODEL_HOSTS || 'huggingface.co,hf.co').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const hostAllowed = host => ALLOWED_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
export function downloadable(url) {
  let link;
  try { link = new URL(String(url || '')); } catch { return false; }
  const host = link.hostname.toLowerCase();
  const local = host === '127.0.0.1' || host === 'localhost';
  return (link.protocol === 'https:' || (link.protocol === 'http:' && local)) && hostAllowed(host);
}

const downloads = new Map(); // dest path → job

export function listDownloads() {
  return [...downloads.values()].map(({ controller, ...d }) => d);
}

export function cancelDownload(id) {
  const job = [...downloads.values()].find(d => d.id === id);
  job?.controller?.abort();
  return Boolean(job);
}

/**
 * Starts downloading a model into ComfyUI's folder for it. folders is ComfyUI's /internal/folder_paths (on this
 * computer). Returns the job: { id, file, folder, url, total, received, state: 'running' | 'done' | 'error', error }.
 */
export async function startDownload(folders, { name, folder, url }) {
  let link;
  try {
    link = new URL(String(url || ''));
  } catch {
    throw httpError(400, 'That model has no download link.');
  }
  if (!downloadable(url)) throw httpError(400, `Prompt Maker only downloads models from Hugging Face, not ${link.hostname}. Download it yourself and put it in ComfyUI's models/${folder} folder.`);
  const rel = slashes(name || '').replace(/^\/+/, '');
  if (!MODEL_FILE.test(rel) || rel.split('/').some(part => !/^[\w.+ ()-]+$/.test(part) || part === '..' || part === '.')) throw httpError(400, 'That model\'s file name isn\'t one Prompt Maker can save.');
  const dir = Array.isArray(folders?.[folder]) ? folders[folder].find(d => typeof d === 'string') : null;
  if (!/^[\w-]+$/.test(folder || '') || !dir) throw httpError(400, `ComfyUI has no models folder called "${folder}". Is the workflow made for another ComfyUI?`);
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw httpError(400, `ComfyUI's ${folder} folder (${dir}) isn't on this computer, so Prompt Maker can't put the model there.`);
  const dest = path.resolve(dir, rel);
  if (!dest.startsWith(path.resolve(dir) + path.sep)) throw httpError(400, 'That model\'s file name isn\'t one Prompt Maker can save.');
  const running = downloads.get(dest);
  if (running?.state === 'running') return strip(running);
  const job = { id: crypto.createHash('sha1').update(dest).digest('hex').slice(0, 12), file: baseName(rel), name: rel, folder, url: link.href, total: 0, received: 0, state: 'running', error: '', startedAt: Date.now(), controller: new AbortController() };
  downloads.set(dest, job);
  if ((await fs.stat(dest).catch(() => null))?.size > 0) {
    Object.assign(job, { state: 'done', total: 1, received: 1 });
    return strip(job);
  }
  fetchTo(job, dest).then(
    () => Object.assign(job, { state: 'done' }),
    async err => {
      const cancelled = job.controller.signal.aborted;
      if (cancelled) await fs.rm(`${dest}.part`, { force: true }); // a cancelled one starts over next time
      Object.assign(job, { state: 'error', error: cancelled ? 'Cancelled' : err.message });
    },
  );
  return strip(job);
}

const strip = ({ controller, ...d }) => d;

async function fetchTo(job, dest) {
  const part = `${dest}.part`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const have = (await fs.stat(part).catch(() => null))?.size || 0; // a download cut short goes on from there
  const res = await fetch(job.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: job.controller.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `Hugging Face says this model needs a login (${res.status}). Download it in the browser instead.` : `The download failed (${res.status} ${res.statusText}).`);
  const resumed = res.status === 206;
  job.received = resumed ? have : 0;
  job.total = Number(res.headers.get('content-length') || 0) + job.received;
  const out = await fs.open(part, resumed ? 'a' : 'w');
  try {
    for await (const chunk of res.body) {
      await out.write(chunk);
      job.received += chunk.length;
    }
  } finally {
    await out.close();
  }
  if (job.total && job.received !== job.total) throw new Error('The download stopped early. Click Download again to go on from where it stopped.');
  await fs.rename(part, dest);
}
