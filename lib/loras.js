// More LoRAs for a model, from Civitai: the ones made for that model (Civitai says which model each LoRA is for),
// downloaded into the model's own folder in ComfyUI's loras folder, where ＋ Add LoRA finds them. Prompt Maker
// keeps a note of what each file is (loras.json in the data folder), so it can say when its maker has put out a
// newer version, and get it: in the old one's place, or next to it. PM_CIVITAI_API points all of it somewhere else
// (the test suite).
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, httpError } from './store.js';
import { beginDownload } from './models.js';

const API = () => (process.env.PM_CIVITAI_API || 'https://civitai.com').replace(/\/+$/, '');
const SITE = 'https://civitai.com';
const ADULT_SITE = 'https://civitai.red'; // where Civitai shows its adult models' pages (civitai.com only says so)
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slashes = s => String(s).replace(/\\/g, '/');
const folderOf = name => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');
const SAFE_PART = /^[\w.+ ()-]+$/;

// ---------- your Civitai account ----------
// Most LoRAs download without one; some makers ask for a signed-in account. One API key, pasted once, kept in
// civitai.json in the data folder, readable by you only, sent to civitai.com alone (never to the file store it
// redirects to) and never back to the page.
const KEY_FILE = () => path.join(DATA_DIR, 'civitai.json');
let keyCache = null; // { key, user } | false (none)
async function keyRead() {
  if (keyCache === null) {
    const saved = await fs.readFile(KEY_FILE(), 'utf8').then(JSON.parse).catch(() => null);
    keyCache = saved?.key ? { key: String(saved.key), user: String(saved.user || '') } : false;
  }
  return keyCache || null;
}
export async function status() {
  const k = await keyRead();
  return { connected: Boolean(k), user: k?.user || '' };
}
export async function connect(key) {
  key = String(key || '').trim();
  if (!key) throw httpError(400, 'Paste your Civitai API key.');
  if (!/^[\w-]{16,200}$/.test(key)) throw httpError(400, "That doesn't look like a Civitai API key (a long row of letters and numbers). Copy it again from your Civitai account settings.");
  let res;
  try {
    res = await fetch(`${API()}/api/v1/me`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw httpError(502, `Couldn't reach Civitai: ${err.cause?.message || err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw httpError(400, "Civitai didn't accept that key. Copy it again from your Civitai account settings (API Keys).");
  if (!res.ok) throw httpError(502, `Civitai answered ${res.status} to the account check. Try again in a moment.`);
  const who = await res.json().catch(() => ({}));
  const user = String(who.username || who.name || '').slice(0, 80);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KEY_FILE(), JSON.stringify({ key, user }, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(KEY_FILE(), 0o600).catch(() => {});
  keyCache = { key, user };
  return status();
}
export async function forget() {
  await fs.rm(KEY_FILE(), { force: true });
  keyCache = false;
  return status();
}

// Asks Civitai's API (no account: what everyone sees).
async function ask(pathname, { timeout = 20000 } = {}) {
  let res;
  try {
    res = await fetch(`${API()}${pathname}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw httpError(502, `Couldn't reach Civitai: ${err.name === 'TimeoutError' ? 'it took too long to answer' : err.cause?.message || err.message}. Check your internet connection, then try again.`);
  }
  if (res.status === 404) throw httpError(404, 'Civitai no longer has that one.');
  if (res.status === 429) throw httpError(502, 'Civitai is busy right now. Try again in a minute.');
  if (!res.ok) throw httpError(502, `Civitai answered ${res.status}. Try again in a moment.`);
  return res.json().catch(() => { throw httpError(502, "Civitai's answer couldn't be read. Try again in a moment."); });
}

// ---------- which LoRAs fit which model ----------
// Civitai files every LoRA under the model it was made for ("Krea 2", "LTXV 2.3"…). The models that come with the
// app know theirs, and the folder their LoRAs go in when there's none yet; your own models are matched by name,
// and Settings keeps your choice (loraBases) when that isn't right.
const FAMILIES = [
  { match: /krea2/, folder: 'krea2', bases: ['Krea 2', 'Krea 2 Turbo'] },
  { match: /zimage/, folder: 'z_image', bases: ['ZImageTurbo'] },
  { match: /qwen/, folder: 'qwen', bases: ['Qwen'] },
  { match: /ltx23/, folder: 'LTX_2.3', bases: ['LTXV 2.3'] },
  // Civitai files MiniMax H3's picture and video LoRAs under one name: they're told apart by their previews (mixed).
  { match: /minimaxh3|hailuo03/, folder: 'minimax_h3', bases: ['MiniMax H3'], mixed: true },
  { match: /flux3klein/, folder: 'flux3_klein', bases: ['Flux.3 Klein', 'Flux.3 Klein-base'] },
];
let basesCache = null; // { at, list }
// Every model Civitai files LoRAs under, for the "Made for" list (asked once a day; none when it can't be reached).
export async function allBases() {
  if (basesCache && Date.now() - basesCache.at < 24 * 3600_000) return basesCache.list;
  const enums = await ask('/api/v1/enums', { timeout: 10000 }).catch(() => null);
  const list = (enums?.ActiveBaseModel || enums?.BaseModel || []).filter(b => typeof b === 'string' && b.length <= 60 && !['Other', 'Upscaler'].includes(b));
  if (list.length) basesCache = { at: Date.now(), list };
  return list.length ? list : basesCache?.list || [...new Set(FAMILIES.flatMap(f => f.bases))];
}
// The family a model belongs to ("minimax_h3" for MiniMax H3 Image, Image Edit and the rest): its LoRA folder when
// it's one Prompt Maker knows, else its own id (a family of one).
export function familyOf(model) {
  const keys = [squash(model.id), squash(model.name)];
  return FAMILIES.find(f => keys.some(k => f.match.test(k)))?.folder || String(model.id || '');
}
/**
 * What Civitai calls a model, and where its LoRAs go: { bases: [names], folder, auto }. chosen: your own pick
 * (settings.loraBases[model.id]). auto: nobody chose, so this is Prompt Maker's match (possibly none: bases []).
 */
export function planFor(model, chosen, known = []) {
  const keys = [squash(model.id), squash(model.name)];
  const family = FAMILIES.find(f => keys.some(k => f.match.test(k)));
  const folder = family?.folder || String(model.id || 'loras').replace(/[^\w.-]/g, '_').slice(0, 60);
  const picked = (Array.isArray(chosen) ? chosen : []).filter(b => typeof b === 'string' && b).slice(0, 6);
  const kind = family?.mixed && ['image', 'video'].includes(model.kind) ? model.kind : ''; // only this kind's LoRAs
  if (picked.length) return { bases: picked, folder, auto: false, kind: picked.every(b => family?.bases.includes(b)) ? kind : '' };
  if (family) return { bases: family.bases, folder, auto: true, kind };
  const byName = known.filter(b => { const n = squash(b); return n.length >= 4 && keys.some(k => k === n || k.startsWith(n)); });
  return { bases: byName.slice(0, 3), folder, auto: true };
}

// ---------- what each LoRA file is ----------
// loras.json: { files: { "krea2/film.safetensors": { modelId, versionId, name, version, base, sha256, size,
// published, words, skip } }, unknown: { "krea2/mine.safetensors": { size, mtime } } }. files: the ones Civitai
// knows (downloaded here, or recognised by what's in them); unknown: looked up and not found, so it isn't asked again.
const NOTES_FILE = () => path.join(DATA_DIR, 'loras.json');
let notes = null;
let writing = Promise.resolve();
async function readNotes() {
  if (!notes) {
    const saved = await fs.readFile(NOTES_FILE(), 'utf8').then(JSON.parse).catch(() => null);
    notes = { files: saved?.files && typeof saved.files === 'object' ? saved.files : {}, unknown: saved?.unknown && typeof saved.unknown === 'object' ? saved.unknown : {} };
  }
  return notes;
}
function saveNotes() {
  writing = writing.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(`${NOTES_FILE()}.tmp`, JSON.stringify(notes, null, 2) + '\n');
    await fs.rename(`${NOTES_FILE()}.tmp`, NOTES_FILE());
  }).catch(() => {});
  return writing;
}

