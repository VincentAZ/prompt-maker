// File-based persistence: target-model definitions, settings, history and uploaded images.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_MASTER_PROMPT } from './prompt.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.PROMPT_MAKER_DATA || path.join(ROOT, 'data');
const MODELS_DIR = path.join(DATA_DIR, 'models');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

export const LENGTHS = ['short', 'medium', 'long'];

const DEFAULT_SETTINGS = {
  lmStudioUrl: 'http://127.0.0.1:1234',
  llmModel: '',
  topP: 0.95,
  maxTokens: 4096,
  thinking: 'off',
  masterPrompt: DEFAULT_MASTER_PROMPT,
};

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'default'];

export async function init() {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
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

export async function listModels() {
  const files = (await fs.readdir(MODELS_DIR)).filter(f => f.endsWith('.json'));
  const models = [];
  for (const f of files) {
    try {
      models.push(JSON.parse(await fs.readFile(path.join(MODELS_DIR, f), 'utf8')));
    } catch (err) {
      console.warn(`Skipping unreadable model file ${f}: ${err.message}`);
    }
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getModel(id) {
  return readJson(modelFile(id), null);
}

export function saveModel(input, { overwrite = true, previousId } = {}) {
  return locked(async () => {
    const model = normalizeModel(input);
    const twin = (await listModels()).find(m => m.id !== model.id && m.id !== slugify(previousId || '') && m.name.toLowerCase() === model.name.toLowerCase());
    if (twin) throw httpError(409, `Another model is already called "${twin.name}".`);
    const exists = (await getModel(model.id)) !== null;
    if (exists && !overwrite) throw httpError(409, `A model with id "${model.id}" already exists.`);
    await writeJson(modelFile(model.id), model);
    if (previousId && slugify(previousId) !== model.id) await fs.rm(modelFile(previousId), { force: true });
    return model;
  });
}

export async function deleteModel(id) {
  await fs.rm(modelFile(id), { force: true });
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
    await writeJson(HISTORY_FILE, all.filter(e => e.id !== id));
  });
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
