// The model files a workflow loads (checkpoints, diffusion models, LoRAs, VAEs, CLIP vision…): which ones ComfyUI
// has, which ones it has under another folder (fixed on the way), and which are missing, with where to get them.
// Missing ones can be downloaded into ComfyUI's models folder, from the links the workflow itself carries (ComfyUI's
// templates and most shared workflows list each model's download link), only when you click Download.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DATA_DIR, httpError } from './store.js';

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

// What a model file does, in plain words, from the folder it goes in (the ⬇ Model files screen).
export function roleOf(folder) {
  return { checkpoints: 'The model', diffusion_models: 'The model', unet: 'The model', vae: 'VAE (makes the pixels)', text_encoders: 'Text encoder (reads the prompt)', clip: 'Text encoder (reads the prompt)', clip_vision: 'Vision encoder (looks at the picture)', loras: 'LoRA (a tune-up)', upscale_models: 'Upscaler', latent_upscale_models: 'Upscaler', controlnet: 'ControlNet', audio_encoders: 'Audio encoder' }[folder] || 'Model file';
}

/**
 * Every model file a prompt loads, present or not: [{ name, file, folder, url, download, role, have, at, nodes }].
 * have: true when ComfyUI offers it (under that name or another folder: at says which), false when it doesn't, null
 * when it can't be told (no /object_info, or a node ComfyUI doesn't know). Links (from the workflow) give the folder and the URL.
 */
export function workflowFiles(prompt, objectInfo, links = []) {
  const out = new Map();
  for (const [id, node] of Object.entries(prompt || {})) {
    for (const [input, value] of Object.entries(node?.inputs || {})) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value)) continue;
      const options = objectInfo ? comboOptions(objectInfo, node.class_type, input) : null;
      let have = null;
      let at = '';
      if (options) {
        const files = options.filter(o => typeof o === 'string');
        at = files.find(o => slashes(o) === slashes(value)) || files.filter(o => baseName(o) === baseName(value)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || '';
        have = Boolean(at);
      }
      const file = baseName(value);
      const link = links.find(l => baseName(l.name) === file);
      const folder = link?.directory || folderFor(node.class_type, input);
      if (!out.has(file)) out.set(file, { name: link?.name || value, file, folder, url: link?.url || null, download: Boolean(link && downloadable(link.url)), role: roleOf(folder), have, at, nodes: [] });
      else if (out.get(file).have === null && have !== null) Object.assign(out.get(file), { have, at });
      out.get(file).nodes.push(`#${id} ${node._meta?.title || node.class_type}`);
    }
  }
  return [...out.values()];
}

// The node types a prompt uses that ComfyUI doesn't offer: [{ type, nodes: ['#22 Image Save'] }]. A node pack that
// didn't load when ComfyUI started looks exactly like one that isn't installed, so the caller adds which pack and
// why (see comfy.importFailures). Without /object_info nothing can be checked, and nothing is reported.
export function checkNodes(prompt, objectInfo) {
  if (!objectInfo || typeof objectInfo !== 'object') return [];
  const missing = new Map();
  for (const [id, node] of Object.entries(prompt || {})) {
    const type = node?.class_type;
    if (!type || objectInfo[type]) continue;
    if (!missing.has(type)) missing.set(type, { type, nodes: [] });
    missing.get(type).nodes.push(`#${id} ${node._meta?.title || type}`);
  }
  return [...missing.values()];
}