// The file of a version that Prompt Maker takes: a .safetensors (a format that can't carry a program), the one
// Civitai marks as the main one when there are several.
function fileOf(version) {
  const files = (version?.files || []).filter(f => /\.safetensors$/i.test(f?.name || '') && (!f.type || /model/i.test(f.type)));
  return files.find(f => f.primary) || files[0] || null;
}
const safeName = name => {
  const ext = /\.safetensors$/i.exec(name)?.[0] || '.safetensors';
  const stem = String(name).slice(0, -ext.length).normalize('NFKD').replace(/[^\w.+ ()-]+/g, '_').replace(/_+/g, '_').replace(/^[._ ]+|[._ ]+$/g, '').slice(0, 120);
  return `${stem || 'lora'}${ext.toLowerCase()}`;
};
const words = version => [...new Set((version?.trainedWords || []).flatMap(w => String(w).split(',')).map(w => w.trim()).filter(Boolean))].slice(0, 12).map(w => w.slice(0, 80));
const pageOf = (modelId, versionId, adult = false) => `${adult ? ADULT_SITE : SITE}/models/${modelId}${versionId ? `?modelVersionId=${versionId}` : ''}`;
function noteFrom(version, modelId, modelName, file, st) {
  return {
    modelId: Number(modelId), versionId: Number(version.id), name: String(modelName || '').slice(0, 200), version: String(version.name || '').slice(0, 80),
    base: String(version.baseModel || '').slice(0, 60), sha256: String(file?.hashes?.SHA256 || '').toUpperCase(), size: st?.size || 0,
    published: version.publishedAt || version.createdAt || '', words: words(version), adult: Boolean(version.model?.nsfw),
  };
}

