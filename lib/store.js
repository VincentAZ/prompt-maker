// File-based persistence: target-model definitions, settings, history and uploaded images.
//
// The app folder is never written to. It only holds the playbooks that ship with the app (playbooks/).
// Everything personal (settings, history, images, renders, workflows, and your own or edited playbooks)
// lives in a per-user data folder outside it, so none of it can end up in git or be lost with a re-clone.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_MASTER_PROMPT, ADULT_CONTENT } from './prompt.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const BUILTIN_DIR = path.join(ROOT, 'playbooks');
const BUILTIN_CHAINS_DIR = path.join(ROOT, 'chains');
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
const CHAINS_DIR = path.join(DATA_DIR, 'chains'); // your saved chains (recipes), same overlay as playbooks
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const RENDERS_DIR = path.join(DATA_DIR, 'renders');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const ASSISTANT_FILE = path.join(DATA_DIR, 'assistant.json'); // the assistant conversation
const BRAINS_FILE = path.join(DATA_DIR, 'brains.json'); // what the app has learned about each LLM by using it

export const LENGTHS = ['short', 'medium', 'long'];
export const BATCH_MAX = 50; // takes per request, renders per take, and outputs in a batch

const DEFAULT_SETTINGS = {
  lmStudioUrl: 'http://127.0.0.1:1234',
  comfyUrl: 'http://127.0.0.1:8188',
  llmModel: '',
  topP: 0.95,
  maxTokens: 4096,
  thinking: 'off',
  adultContent: false, // adds the adult-content section (adultPrompt) to the master instructions
  masterPrompt: DEFAULT_MASTER_PROMPT,
  adultPrompt: ADULT_CONTENT, // that section, editable in Settings (default: lib/prompt.js ADULT_CONTENT)
  loraFolders: {}, // { modelId: folder in ComfyUI's loras folder ("" = all) } when the automatic match isn't right
  comfyCleanup: false, // delete a render from ComfyUI's output folder once Prompt Maker has copied it
  comfyOutputDir: '', // ComfyUI's output folder, if not the usual one next to its custom_nodes
  comfyDir: '', // ComfyUI's folder, to start it from Settings → Services ('' = the one found or last seen running)
  comfyArgs: '', // options to start ComfyUI with ('' = the ones it last ran with)
  comfyAutostart: false, // start ComfyUI along with Prompt Maker
  comfyLaunch: null, // how ComfyUI was last seen running here: { dir, python, pre, args } (learned, not typed)
  batches: [], // your saved batches: [{ id, name, count, mode: 'same' (one prompt) | 'different' (a prompt each) }]
};

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'default'];

// Returns what was moved out of an old ./data folder, if anything.
export async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const moved = await migrateLegacyData();
  await fs.mkdir(MODELS_DIR, { recursive: true });
  await fs.mkdir(CHAINS_DIR, { recursive: true });
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
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; // unique, so overlapping saves can't collide
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
  if (!s.adultPrompt?.trim()) s.adultPrompt = ADULT_CONTENT;
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
    if (typeof patch.adultContent === 'boolean') next.adultContent = patch.adultContent;
    if (typeof patch.masterPrompt === 'string') next.masterPrompt = patch.masterPrompt.trim() || DEFAULT_MASTER_PROMPT;
    if (typeof patch.adultPrompt === 'string') next.adultPrompt = patch.adultPrompt.trim() || ADULT_CONTENT;
    if (typeof patch.comfyCleanup === 'boolean') next.comfyCleanup = patch.comfyCleanup;
    if (typeof patch.comfyOutputDir === 'string') next.comfyOutputDir = patch.comfyOutputDir.trim().slice(0, 500);
    if (typeof patch.comfyDir === 'string') next.comfyDir = patch.comfyDir.trim().slice(0, 500);
    if (typeof patch.comfyArgs === 'string') next.comfyArgs = patch.comfyArgs.trim().slice(0, 1000);
    if (typeof patch.comfyAutostart === 'boolean') next.comfyAutostart = patch.comfyAutostart;
    if (patch.comfyLaunch && typeof patch.comfyLaunch === 'object') {
      const strings = v => (Array.isArray(v) ? v.map(String).slice(0, 60) : []);
      const { dir, python, pre, args } = patch.comfyLaunch;
      next.comfyLaunch = { dir: String(dir || ''), python: String(python || ''), pre: strings(pre), args: strings(args) };
    }
    if (Array.isArray(patch.batches)) {
      next.batches = patch.batches.slice(0, 30).filter(b => b && typeof b === 'object').map((b, i) => ({
        id: String(b.id || '').replace(/[^\w-]/g, '').slice(0, 40) || `batch-${i + 1}`,
        name: String(b.name || '').trim().slice(0, 60) || `Batch ${i + 1}`,
        count: Math.round(clamp(Number(b.count), 1, BATCH_MAX, 4)),
        mode: b.mode === 'different' ? 'different' : 'same',
      }));
    }
    if (patch.loraFolders && typeof patch.loraFolders === 'object') {
      next.loraFolders = { ...current.loraFolders };
      for (const [id, folder] of Object.entries(patch.loraFolders)) {
        if (folder === null) delete next.loraFolders[slugify(id)];
        else next.loraFolders[slugify(id)] = String(folder).slice(0, 200);
      }
    }
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
    // Used only while Settings → Adult content is on.
    adultExamples: (Array.isArray(input.adultExamples) ? input.adultExamples : []).map(x => String(x).trim()).filter(Boolean),
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

