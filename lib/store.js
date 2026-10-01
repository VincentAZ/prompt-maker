// File-based persistence: target-model definitions, settings, history and uploaded images.
//
// The app folder is never written to. It only holds the playbooks that ship with the app (playbooks/).
// Everything personal (settings, history, images, renders, workflows, and your own or edited playbooks)
// lives in a per-user data folder outside it, so none of it can end up in git or be lost with a re-clone.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_MASTER_PROMPT } from './prompt.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const BUILTIN_DIR = path.join(ROOT, 'playbooks');
const LEGACY_DIR = path.join(ROOT, 'data'); // where older versions kept personal data

function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Prompt Maker');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Prompt Maker');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'prompt-maker');
}

export const DATA_DIR = path.resolve(process.env.PROMPT_MAKER_DATA || defaultDataDir());
// Your playbooks: models you added, built-ins you edited (same id wins), and markers for built-ins you deleted.
const MODELS_DIR = path.join(DATA_DIR, 'models');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const RENDERS_DIR = path.join(DATA_DIR, 'renders');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

export const LENGTHS = ['short', 'medium', 'long'];

const DEFAULT_SETTINGS = {
  lmStudioUrl: 'http://127.0.0.1:1234',
  comfyUrl: 'http://127.0.0.1:8188',
  llmModel: '',
  topP: 0.95,
  maxTokens: 4096,
  thinking: 'off',
  masterPrompt: DEFAULT_MASTER_PROMPT,
};

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'default'];

// Returns what was moved out of an old ./data folder, if anything.
export async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const moved = await migrateLegacyData();
  await fs.mkdir(MODELS_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  return moved;
}

const exists = p => fs.access(p).then(() => true, () => false);

async function move(src, dst) {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(src, { recursive: true, force: true });
  }
}

// Older versions kept personal data in ./data inside the app folder. Move it to the data folder,
// never overwriting anything already there. Skipped when PROMPT_MAKER_DATA picks the location explicitly.
async function migrateLegacyData() {
  if (process.env.PROMPT_MAKER_DATA || LEGACY_DIR === DATA_DIR || !(await exists(LEGACY_DIR))) return [];
  const moved = [];
  for (const name of ['settings.json', 'history.json', 'images', 'renders', 'workflows']) {
    const src = path.join(LEGACY_DIR, name);
    const dst = path.join(DATA_DIR, name);
    if (!(await exists(src))) continue;
    if (!(await exists(dst))) {
      await move(src, dst);
    } else if ((await fs.stat(src)).isDirectory()) {
      for (const f of await fs.readdir(src)) {
        if (!(await exists(path.join(dst, f)))) await move(path.join(src, f), path.join(dst, f));
      }
      await fs.rmdir(src).catch(() => {}); // stays if something couldn't move
    } else continue; // a file of that name is already in the data folder: leave both alone
    moved.push(name);
  }
  // Old model files: keep the ones you added or changed; exact copies of a shipped playbook aren't needed.
  const oldModels = path.join(LEGACY_DIR, 'models');
  if (await exists(oldModels)) {
    await fs.mkdir(MODELS_DIR, { recursive: true });
    for (const f of (await fs.readdir(oldModels)).filter(x => x.endsWith('.json'))) {
      const src = path.join(oldModels, f);
      const dst = path.join(MODELS_DIR, f);
      const shipped = await fs.readFile(path.join(BUILTIN_DIR, f), 'utf8').catch(() => null);
      const mine = await fs.readFile(src, 'utf8');
      if (shipped !== null && shipped.trim() === mine.trim()) await fs.rm(src);
      else if (!(await exists(dst))) { await move(src, dst); moved.push(`models/${f}`); }
    }
    await fs.rmdir(oldModels).catch(() => {});
  }
  await fs.rmdir(LEGACY_DIR).catch(() => {});
  return moved;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Serialize read-modify-write cycles so concurrent requests can't clobber each other.
let queue = Promise.resolve();
function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- settings ----------

export async function getSettings() {
  const saved = await readJson(SETTINGS_FILE, {});
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (!s.masterPrompt?.trim()) s.masterPrompt = DEFAULT_MASTER_PROMPT;
  return s;
}

export function updateSettings(patch) {
  return locked(async () => {
    const current = await getSettings();
    const next = { ...current };
    if (typeof patch.lmStudioUrl === 'string') next.lmStudioUrl = patch.lmStudioUrl.trim().replace(/\/+$/, '');
    if (typeof patch.comfyUrl === 'string') next.comfyUrl = patch.comfyUrl.trim().replace(/\/+$/, '');
    if (typeof patch.llmModel === 'string') next.llmModel = patch.llmModel.trim();
    if (patch.topP !== undefined) next.topP = clamp(Number(patch.topP), 0, 1, DEFAULT_SETTINGS.topP);
    if (patch.maxTokens !== undefined) next.maxTokens = Math.round(clamp(Number(patch.maxTokens), 256, 32768, DEFAULT_SETTINGS.maxTokens));
    if (THINKING_LEVELS.includes(patch.thinking)) next.thinking = patch.thinking;
    if (typeof patch.masterPrompt === 'string') next.masterPrompt = patch.masterPrompt.trim() || DEFAULT_MASTER_PROMPT;
    await writeJson(SETTINGS_FILE, next);
    return next;
  });
}

// ---------- target models ----------

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function clamp(n, min, max, fallback) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function toList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/);
  return [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
}