// A preview as the page may load it: through Prompt Maker (the page loads nothing from elsewhere), small.
const proxied = (url, big = false) => `/api/loras/image?u=${encodeURIComponent(url)}${big ? '&big=1' : ''}`;
// kind: one of that kind first (a picture LoRA's card shows a picture it made, not a video's first frame).
const preview = (version, kind = '') => {
  const all = (version?.images || []).filter(i => typeof i?.url === 'string');
  const img = all.find(i => !kind || i.type === kind) || all[0];
  return img ? proxied(img.url) : '';
};
// What a maker wrote (Civitai keeps it as HTML), as plain text: paragraphs and list items on their own lines.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = (html, max = 6000) => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<li[^>]*>/gi, '• ').replace(/<br\s*\/?>|<\/(p|li|h\d|div|ul|ol|blockquote|pre)>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, e) => (e[0] === '#' ? (n => (n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ''))(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all))
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

const SORTS = { downloads: 'Most Downloaded', rated: 'Highest Rated', newest: 'Newest' };
// Whether a LoRA is for pictures or for video, from its version's name or its previews (a video model's LoRA shows videos): 'image',
// 'video', or '' (both, or no previews: it's shown for either).
// A version named for one of the video modes (FL2VA, REF2VA, I2V…) is video's, whatever its previews show.
const VIDEO_WORDS = /(^|[^a-z0-9])(fl2va?|ref2va?|[it]2v|v2v|video)([^a-z0-9]|$)/i;
const kindOf = version => {
  if (VIDEO_WORDS.test(version?.name || '')) return 'video';
  const types = (version?.images || []).map(i => i?.type);
  const video = types.includes('video');
  const image = types.includes('image');
  return video && !image ? 'video' : image && !video ? 'image' : '';
};
/**
 * LoRAs on Civitai made for these models. kind: only the ones for pictures ('image') or video ('video'), told by
 * their previews, for a base Civitai uses for both (several pages are asked then, as few are of one kind). list: the LoRAs ComfyUI has (to say which are here already), or null.
 * Returns { items: [{ id, name, creator, downloads, likes, adult, page, image, version: { id, name, base,
 * published, size, file, words, early }, have, older }], next }.
 */