// Shipped defaults (read-only, in the app folder) overlaid by yours (in the data folder): the same id in
// yours wins, and deleting a built-in leaves a { deleted: true } marker. Used for playbooks and chains.
function overlay(builtinDir, userDir, label) {
  const userFile = id => path.join(userDir, `${slugify(id)}.json`);
  const builtinFile = id => path.join(builtinDir, `${slugify(id)}.json`);
  async function readDir(dir) {
    const out = new Map();
    const files = (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const item = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
        if (item?.id) out.set(item.id, item);
      } catch (err) {
        console.warn(`Skipping unreadable ${label} file ${path.join(dir, f)}: ${err.message}`);
      }
    }
    return out;
  }
  // builtin: ships with the app. edited: you changed a built-in, so your copy is the one used.
  const tag = (item, builtin, edited) => ({ ...item, builtin, edited });
  const isBuiltin = id => exists(builtinFile(id));
  return {
    isBuiltin,
    async list() {
      const [shipped, mine] = await Promise.all([readDir(builtinDir), readDir(userDir)]);
      const items = [];
      for (const [id, item] of mine) if (!item.deleted) items.push(tag(item, shipped.has(id), shipped.has(id)));
      for (const [id, item] of shipped) if (!mine.has(id)) items.push(tag(item, true, false));
      return items.sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(id) {
      const shipped = await readJson(builtinFile(id), null);
      const mine = await readJson(userFile(id), null);
      if (mine) return mine.deleted ? null : tag(mine, Boolean(shipped), Boolean(shipped));
      return shipped && tag(shipped, true, false);
    },
    write: item => writeJson(userFile(item.id), item),
    async remove(id) {
      if (await isBuiltin(id)) await writeJson(userFile(id), { id: slugify(id), deleted: true });
      else await fs.rm(userFile(id), { force: true });
    },
    // Drops your copy of a built-in: undoes your edits, or brings it back if you deleted it.
    reset: id => fs.rm(userFile(id), { force: true }),
    async hidden() {
      const [shipped, mine] = await Promise.all([readDir(builtinDir), readDir(userDir)]);
      return [...shipped.values()].filter(item => mine.get(item.id)?.deleted).map(item => ({ id: item.id, name: item.name }));
    },
  };
}

const models = overlay(BUILTIN_DIR, MODELS_DIR, 'model');

export const listModels = () => models.list();
export const getModel = id => models.get(id);

export function saveModel(input, { overwrite = true, previousId } = {}) {
  return locked(async () => {
    const model = normalizeModel(input);
    const twin = (await listModels()).find(m => m.id !== model.id && m.id !== slugify(previousId || '') && m.name.toLowerCase() === model.name.toLowerCase());
    if (twin) throw httpError(409, `Another model is already called "${twin.name}".`);
    const taken = (await getModel(model.id)) !== null;
    if (taken && !overwrite) throw httpError(409, `A model with id "${model.id}" already exists.`);
    await models.write(model);
    if (previousId && slugify(previousId) !== model.id) await models.remove(previousId);
    return getModel(model.id);
  });
}

export function deleteModel(id) {
  return locked(() => models.remove(id));
}

export function resetModel(id) {
  return locked(async () => {
    if (!(await models.isBuiltin(id))) throw httpError(400, 'Only built-in models can be reset.');
    await models.reset(id);
    return getModel(id);
  });
}

export const hiddenBuiltins = () => models.hidden();

// ---------- chains (saved recipes of steps) ----------

const IMAGE_ROLES = ['reference', 'recreate', 'animate'];
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const count = (v, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(1, Math.round(Number(v)))) : 1);