// Whether ComfyUI version a is older than b ("0.42.0" < "0.45.0"); false when either can't be read.
export function olderThan(a, b) {
  const parse = v => (/^\s*v?(\d+(?:\.\d+)*)/.exec(String(v || '')) || [])[1]?.split('.').map(Number);
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

// One paragraph for nodes ComfyUI lacks (each may carry pack and reason from the log, or needs: the ComfyUI version
// they came with, when the workflow says so and this ComfyUI is older, with have: this one's version).
export function describeMissingNodes(nodes) {
  const q = s => `“${s}”`;
  const one = nodes.length === 1;
  const names = nodes.map(n => `${q(n.type)} (${n.nodes.join(', ')})`).join(', ');
  const newer = nodes.find(n => n.needs);
  if (newer) return `This workflow needs a newer ComfyUI: version ${newer.needs} or later, and yours is ${newer.have}. ${one ? 'Its node' : 'Its nodes'} ${names} came with ComfyUI ${newer.needs}, so no node pack has ${one ? 'it' : 'them'}. Click ⬆ Update ComfyUI, then try again.`;
  const toAdd = [...new Map(nodes.filter(n => n.install).map(n => [n.install.name, n.install])).values()];
  if (toAdd.length && toAdd.length === new Set(nodes.map(n => n.install?.name)).size) {
    const packs = toAdd.map(p => p.name).join(' and ');
    return `This workflow needs the ${packs} node pack${toAdd.length > 1 ? 's' : ''}, which ${toAdd.length > 1 ? "aren't" : "isn't"} in your ComfyUI yet (${names}). Click ⬇ Install ${toAdd[0].name}, then try again. (Its home: ${toAdd.map(p => p.repo).join(', ')}.)`;
  }
  const failed = nodes.filter(n => n.pack);
  let why;
  if (failed.length) {
    const packs = [...new Set(failed.map(n => n.pack))];
    why = packs.map(pack => `${pack} didn't load when ComfyUI started: ${failed.find(n => n.pack === pack).reason || 'see its log'}`).join('; ');
    why = `${failed.length === nodes.length ? (one ? 'Its node pack' : `${packs.length === 1 ? 'Their node pack' : 'Their node packs'}`) : 'A node pack'} ${why}. Fix the pack in ComfyUI (Manager → Try fix, or install what it says is missing), then restart ComfyUI.`;
  } else {
    why = `Install the node pack that has ${one ? 'it' : 'them'} (ComfyUI Manager → Install Missing Custom Nodes), or update ComfyUI if ${one ? "it's one of ComfyUI's own nodes" : "they're ComfyUI's own nodes"} (new models often bring theirs with a new ComfyUI). Restart ComfyUI, then try again.`;
  }
  return `This workflow uses ${one ? 'a node' : `${nodes.length} nodes`} your ComfyUI doesn't have right now: ${names}. ${why}`;
}

export function applyFixes(prompt, fixes) {
  for (const f of fixes) if (prompt[f.node]) prompt[f.node].inputs[f.input] = f.to;
}

// What's missing, in plain words: the kinds of files (the model, its text encoder…) and where to get them. With
// files, each file's name and folder too (the workflow dialog, where whoever adds a workflow wants to know).
export function describeMissing(missing, { files = false } = {}) {
  const one = missing.length === 1;
  const kind = f => ({ checkpoints: 'the model', diffusion_models: 'the model', unet: 'the model', vae: 'its VAE', text_encoders: 'its text encoder', clip: 'its text encoder', clip_vision: 'a vision encoder', loras: 'a LoRA', upscale_models: 'an upscaler', latent_upscale_models: 'an upscaler', controlnet: 'a ControlNet', audio_encoders: 'an audio encoder' }[f] || 'a model file');
  const kinds = [...new Set(missing.map(m => kind(m.folder)))];
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds[0];
  const named = files ? `: ${missing.map(m => `${m.file}${m.folder ? ` (models/${m.folder})` : ''}`).join(', ')}` : ` (${list})`;
  const how = missing.every(m => m.download) ? `Get ${one ? 'it' : 'them'} with ⬇ Model files: one click${one ? '' : ' each'}, straight into ComfyUI.`
    : missing.some(m => m.download) ? `⬇ Model files gets ${one ? 'it' : 'most of them'} in one click; the rest come from where the workflow came from.`
      : `Get ${one ? 'it' : 'them'} where the workflow came from and put ${one ? 'it' : 'them'} in ComfyUI's models folder.`;
  return `This workflow needs ${one ? 'a file' : `${missing.length} files`} that ${one ? 'isn\'t' : 'aren\'t'} in ComfyUI yet${named}. ${how} Or pick another workflow in Fine-tune → Rendering.`;
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

// ---------- your Hugging Face account ----------
// Some repos (FLUX 3 Klein's, for one) hand their files only to a signed-in account that clicked Agree on the
// model's page. ⬇ Model files takes a token (Read) once; it's kept in huggingface.json in the data folder,
// readable by you only, sent to huggingface.co alone (never to the file store it redirects to) and never back to
// the page. PM_HF_API points the account check somewhere else (the test suite).
const HF_API = () => (process.env.PM_HF_API || 'https://huggingface.co').replace(/\/+$/, '');
const HF_FILE = () => path.join(DATA_DIR, 'huggingface.json');
let hfCache = null; // { token, user } | false (none)
async function hfRead() {
  if (hfCache === null) {
    const saved = await fs.readFile(HF_FILE(), 'utf8').then(JSON.parse).catch(() => null);
    hfCache = saved?.token ? { token: String(saved.token), user: String(saved.user || '') } : false;
  }
  return hfCache || null;
}
// What the page may see: whether an account is connected, and its name; never the token.
export async function hfStatus() {
  const hf = await hfRead();
  return { connected: Boolean(hf), user: hf?.user || '' };
}
// Checks the token with Hugging Face (who it belongs to), then keeps it.
export async function hfConnect(token) {
  token = String(token || '').trim();
  if (!token) throw httpError(400, 'Paste your Hugging Face token.');
  if (!/^[\w-]{8,}$/.test(token)) throw httpError(400, "That doesn't look like a Hugging Face token (they start with hf_). Copy it again from huggingface.co/settings/tokens.");
  let res;
  try {
    res = await fetch(`${HF_API()}/api/whoami-v2`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw httpError(502, `Couldn't reach Hugging Face: ${err.cause?.message || err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw httpError(400, "Hugging Face didn't accept that token. Copy it again from huggingface.co/settings/tokens (a Read token is enough).");
  if (!res.ok) throw httpError(502, `Hugging Face answered ${res.status} to the account check. Try again in a moment.`);
  const who = await res.json().catch(() => ({}));
  const user = String(who.name || who.fullname || '').slice(0, 80);
  // A fine-grained token opens gated models only with "Read access to contents of all public gated repos you can
  // access" ticked (repo.content.read among its global permissions); a plain Read token always does.
  const grant = who.auth?.accessToken || {};
  if (grant.role === 'fineGrained' && !(grant.fineGrained?.global || []).includes('repo.content.read')) throw httpError(400, "That token is fine-grained and can't open gated models like FLUX 3 Klein. Make one of the Read type instead (huggingface.co/settings/tokens → Create new token → Read), or edit this one and tick \"Read access to contents of all public gated repos you can access\".");
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(HF_FILE(), JSON.stringify({ token, user }, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(HF_FILE(), 0o600).catch(() => {});
  hfCache = { token, user };
  sizes.clear(); // the files that said "needs a login" are asked again
  return hfStatus();
}
export async function hfForget() {
  await fs.rm(HF_FILE(), { force: true });
  hfCache = false;
  sizes.clear();
  return hfStatus();
}
// Hugging Face itself (huggingface.co, hf.co: the names in ALLOWED_HOSTS, exactly), not the file store it redirects to.
const hfHost = url => { try { return ALLOWED_HOSTS.includes(new URL(url).hostname.toLowerCase()); } catch { return false; } };
// fetch that follows redirects itself, so the token goes to Hugging Face's own hosts only: the file store it
// redirects to gets the signed link and the other headers (Range), nothing else.
async function hfFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const hf = await hfRead();
  let at = url;
  for (let hop = 0; ; hop++) {
    const auth = hf && hfHost(at) ? { Authorization: `Bearer ${hf.token}` } : {};
    const res = await fetch(at, { method, headers: { ...headers, ...auth }, body, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < 5) {
      await res.body?.cancel().catch(() => {});
      at = new URL(res.headers.get('location'), at).href;
      continue;
    }
    return res;
  }
}
// Why Hugging Face said no: 'login' (no account connected, or a token it no longer takes) or 'terms' (the account
// hasn't clicked Agree on the model's page yet).
const hfWhy = async status => (status === 403 && (await hfRead()) ? 'terms' : 'login');
export const repoPage = url => { try { const u = new URL(url); return hfHost(url) && /\/resolve\//.test(u.pathname) ? `${u.origin}${u.pathname.split('/resolve/')[0]}` : ''; } catch { return ''; } };

// How big a file is before it's fetched, asked of Hugging Face with HEAD requests (its redirect to the file's
// store names the size: X-Linked-Size; a renamed repo redirects once more first), only for the ⬇ Model files
// screen, kept for the session; fresh (↻ Check again) asks again about the files it refused or couldn't size, so a
// click on Agree since then shows. { size: bytes | null, gated: false | 'login' | 'terms' (see hfWhy) }.
const sizes = new Map(); // url → { size, gated }
export async function fileSizes(urls, { concurrency = 4, fresh = false } = {}) {
  if (fresh) for (const u of urls) { const s = sizes.get(u); if (s && (s.gated || s.size === null)) sizes.delete(u); }
  const todo = [...new Set(urls.filter(u => downloadable(u) && !sizes.has(u)))];
  const one = async url => {
    let found = { size: null, gated: false };
    try {
      const hf = await hfRead();
      let at = url;
      for (let hop = 0; hop < 5; hop++) {
        const auth = hf && hfHost(at) ? { Authorization: `Bearer ${hf.token}` } : {};
        const res = await fetch(at, { method: 'HEAD', headers: auth, redirect: 'manual', signal: AbortSignal.timeout(8000) });
        const linked = Number(res.headers.get('x-linked-size') || 0);
        if (linked > 0) { found = { size: linked, gated: false }; break; }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { at = new URL(res.headers.get('location'), at).href; continue; }
        if (res.ok) found = { size: Number(res.headers.get('content-length') || 0) || null, gated: false };
        else if (res.status === 401 || res.status === 403) found = { size: null, gated: await hfWhy(res.status) };
        break;
      }
    } catch { /* unknown */ }
    sizes.set(url, found);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => { while (todo.length) await one(todo.shift()); }));
  return Object.fromEntries(urls.map(u => [u, sizes.get(u) ?? { size: null, gated: false }]));
}

const downloads = new Map(); // dest path → job

// What the page sees of a job: not the parts that only run it.
const strip = ({ controller, via, part, replace, keep, ...d }) => d;

export function listDownloads() {
  return [...downloads.values()].map(strip);
}

export function cancelDownload(id) {
  const job = [...downloads.values()].find(d => d.id === id);
  job?.controller?.abort();
  return Boolean(job);
}

// Where a download comes from: how to ask for it (fetch), and what a refusal means in plain words (refused: a
// message, or null when the answer is the file). Hugging Face's here; Civitai's in lib/loras.js, which may also
// check the file before it gets its name (verify) and note what it is once it has it (done).
const HF_VIA = {
  fetch: (url, opts) => hfFetch(url, opts),
  async refused(res, job) {
    if (res.status !== 401 && res.status !== 403) return null;
    const why = await hfWhy(res.status);
    return why === 'terms' ? `This model asks you to accept its terms first: open ${repoPage(job.url) || 'its page on Hugging Face'}, click Agree, then get it again.`
      : (await hfRead()) ? 'Hugging Face no longer accepts your token. Connect your account again in ⬇ Model files.' : 'This file is behind a free Hugging Face account. Connect yours in ⬇ Model files, then get it again.';
  },
  // A newer version that takes the place of yours is checked first: it's the file Hugging Face lists, whole.
  async verify(part, job) {
    if (!job.sha256) return;
    if ((await sha256Of(part)) !== job.sha256) {
      await fs.rm(part, { force: true });
      throw new Error("The file didn't arrive whole (it isn't the one Hugging Face lists). Yours is untouched; get it again.");
    }
  },
  async done(dest, job) {
    if (!job.sha256) return;
    const st = await fs.stat(dest).catch(() => null);
    if (!st) return;
    (await readNotes())[dest] = { size: st.size, mtime: Math.round(st.mtimeMs), sha256: job.sha256 };
    await saveNotes();
  },
};

/**
 * Starts downloading a model into ComfyUI's folder for it. folders is ComfyUI's /internal/folder_paths (on this
 * computer). Returns the job: { id, file, folder, url, total, received, state: 'running' | 'done' | 'error', error }.
 */
export async function startDownload(folders, { name, folder, url, replace = '' }) {
  let link;
  try {
    link = new URL(String(url || ''));
  } catch {
    throw httpError(400, 'That model has no download link.');
  }
  if (!downloadable(url)) throw httpError(400, `Prompt Maker only downloads models from Hugging Face, not ${link.hostname}. Download it yourself and put it in ComfyUI's models/${folder} folder.`);
  const dir = Array.isArray(folders?.[folder]) ? folders[folder].find(d => typeof d === 'string') : null;
  if (!/^[\w-]+$/.test(folder || '') || !dir) throw httpError(400, `ComfyUI has no models folder called "${folder}". Is the workflow made for another ComfyUI?`);
  if (!replace) return beginDownload({ dir, name, folder, url: link.href, via: HF_VIA });
  // A newer version of a file that's here (see fileUpdates): it takes the file's name once it has all arrived, so
  // every workflow loads it; 'keep' leaves yours next to it, under a name that says since when.
  const local = await localOf(folders, { folder, at: name });
  if (!local) throw httpError(404, `${baseName(name || '')} isn't in ComfyUI's ${folder} folder any more.`);
  await remoteFiles([link.href], { fresh: true });
  const remote = remotes.get(link.href)?.info;
  const disk = await fs.statfs(local.dir).catch(() => null);
  if (disk && remote?.size && disk.bavail * disk.bsize < remote.size) throw httpError(400, `There isn't room on the disk for the new file: it needs ${(remote.size / 2 ** 30).toFixed(1)} GB free while yours is still there, and ${(disk.bavail * disk.bsize / 2 ** 30).toFixed(1)} GB is free.`);
  let keep = '';
  if (replace === 'keep') {
    const ext = path.extname(local.full);
    const stem = `${local.full.slice(0, -ext.length)} (before ${new Date().toISOString().slice(0, 10)})`;
    keep = `${stem}${ext}`;
    for (let i = 2; await fs.stat(keep).catch(() => null); i++) keep = `${stem} ${i}${ext}`;
  }
  return beginDownload({ dir: local.dir, name: local.rel, folder, url: link.href, via: HF_VIA, replace: true, part: `${local.full}.new.part`, keep, extra: { update: replace === 'keep' ? 'keep' : 'replace', sha256: remote?.sha256 || '' } });
}

/**
 * Starts a download into dir (one of ComfyUI's model folders), as name ("sub/file.safetensors"). via says where it
 * comes from (see HF_VIA). replace: the file is there already and this one takes its place, once it has all arrived.
 * part: where it's kept until then (default: next to it, ".part"). keep: where the file it replaces goes instead of
 * away. extra: more for the page to know about the job.
 */
export async function beginDownload({ dir, name, folder, url, via, replace = false, part = '', keep = '', extra = {} }) {
  const rel = slashes(name || '').replace(/^\/+/, '');
  if (!MODEL_FILE.test(rel) || rel.split('/').some(p => !/^[\w.+ ()-]+$/.test(p) || p === '..' || p === '.')) throw httpError(400, 'That model\'s file name isn\'t one Prompt Maker can save.');
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw httpError(400, `ComfyUI's ${folder} folder (${dir}) isn't on this computer, so Prompt Maker can't put the model there.`);
  const dest = path.resolve(dir, rel);
  if (!dest.startsWith(path.resolve(dir) + path.sep)) throw httpError(400, 'That model\'s file name isn\'t one Prompt Maker can save.');
  const running = downloads.get(dest);
  if (running?.state === 'running') return strip(running);
  const job = { id: crypto.createHash('sha1').update(dest).digest('hex').slice(0, 12), file: baseName(rel), name: rel, folder, url, total: 0, received: 0, state: 'running', error: '', startedAt: Date.now(), ...extra, controller: new AbortController(), via, replace, keep, part: part || `${dest}.part` };
  downloads.set(dest, job);
  if (!replace && (await fs.stat(dest).catch(() => null))?.size > 0) {
    Object.assign(job, { state: 'done', total: 1, received: 1 });
    return strip(job);
  }
  fetchTo(job, dest).then(
    () => Object.assign(job, { state: 'done' }),
    async err => {
      const cancelled = job.controller.signal.aborted;
      if (cancelled) await fs.rm(job.part, { force: true }); // a cancelled one starts over next time
      Object.assign(job, { state: 'error', error: cancelled ? 'Cancelled' : err.message });
    },
  );
  return strip(job);
}

async function fetchTo(job, dest) {
  const { part, via } = job;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const finish = async () => {
    await via.verify?.(part, job);
    if (job.keep) await fs.rename(dest, job.keep);
    await fs.rename(part, dest);
    await via.done?.(dest, job);
  };
  const have = (await fs.stat(part).catch(() => null))?.size || 0; // a download cut short goes on from there
  const res = await via.fetch(job.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: job.controller.signal });
  // Nothing left to fetch: all of it is here already (the download ended just before the file got its name).
  if (have && res.status === 416) {
    job.received = job.total = have;
    return finish();
  }
  const no = await via.refused(res, job);
  if (no) {
    await res.body?.cancel().catch(() => {});
    throw new Error(no);
  }
  if (!res.ok) throw new Error(`The download failed (${res.status} ${res.statusText}).`);
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
  await finish();
}

// ---------- newer versions of the files you have ----------
// A model's maker sometimes puts a better file under the same name on Hugging Face. ⬇ Model files asks Hugging Face
// about the files that are here (one question per repo: each file's size, fingerprint and when it last changed;
// nothing is downloaded, and nothing of yours is sent but the files' names in that repo). A file is newer there when
// it changed after yours arrived and isn't the same file: another size, or another fingerprint (SHA-256). Yours is
// read for that only when it has to be (same size, changed since), once: model-files.json in the data folder keeps
// the fingerprint, and the versions you said "not now" to.
const NOTES_FILE = () => path.join(DATA_DIR, 'model-files.json');
let notes = null; // { [the file's full path]: { size, mtime, sha256, skip } }
async function readNotes() {
  if (!notes) {
    const saved = await fs.readFile(NOTES_FILE(), 'utf8').then(JSON.parse).catch(() => null);
    notes = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  return notes;
}
async function saveNotes() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(NOTES_FILE(), JSON.stringify(notes, null, 2) + '\n');
}
async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
// A Hugging Face link's repo and file ("…/org/repo/resolve/main/sub/file.safetensors"); null for a link to one fixed
// commit (that file never changes) or one that isn't a repo's file.
function repoFile(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (!downloadable(url) || !m || /^[0-9a-f]{40}$/i.test(m[2])) return null;
  try { return { api: `${u.origin}/api/models/${m[1]}/paths-info/${m[2]}`, path: decodeURIComponent(m[3]) }; } catch { return null; }
}
const remotes = new Map(); // url → { at, info: { size, sha256, date } | null (not in the repo any more) }
// Asks Hugging Face about each link's file, unless it answered in the last half hour (fresh: ask anyway).
// Returns whether some couldn't be asked.
async function remoteFiles(urls, { fresh = false } = {}) {
  const groups = new Map();
  for (const url of new Set(urls)) {
    const hit = remotes.get(url);
    const r = (!hit || fresh || Date.now() - hit.at > 30 * 60_000) && repoFile(url);
    if (r) groups.set(r.api, [...(groups.get(r.api) || []), { url, path: r.path }]);
  }
  let offline = false;
  await Promise.all([...groups].map(async ([api, list]) => {
    try {
      const res = await hfFetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: list.map(l => l.path), expand: true }), signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        offline = true;
        return;
      }
      const got = await res.json();
      for (const l of list) {
        const f = (Array.isArray(got) ? got : []).find(x => x?.path === l.path);
        const sha = String(f?.lfs?.oid || '').toLowerCase();
        remotes.set(l.url, { at: Date.now(), info: f ? { size: Number(f.lfs?.size || f.size || 0), sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : '', date: String(f.lastCommit?.date || '') } : null });
      }
    } catch {
      offline = true;
    }
  }));
  return offline;
}
// Where a file ComfyUI has is on this computer: f.at is the name ComfyUI lists it under, in one of the folder's dirs.
async function localOf(folders, f) {
  const rel = slashes(f.at || '').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..') || !/^[\w-]+$/.test(f.folder || '')) return null;
  for (const dir of [].concat(folders?.[f.folder] || [])) {
    const full = typeof dir === 'string' ? path.join(dir, rel) : '';
    const st = full ? await fs.stat(full).catch(() => null) : null;
    if (st?.isFile()) return { dir, rel, full, st };
  }
  return null;
}
// What marks one version of a file on Hugging Face (for "not now").
const versionOf = remote => remote.sha256 || remote.date || String(remote.size);

/**
 * Which of the files that are here have a newer version on Hugging Face. files: workflowFiles' (with at and url),
 * the ones ComfyUI has; folders: ComfyUI's model folders. identify: also read the files that can't be told without
 * (slow: a big file takes a minute, once). fresh: ask Hugging Face again.
 * Returns { files: { [file]: { update: { size, date } } | { skipped: true } | { unread: true } }, unread, offline }.
 */
export async function fileUpdates(files, folders, { identify = false, fresh = false } = {}) {
  const n = await readNotes();
  const list = files.filter(f => f.at && f.url && repoFile(f.url));
  const offline = await remoteFiles(list.map(f => f.url), { fresh });
  const out = {};
  let unread = 0;
  let changed = false;
  for (const f of list) {
    const remote = remotes.get(f.url)?.info;
    const local = remote?.size ? await localOf(folders, f) : null;
    if (!local) continue;
    const mtime = Math.round(local.st.mtimeMs);
    let note = n[local.full];
    // Another file under that name since: what was noted is about the old one.
    if (note && (note.size !== local.st.size || note.mtime !== mtime)) { delete n[local.full]; note = null; changed = true; }
    if (remote.date && new Date(remote.date).getTime() <= local.st.mtimeMs) continue; // yours arrived after it last changed
    let differs = remote.size !== local.st.size;
    if (!differs && remote.sha256) {
      if (!note?.sha256) {
        const sha = identify ? await sha256Of(local.full).catch(() => '') : '';
        if (!sha) { unread++; out[f.file] = { unread: true }; continue; }
        note = n[local.full] = { ...note, size: local.st.size, mtime, sha256: sha };
        changed = true;
      }
      differs = note.sha256 !== remote.sha256;
    }
    if (differs) out[f.file] = note?.skip === versionOf(remote) ? { skipped: true } : { update: { size: remote.size, date: remote.date, sha256: remote.sha256 } };
  }
  if (changed) await saveNotes();
  return { files: out, unread, offline };
}

// "Not now": that version isn't offered for this file again (a later one is). on false: offer it again.
export async function skipUpdate(f, folders, on = true) {
  const local = await localOf(folders, f);
  const remote = remotes.get(f.url)?.info;
  if (!local || !remote) throw httpError(404, `${f.file} isn't in ComfyUI any more, or Hugging Face hasn't been asked about it.`);
  const n = await readNotes();
  const mtime = Math.round(local.st.mtimeMs);
  const old = n[local.full]?.size === local.st.size && n[local.full]?.mtime === mtime ? n[local.full] : {};
  n[local.full] = { ...old, size: local.st.size, mtime, skip: on ? versionOf(remote) : undefined };
  await saveNotes();
  return { ok: true };
}