export async function search({ bases, q = '', sort = 'downloads', cursor = '', adult = true, kind = '' }, list = null) {
  if (!bases?.length) return { items: [], next: '' };
  const p = new URLSearchParams();
  for (const t of ['LORA', 'LoCon', 'DoRA']) p.append('types', t);
  for (const b of bases) p.append('baseModels', b);
  p.set('limit', kind ? '100' : '24');
  p.set('nsfw', adult ? 'true' : 'false');
  p.set('sort', SORTS[sort] || SORTS.downloads);
  if (q.trim()) p.set('query', q.trim().slice(0, 100));
  const found = [];
  let next = String(cursor || '').slice(0, 200);
  for (let page = 0; page < (kind ? 4 : 1); page++) {
    if (next) p.set('cursor', next); else p.delete('cursor');
    const data = await ask(`/api/v1/models?${p}`);
    for (const m of data.items || []) {
      const versions = m.modelVersions || [];
      const v = versions.find(x => bases.includes(x.baseModel) && fileOf(x)) || versions.find(x => bases.includes(x.baseModel)) || versions[0];
      if (v && (!kind || kindOf(v) !== (kind === 'image' ? 'video' : 'image'))) found.push({ m, v });
    }
    next = String(data.metadata?.nextCursor || '');
    if (!next || found.length >= 12) break;
  }
  const { files } = await readNotes();
  const here = Object.entries(files).filter(([rel]) => !list || list.includes(rel));
  const items = found.filter(({ m }) => adult || !m.nsfw).map(({ m, v }) => {
    const f = fileOf(v);
    const mine = here.filter(([, n]) => n.modelId === m.id);
    return {
      id: m.id, name: String(m.name || '').slice(0, 200), creator: String(m.creator?.username || '').slice(0, 80), downloads: m.stats?.downloadCount || 0, likes: m.stats?.thumbsUpCount || 0,
      adult: Boolean(m.nsfw), page: pageOf(m.id, v.id, m.nsfw), image: preview(v, kind),
      version: { id: v.id, name: String(v.name || '').slice(0, 80), base: v.baseModel || '', published: v.publishedAt || '', size: f ? Math.round((f.sizeKB || 0) * 1024) : 0, file: f ? safeName(f.name) : '', words: words(v), early: v.availability === 'EarlyAccess', paid: Boolean(v.paidAccess) },
      have: mine.find(([, n]) => n.versionId === v.id)?.[0] || '',
      older: mine.find(([, n]) => n.versionId !== v.id)?.[0] || '',
    };
  });
  return { items, next };
}

// fetch that follows redirects itself, so the key goes to Civitai's own host only: the file store it redirects to
// gets the signed link and the other headers (Range), nothing else.
async function civitaiFetch(url, { headers = {}, signal } = {}) {
  const k = await keyRead();
  const home = new URL(API()).host;
  let at = url;
  for (let hop = 0; ; hop++) {
    const auth = k && new URL(at).host === home ? { Authorization: `Bearer ${k.key}` } : {};
    const res = await fetch(at, { headers: { ...headers, ...auth }, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < 5) {
      await res.body?.cancel().catch(() => {});
      at = new URL(res.headers.get('location'), at).href;
      continue;
    }
    return res;
  }
}
async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
}
const VIA = {
  fetch: civitaiFetch,
  // Civitai answers a file it won't hand out with 401/403, or sends you to its sign-in page (a web page, not a file).
  async refused(res, job) {
    const page = /text\/html/i.test(res.headers.get('content-type') || '');
    if (res.status !== 401 && res.status !== 403 && !(res.ok && page)) return null;
    if (await keyRead()) return res.status === 401 ? 'Civitai no longer accepts your key. Connect your account again (top of this screen), then get it again.'
      : job.paid ? 'Your account hasn\'t unlocked this one yet: its maker asks for Buzz. Unlock it on its page on Civitai, then get it again here.'
        : `Civitai won't hand this one to your account yet: it may be early access, or its maker's choice. Its page says more: ${job.page}`;
    job.needs = 'civitai';
    return 'Its maker asks for a signed-in Civitai account (free). Connect yours at the top of this screen, then get it again.';
  },
  async verify(part, job) {
    if (!job.sha256) return;
    if ((await sha256Of(part)) !== job.sha256) {
      await fs.rm(part, { force: true });
      throw new Error("The file didn't arrive whole (it isn't the one Civitai lists). Get it again.");
    }
  },
  async done(dest, job) {
    const st = await fs.stat(dest).catch(() => null);
    const n = await readNotes();
    n.files[job.name] = { ...job.note, size: st?.size || 0 };
    delete n.unknown[job.name];
    // Kept next to an older one: that one isn't told about this version again.
    if (job.lora.beside && job.lora.beside !== job.name && n.files[job.lora.beside]) n.files[job.lora.beside].skip = job.lora.versionId;
    await saveNotes();
  },
};