function pick(value, options) {
  return options.includes(value) ? value : (options[0] ?? '');
}

export function normalizeModel(input) {
  const kind = input.kind === 'video' ? 'video' : 'image';
  const name = String(input.name || '').trim();
  const id = slugify(input.id || name);
  if (!id || !name) throw httpError(400, 'A model needs a name.');
  const aspectRatios = toList(input.aspectRatios);
  const resolutions = toList(input.resolutions);
  const durations = kind === 'video' ? toList(input.durations) : [];
  const d = input.defaults || {};
  const lg = input.lengthGuide || {};
  return {
    id,
    name,
    kind,
    description: String(input.description || '').trim(),
    color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color.toLowerCase() : '',
    instructions: String(input.instructions || '').trim(),
    examples: (Array.isArray(input.examples) ? input.examples : []).map(x => String(x).trim()).filter(Boolean),
    aspectRatios,
    resolutions,
    durations,
    defaults: {
      aspectRatio: pick(d.aspectRatio, aspectRatios),
      resolution: pick(d.resolution, resolutions),
      duration: pick(d.duration, durations),
      temperature: clamp(Number(d.temperature), 0, 2, 0.8),
      length: LENGTHS.includes(d.length) ? d.length : 'medium',
    },
    lengthGuide: {
      short: String(lg.short || '≈40–70 words').trim(),
      medium: String(lg.medium || '≈80–130 words').trim(),
      long: String(lg.long || '≈150–220 words').trim(),
    },
    sources: toList(input.sources),
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

const modelFile = id => path.join(MODELS_DIR, `${slugify(id)}.json`);
const builtinFile = id => path.join(BUILTIN_DIR, `${slugify(id)}.json`);

async function readModelDir(dir) {
  const out = new Map();
  const files = (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (m?.id) out.set(m.id, m);
    } catch (err) {
      console.warn(`Skipping unreadable model file ${path.join(dir, f)}: ${err.message}`);
    }
  }
  return out;
}

// builtin: ships with the app. edited: you changed a built-in, so your copy is the one used.
const tag = (m, builtin, edited) => ({ ...m, builtin, edited });

export async function listModels() {
  const [shipped, mine] = await Promise.all([readModelDir(BUILTIN_DIR), readModelDir(MODELS_DIR)]);
  const models = [];
  for (const [id, m] of mine) if (!m.deleted) models.push(tag(m, shipped.has(id), shipped.has(id)));
  for (const [id, m] of shipped) if (!mine.has(id)) models.push(tag(m, true, false));
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getModel(id) {
  const shipped = await readJson(builtinFile(id), null);
  const mine = await readJson(modelFile(id), null);
  if (mine) return mine.deleted ? null : tag(mine, Boolean(shipped), Boolean(shipped));
  return shipped && tag(shipped, true, false);
}

const isBuiltin = id => exists(builtinFile(id));

// A built-in can't be removed from the app folder, so deleting one leaves a marker in yours.
async function removeModel(id) {
  if (await isBuiltin(id)) await writeJson(modelFile(id), { id: slugify(id), deleted: true });
  else await fs.rm(modelFile(id), { force: true });
}

export function saveModel(input, { overwrite = true, previousId } = {}) {
  return locked(async () => {
    const model = normalizeModel(input);
    const twin = (await listModels()).find(m => m.id !== model.id && m.id !== slugify(previousId || '') && m.name.toLowerCase() === model.name.toLowerCase());
    if (twin) throw httpError(409, `Another model is already called "${twin.name}".`);
    const taken = (await getModel(model.id)) !== null;
    if (taken && !overwrite) throw httpError(409, `A model with id "${model.id}" already exists.`);
    await writeJson(modelFile(model.id), model);
    if (previousId && slugify(previousId) !== model.id) await removeModel(previousId);
    return getModel(model.id);
  });
}

export function deleteModel(id) {
  return locked(() => removeModel(id));
}

// Drops your copy of a built-in: undoes your edits, or brings it back if you deleted it.
export function resetModel(id) {
  return locked(async () => {
    if (!(await isBuiltin(id))) throw httpError(400, 'Only built-in models can be reset.');
    await fs.rm(modelFile(id), { force: true });
    return getModel(id);
  });
}

export async function hiddenBuiltins() {
  const [shipped, mine] = await Promise.all([readModelDir(BUILTIN_DIR), readModelDir(MODELS_DIR)]);
  return [...shipped.values()].filter(m => mine.get(m.id)?.deleted).map(m => ({ id: m.id, name: m.name }));
}

// ---------- images ----------

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function saveImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw httpError(400, 'Unsupported image. Use JPEG, PNG or WebP.');
  const buf = Buffer.from(m[2], 'base64');
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${IMAGE_TYPES[m[1]]}`;
  const file = path.join(IMAGES_DIR, name);
  await fs.writeFile(file, buf, { flag: 'wx' }).catch(err => { if (err.code !== 'EEXIST') throw err; });
  return name;
}

export async function readImageDataUrl(name) {
  if (!/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(name || '')) throw httpError(400, 'Invalid image reference.');
  const ext = name.split('.').pop();
  const mime = Object.keys(IMAGE_TYPES).find(k => IMAGE_TYPES[k] === ext);
  const buf = await fs.readFile(path.join(IMAGES_DIR, name)).catch(() => {
    throw httpError(404, 'The stored image for this entry is missing.');
  });
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ---------- history ----------

export async function listHistory() {
  return readJson(HISTORY_FILE, []);
}

export async function getHistory(id) {
  return (await listHistory()).find(e => e.id === id) || null;
}

export function addHistory(entry) {
  return locked(async () => {
    const all = await listHistory();
    const full = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), favorite: false, ...entry };
    all.unshift(full);
    await writeJson(HISTORY_FILE, all);
    return full;
  });
}

export function updateHistory(id, mutate) {
  return locked(async () => {
    const all = await listHistory();
    const entry = all.find(e => e.id === id);
    if (!entry) throw httpError(404, 'History entry not found.');
    mutate(entry);
    await writeJson(HISTORY_FILE, all);
    return entry;
  });
}

export function deleteHistory(id) {
  return locked(async () => {
    const all = await listHistory();
    const entry = all.find(e => e.id === id);
    await writeJson(HISTORY_FILE, all.filter(e => e.id !== id));
    for (const v of entry?.variations || []) await removeRenderFiles(v.renders || []);
  });
}

export async function removeRenderFiles(renders) {
  for (const r of renders) {
    for (const f of r.files || []) {
      if (/^[\w-]+\.\w+$/.test(f.file)) await fs.rm(path.join(RENDERS_DIR, f.file), { force: true });
    }
  }
}

export function deleteRender(entryId, renderId) {
  return locked(async () => {
    const all = await listHistory();
    const entry = all.find(e => e.id === entryId);
    if (!entry) throw httpError(404, 'History entry not found.');
    let removed = null;
    for (const v of entry.variations) {
      const i = (v.renders || []).findIndex(r => r.id === renderId);
      if (i >= 0) [removed] = v.renders.splice(i, 1);
    }
    if (!removed) throw httpError(404, 'Render not found.');
    await writeJson(HISTORY_FILE, all);
    await removeRenderFiles([removed]);
    return entry;
  });
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