// One step of a chain (or of a run's snapshot). Step 0 is the Create form; later steps take a render as input.
export function normalizeStep(s = {}, index = 0) {
  const wf = s.workflow && typeof s.workflow === 'object' ? { id: text(s.workflow.id, 64), name: text(s.workflow.name, 120) } : null;
  const step = { modelId: slugify(s.modelId), workflow: wf?.id || wf?.name ? wf : null, takes: count(s.takes, 4), renders: count(s.renders, 4) };
  if (index === 0) {
    const d = s.dials || {};
    step.dials = {
      ...(d.aspectRatio ? { aspectRatio: text(d.aspectRatio, 20) } : {}),
      ...(d.resolution ? { resolution: text(d.resolution, 20) } : {}),
      ...(LENGTHS.includes(d.length) ? { length: d.length } : {}),
      ...(Number.isFinite(Number(d.temperature)) && d.temperature !== null && d.temperature !== '' ? { temperature: clamp(Number(d.temperature), 0, 2, 0.8) } : {}),
    };
  } else {
    step.use = IMAGE_ROLES.includes(s.use) ? s.use : 'animate';
    step.direction = text(s.direction, 2000);
    step.duration = text(s.duration, 20);
    step.gate = s.gate === 'auto' ? 'auto' : 'pick';
  }
  return step;
}

export function normalizeChain(input = {}) {
  const name = text(input.name, 80);
  const id = slugify(input.id || name);
  if (!id || !name) throw httpError(400, 'A chain needs a name.');
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 10).map((s, i) => normalizeStep(s, i));
  if (steps.length < 2) throw httpError(400, 'A chain needs at least two steps.');
  if (steps.some(s => !s.modelId)) throw httpError(400, 'Every step of a chain needs a model.');
  return { format: 'prompt-maker-chain', version: 1, id, name, steps, updatedAt: new Date().toISOString().slice(0, 10) };
}

const chains = overlay(BUILTIN_CHAINS_DIR, CHAINS_DIR, 'chain');

export const listChains = () => chains.list();

export function saveChain(input, { overwrite = true } = {}) {
  return locked(async () => {
    const chain = normalizeChain(input);
    if (!overwrite && (await chains.get(chain.id))) throw httpError(409, `A chain called "${chain.name}" already exists.`);
    await chains.write(chain);
    return chains.get(chain.id);
  });
}

export function deleteChain(id) {
  return locked(() => chains.remove(id));
}