// The loras folder a file is in (ComfyUI may have several), or the first one for a new file.
async function dirOf(dirs, rel) {
  const list = (Array.isArray(dirs) ? dirs : []).filter(d => typeof d === 'string');
  for (const d of list) if ((await fs.stat(path.join(d, rel)).catch(() => null))?.isFile()) return { dir: d, here: true };
  return { dir: list[0] || '', here: false };
}
const safeRel = rel => typeof rel === 'string' && rel.length < 400 && /\.safetensors$/i.test(rel) && slashes(rel).split('/').every(p => SAFE_PART.test(p) && p !== '..' && p !== '.');

/**
 * Starts getting one version of a LoRA into ComfyUI's loras folder. dirs: ComfyUI's loras folders (on this computer).
 * folder: the model's folder there ("krea2"; made when it isn't there yet). replace: the file ("krea2/film.safetensors")
 * this version takes the place of: it keeps that name, so every workflow that loads it gets the new one. beside: the
 * older file this one is kept next to (Keep both), which then stops offering it.
 * Returns the download job (the same list as the model files': /api/comfy/downloads).
 */
export async function get(dirs, { versionId, folder = '', replace = '', beside = '' }) {
  if (!/^\d{1,12}$/.test(String(versionId || ''))) throw httpError(400, 'Which LoRA? (No version given.)');
  const v = await ask(`/api/v1/model-versions/${versionId}`);
  const f = fileOf(v);
  if (!f) throw httpError(400, "This LoRA has no .safetensors file, the one kind Prompt Maker downloads (it can't carry a program). Get it from its page if you trust its maker.");
  folder = slashes(folder || '').replace(/^\/+|\/+$/g, '');
  if (folder && !folder.split('/').every(p => SAFE_PART.test(p) && p !== '..' && p !== '.')) throw httpError(400, "That folder's name isn't one Prompt Maker can use.");
  const n = await readNotes();
  let rel;
  let dir;
  if (replace) {
    if (!safeRel(replace)) throw httpError(400, "That file's name isn't one Prompt Maker can replace.");
    rel = slashes(replace);
    const at = await dirOf(dirs, rel);
    if (!at.here) throw httpError(404, `${rel} isn't in ComfyUI's loras folder any more.`);
    dir = at.dir;
  } else {
    rel = `${folder ? `${folder}/` : ''}${safeName(f.name)}`;
    ({ dir } = await dirOf(dirs, rel));
    // The name is taken by another LoRA, or another version of this one: this one says which version it is.
    const taken = async r => (await dirOf(dirs, r)).here && n.files[r]?.versionId !== Number(v.id);
    if (await taken(rel)) rel = rel.replace(/(\.safetensors)$/i, `-${safeName(`${v.name || v.id}.safetensors`).replace(/\.safetensors$/, '').replace(/\s+/g, '_')}$1`);
    if (await taken(rel)) rel = rel.replace(/(\.safetensors)$/i, `-${v.id}$1`);
  }
  if (!dir) throw httpError(400, "ComfyUI didn't say where its loras folder is, so Prompt Maker can't put the LoRA there.");
  // Keep both, and the newer one is here already: nothing to fetch, the older one just stops offering it.
  if (!replace && beside && n.files[beside] && n.files[rel]?.versionId === Number(v.id) && (await dirOf(dirs, rel)).here) {
    n.files[beside].skip = Number(v.id);
    await saveNotes();
  }
  const dest = path.resolve(dir, rel);
  const modelId = v.modelId;
  return beginDownload({
    dir, name: rel, folder: 'loras', url: `${API()}/api/download/models/${v.id}`, via: VIA, replace: Boolean(replace), part: `${dest}.${v.id}.part`,
    extra: { lora: { modelId, versionId: Number(v.id), replace: Boolean(replace), beside: typeof beside === 'string' ? beside.slice(0, 400) : '' }, page: pageOf(modelId, v.id, v.model?.nsfw), paid: Boolean(v.paidAccess), sha256: String(f.hashes?.SHA256 || '').toUpperCase(), note: noteFrom(v, modelId, v.model?.name, f) },
  });
}

const modelCache = new Map(); // Civitai model id → { at, data }
async function civitaiModel(id, { fresh = false } = {}) {
  const hit = modelCache.get(id);
  if (hit && !fresh && Date.now() - hit.at < 30 * 60_000) return hit.data;
  const data = await ask(`/api/v1/models/${id}`).catch(err => (err.status === 404 ? { gone: true } : null));
  if (data) modelCache.set(id, { at: Date.now(), data });
  return data;
}

/**
 * The LoRAs in a folder ("" = all), what each is, and whether its maker has put out a newer version.
 * list: the LoRAs ComfyUI has; dirs: its loras folders when it's on this computer (else null: files can't be read).
 * identify: also read the files nobody has looked up yet and ask Civitai what they are (by their SHA-256: nothing
 * of the file leaves the computer but that number). Slow the first time: every such file is read once.
 * Returns { files: [{ file, known, name, version, page, words, update: { versionId, name, published, size } | null,
 * skipped }], unread: files not looked up yet, offline: Civitai couldn't be asked }.
 */
export async function updates(list, dirs, { folder = '', identify = false, fresh = false } = {}) {
  const n = await readNotes();
  const mine = (list || []).filter(rel => /\.safetensors$/i.test(rel) && (!folder || folderOf(rel) === folder));
  let changed = false;
  let unread = 0;
  let offline = false;
  const out = [];
  for (const rel of mine) {
    const at = dirs ? await dirOf(dirs, rel) : null;
    const full = at?.here ? path.join(at.dir, rel) : '';
    const st = full ? await fs.stat(full).catch(() => null) : null;
    const before = unread;
    let note = n.files[rel];
    // Another file under that name since (put there by hand): what was noted is about the old one.
    if (note && st && note.size && st.size !== note.size) { delete n.files[rel]; note = null; changed = true; }
    if (!note && st?.isFile()) {
      const seen = n.unknown[rel];
      const same = seen && seen.size === st.size && seen.mtime === Math.round(st.mtimeMs);
      if (!same && !identify) unread++;
      else if (!same && safeRel(rel)) {
        const sha = await sha256Of(full).catch(() => '');
        const v = sha ? await ask(`/api/v1/model-versions/by-hash/${sha}`).catch(err => (err.status === 404 ? null : undefined)) : undefined;
        if (v === undefined) { offline = offline || Boolean(sha); unread++; }
        else if (v?.id && v.modelId) { note = n.files[rel] = { ...noteFrom(v, v.modelId, v.model?.name, { hashes: { SHA256: sha } }, st) }; delete n.unknown[rel]; changed = true; }
        else { n.unknown[rel] = { size: st.size, mtime: Math.round(st.mtimeMs) }; changed = true; }
      }
    }
    out.push({ file: rel, known: Boolean(note), note, unread: !note && unread > before });
  }
  if (changed) await saveNotes();
  const ids = [...new Set(out.filter(o => o.note).map(o => o.note.modelId))];
  const models = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => { while (next < ids.length) { const id = ids[next++]; models.set(id, await civitaiModel(id, { fresh })); } }));
  return {
    unread, offline: offline || ids.some(id => !models.get(id)),
    files: out.map(({ file, known, note, unread: notRead }) => {
      if (!note) return { file, known, unread: notRead || !dirs };
      const m = models.get(note.modelId);
      const versions = (m?.modelVersions || []).filter(v => fileOf(v) && v.availability !== 'EarlyAccess');
      const latest = versions.find(v => !note.base || v.baseModel === note.base);
      const newer = latest && latest.id !== note.versionId && (!note.published || !latest.publishedAt || new Date(latest.publishedAt) > new Date(note.published)) ? latest : null;
      const f = newer && fileOf(newer);
      return {
        file, known, modelId: note.modelId, versionId: note.versionId, name: note.name, version: note.version, page: pageOf(note.modelId, note.versionId, m?.nsfw ?? note.adult), words: note.words || [], gone: Boolean(m?.gone),
        update: newer && note.skip !== newer.id ? { versionId: newer.id, name: String(newer.name || '').slice(0, 80), published: newer.publishedAt || '', size: Math.round((f.sizeKB || 0) * 1024), page: pageOf(note.modelId, newer.id, m?.nsfw ?? note.adult), paid: Boolean(newer.paidAccess) } : null,
        skipped: Boolean(newer && note.skip === newer.id),
      };
    }),
  };
}

/**
 * One LoRA as its page on Civitai shows it, for the screen inside the app: what its maker wrote, its pictures and its
 * versions (the ones made for bases when there are some). list: the LoRAs ComfyUI has, or null. adult false: only
 * the pictures Civitai rates for everyone.
 * Returns { id, name, creator, downloads, likes, adult, page, description, versions: [{ id, name, base, published,
 * size, file, words, early, notes, images, have, older }] }.
 */