// ---------- images ----------

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function saveImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw httpError(400, 'Unsupported image. Use JPEG, PNG or WebP.');
  const buf = Buffer.from(m[2], 'base64');
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${IMAGE_TYPES[m[1]]}`;
  const file = path.join(IMAGES_DIR, name);
  await fs.writeFile(file, buf, { flag: 'wx' }).catch(async err => {
    if (err.code !== 'EEXIST') throw err;
    const now = new Date();
    await fs.utimes(file, now, now); // added again: counts as new for the start-up sweep
  });
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

// An image the Create form let go of, unless an entry uses it.
export function deleteImageIfUnused(name) {
  return locked(async () => {
    if (!/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(name || '') || filesInUse(await listHistory()).images.has(name)) return false;
    await fs.rm(path.join(IMAGES_DIR, name), { force: true });
    return true;
  });
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

// What a set of entries still uses: an image added twice is one file, so it stays while any entry needs it.
export function filesInUse(entries) {
  const images = new Set();
  const renders = new Set();
  for (const e of entries) {
    if (e.imageFile) images.add(e.imageFile);
    for (const v of e.variations || []) for (const r of v.renders || []) for (const f of r.files || []) renders.add(f.file);
  }
  return { images, renders };
}

// Deleting is for good: the entry, its renders and its input image (unless another entry uses the same one), and
// any trace in what stays. Takes made from its renders keep their own image but lose the link and its prompt, and
// the assistant conversation loses any quote of its theme or prompts. Returns the entry and the entries left.
export function deleteHistory(id) {
  return locked(async () => {
    const all = await listHistory();
    const entry = all.find(e => e.id === id);
    if (!entry) return { entry: null, rest: all };
    const rest = all.filter(e => e.id !== id);
    for (const e of rest) if (e.source?.entryId === id) delete e.source;
    await writeJson(HISTORY_FILE, rest);
    const renders = entry.variations.flatMap(v => v.renders || []);
    await removeFiles(renders, entry.imageFile, rest);
    await scrubAssistant([entry.theme, ...entry.variations.flatMap(v => v.versions.map(x => x.text))]);
    return { entry, rest };
  });
}

async function removeFiles(renders, imageFile, rest) {
  const used = filesInUse(rest);
  await removeRenderFiles(renders, used.renders);
  if (/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(imageFile || '') && !used.images.has(imageFile)) await fs.rm(path.join(IMAGES_DIR, imageFile), { force: true });
}

export async function removeRenderFiles(renders, keep = new Set()) {
  for (const r of renders) {
    for (const f of r.files || []) {
      if (/^[\w-]+\.\w+$/.test(f.file) && !keep.has(f.file)) await fs.rm(path.join(RENDERS_DIR, f.file), { force: true });
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
    for (const e of all) if (e.source?.renderId === renderId) delete e.source;
    await writeJson(HISTORY_FILE, all);
    await removeFiles([removed], null, all);
    return { entry, removed, rest: all };
  });
}

// Replaces quotes of deleted words (a theme, a prompt, or its first 140 characters, which the assistant is shown)
// in the saved assistant conversation, also where they sit inside a tool call's JSON.
async function scrubAssistant(texts) {
  const phrases = [...new Set(texts.flatMap(t => [String(t || '').trim(), String(t || '').trim().slice(0, 140)]))].filter(t => t.length >= 12);
  const data = await readJson(ASSISTANT_FILE, null);
  if (!phrases.length || !Array.isArray(data?.messages)) return;
  const forms = phrases.flatMap(p => [p, JSON.stringify(p).slice(1, -1)]).sort((a, b) => b.length - a.length);
  const scrub = s => (typeof s === 'string' ? forms.reduce((acc, p) => acc.split(p).join('[deleted]'), s) : s);
  const before = JSON.stringify(data.messages);
  for (const m of data.messages) {
    m.content = scrub(m.content);
    for (const c of m.tool_calls || []) if (c.function) c.function.arguments = scrub(c.function.arguments);
  }
  if (JSON.stringify(data.messages) !== before) await writeJson(ASSISTANT_FILE, data);
}

// At start-up, removes what nothing in History uses anymore: leftovers of deletes from older versions, of a render
// interrupted between saving its file and its entry, or of a save cut short. An unused image goes after a day, as it
// may be the one waiting on the Create page. Nothing is swept without a history file to compare with.
export async function sweepOrphans() {
  if (!(await exists(HISTORY_FILE))) return 0;
  const used = filesInUse(await listHistory());
  const dayAgo = Date.now() - 864e5;
  let removed = 0;
  const sweep = async (dir, keep, old = () => true) => {
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile() || keep(name) || !old(st)) continue;
      await fs.rm(file, { force: true });
      removed++;
    }
  };
  await sweep(RENDERS_DIR, name => used.renders.has(name));
  await sweep(IMAGES_DIR, name => used.images.has(name), st => st.mtimeMs < dayAgo);
  await sweep(DATA_DIR, name => !name.endsWith('.tmp'), st => st.mtimeMs < Date.now() - 6e5);
  return removed;
}

// ---------- brains (LM Studio models) ----------

// What the app knows about each LLM beyond LM Studio's facts, keyed by LM Studio model id:
//   thinking  its own Thinking level (else Settings → Thinking applies)
//   thinkOff  how "Thinking: Off" works on a Brain LM Studio can't switch, learned by using it: 'quiet' (it
//             doesn't think), 'trick' (it needs an empty thinking block), 'stubborn' (it thinks anyway)
//   stats     its prompt-writing runs: count, time, and how many ran out of room, came back empty or refused
//   check     the last Quick check
export const getBrainNotes = () => readJson(BRAINS_FILE, {});

function updateBrain(id, mutate) {
  return locked(async () => {
    const all = await readJson(BRAINS_FILE, {});
    const brain = { ...all[id] };
    mutate(brain);
    all[id] = { ...brain, updatedAt: new Date().toISOString() };
    await writeJson(BRAINS_FILE, all);
    return all[id];
  });
}

export const noteBrain = (id, patch) => updateBrain(id, b => Object.assign(b, patch));

export function setBrainThinking(id, level) {
  if (level && !THINKING_LEVELS.includes(level)) throw httpError(400, `Unknown thinking level "${level}".`);
  return updateBrain(id, b => { if (level) b.thinking = level; else delete b.thinking; });
}

// outcome: 'ok' | 'refused' | 'room' (ran out of tokens) | 'empty'. seconds is null when the run included loading.
export function recordBrainRun(id, { outcome, seconds }) {
  return updateBrain(id, b => {
    const s = (b.stats = { runs: 0, timed: 0, seconds: 0, refused: 0, room: 0, empty: 0, ...b.stats });
    s.runs += 1;
    if (outcome !== 'ok') s[outcome] += 1;
    if (Number.isFinite(seconds) && (outcome === 'ok' || outcome === 'refused')) {
      s.timed += 1;
      s.seconds = Math.round((s.seconds + seconds) * 10) / 10;
    }
    s.lastUsed = new Date().toISOString();
  });
}

// ---------- assistant conversation ----------

export async function getAssistantChat() {
  const data = await readJson(ASSISTANT_FILE, {});
  return { messages: Array.isArray(data.messages) ? data.messages : [] };
}

export function saveAssistantChat(messages) {
  // Images the assistant looked at aren't kept: only their names (they're copies of renders, and those can be deleted).
  const textOnly = m => (Array.isArray(m?.content) ? { ...m, content: m.content.filter(p => p?.type === 'text').map(p => p.text).join('\n') } : m);
  return locked(() => writeJson(ASSISTANT_FILE, { messages: (Array.isArray(messages) ? messages : []).slice(-100).map(textOnly) }));
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