export async function details(id, { bases = [], list = null, adult = true } = {}) {
  if (!/^\d{1,12}$/.test(String(id || ''))) throw httpError(400, 'Which LoRA?');
  const m = await civitaiModel(Number(id));
  if (!m) throw httpError(502, "Couldn't reach Civitai. Try again in a moment.");
  if (m.gone) throw httpError(404, 'That LoRA is no longer on Civitai.');
  const { files } = await readNotes();
  const mine = Object.entries(files).filter(([rel, n]) => n.modelId === m.id && (!list || list.includes(rel)));
  const all = m.modelVersions || [];
  const fit = all.filter(v => bases.includes(v.baseModel));
  return {
    id: m.id, name: String(m.name || '').slice(0, 200), creator: String(m.creator?.username || '').slice(0, 80), downloads: m.stats?.downloadCount || 0, likes: m.stats?.thumbsUpCount || 0,
    adult: Boolean(m.nsfw), page: pageOf(m.id, 0, m.nsfw), description: plain(m.description),
    versions: (fit.length ? fit : all).slice(0, 12).map(v => {
      const f = fileOf(v);
      return {
        id: v.id, name: String(v.name || '').slice(0, 80), base: v.baseModel || '', published: v.publishedAt || '', size: f ? Math.round((f.sizeKB || 0) * 1024) : 0, file: f ? safeName(f.name) : '', words: words(v), early: v.availability === 'EarlyAccess', paid: Boolean(v.paidAccess),
        notes: plain(v.description, 3000), images: (v.images || []).filter(i => typeof i?.url === 'string' && (adult || !(i.nsfwLevel > 2))).slice(0, 8).map(i => proxied(i.url, true)),
        have: mine.find(([, n]) => n.versionId === v.id)?.[0] || '', older: mine.find(([, n]) => n.versionId !== v.id)?.[0] || '',
      };
    }),
  };
}

// "Keep the one I have": that version isn't offered for this file again (a later one is).
export async function skip(file, versionId) {
  const n = await readNotes();
  if (!n.files[file]) throw httpError(404, 'Prompt Maker has no note of that LoRA.');
  if (versionId) n.files[file].skip = Number(versionId); else delete n.files[file].skip;
  await saveNotes();
  return { ok: true };
}

// ---------- previews ----------
// The page loads pictures from Prompt Maker only, so Civitai's previews come through here: Civitai's picture host
// alone, a small still (a video's first frame; big: a larger one, for a LoRA's own screen), kept for the session.
const pictures = new Map(); // url → { type, body }
export async function image(u, { big = false } = {}) {
  let link;
  try { link = new URL(String(u || '')); } catch { throw httpError(400, 'Not a picture link.'); }
  const test = process.env.PM_CIVITAI_API && link.host === new URL(API()).host;
  if (!test && !(link.protocol === 'https:' && link.hostname === 'image.civitai.com')) throw httpError(400, 'Not a Civitai picture.');
  const key = link.href;
  if (pictures.has(key)) return pictures.get(key);
  // A small still first (a video's first frame); for some pictures Civitai answers that with the full-size original,
  // so then just a smaller copy.
  const width = big ? 640 : 320;
  const sized = opts => { const l = new URL(key); l.pathname = l.pathname.replace(/\/(?:original=true|width=\d+)(?:,[^/]*)?\//, `/${opts}/`); return l.href; };
  let got = null;
  for (const at of test ? [key] : [sized(`anim=false,transcode=true,width=${width}`), sized(`width=${width}`)]) {
    got = await fetchPicture(at);
    if (got) break;
  }
  if (!got) throw httpError(404, 'No preview.');
  pictures.set(key, got);
  if (pictures.size > 300) pictures.delete(pictures.keys().next().value);
  return got;
}
// A picture, up to 4 MB; null when it isn't one, is bigger, or can't be had.
async function fetchPicture(at) {
  let res;
  try {
    res = await fetch(at, { signal: AbortSignal.timeout(20000) });
  } catch {
    return null;
  }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type) || Number(res.headers.get('content-length') || 0) > 4e6) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  return body.length > 4e6 ? null : { type, body };
}
