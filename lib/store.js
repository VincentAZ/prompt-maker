// File-based persistence: target-model definitions, settings, history and uploaded images.
//
// The app folder is never written to. It only holds the playbooks that ship with the app (playbooks/).
// Everything personal (settings, history, images, renders, workflows, and your own or edited playbooks)
// lives in a per-user data folder outside it, so none of it can end up in git or be lost with a re-clone.
import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
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
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Memory-backed storage this computer offers (Linux: /dev/shm is RAM, gone at shutdown), or null.
export const ramDir = () => process.env.PM_RAM_DIR || (process.platform === 'linux' ? '/dev/shm' : null);

// "Nothing on this machine" (the Privacy level, Settings → 🔒 Privacy check): your work (History, pictures, videos,
// renders, the assistant chat, jobs) is kept in memory for this session only and goes when Prompt Maker stops;
// settings, playbooks, workflows, chains, voices and what the app learned stay in the data folder. Read as the app
// starts (it takes a restart to change): the session folder is where that work lives, the data folder otherwise.
function sessionDir() {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    const ram = ramDir();
    if (s?.dataRam && ram && statSync(ram).isDirectory()) return path.join(ram, 'prompt-maker-session');
  } catch { /* no settings yet, or no memory folder: the data folder */ }
  return DATA_DIR;
}
export const SESSION_DIR = sessionDir();
export const IN_MEMORY = SESSION_DIR !== DATA_DIR;

// Your playbooks: models you added, built-ins you edited (same id wins), and markers for built-ins you deleted.
const MODELS_DIR = path.join(DATA_DIR, 'models');
const CHAINS_DIR = path.join(DATA_DIR, 'chains'); // your saved chains (recipes), same overlay as playbooks
export const IMAGES_DIR = path.join(SESSION_DIR, 'images');
export const RENDERS_DIR = path.join(SESSION_DIR, 'renders');
export const VIDEOS_DIR = path.join(SESSION_DIR, 'videos'); // motion videos (deduplicated)
const HISTORY_FILE = path.join(SESSION_DIR, 'history.json');
const ASSISTANT_FILE = path.join(SESSION_DIR, 'assistant.json'); // the assistant conversation
const BRAINS_FILE = path.join(DATA_DIR, 'brains.json'); // what the app has learned about each LLM by using it
const JOBS_FILE = path.join(SESSION_DIR, 'jobs.json'); // the assistant's long jobs: their plan, progress and log
const ORDER_FILE = path.join(SESSION_DIR, 'render-order.json'); // the order you dragged 🎞 Your renders into
const HOLDS_FILE = path.join(SESSION_DIR, 'holds.json'); // the pictures and videos each browser's Create page still holds

export const LENGTHS = ['short', 'medium', 'long'];
// reference / recreate: the generator doesn't get the image; animate: it's the first frame; character: the
// generator gets it as the character to animate (with a motion video).
export const IMAGE_ROLES = ['reference', 'recreate', 'animate', 'character'];
export const BATCH_MAX = 50; // takes per request, renders per take, and outputs in a batch

const DEFAULT_SETTINGS = {
  lmStudioUrl: 'http://127.0.0.1:1234',
  comfyUrl: 'http://127.0.0.1:8188',
  llmModel: '',
  topP: 0.95,
  maxTokens: 4096,
  thinking: 'off',
  adultContent: false, // adds the adult-content section (adultPrompt) to the master instructions
  assistantComputer: false, // ✦ Assistant may use this computer: run commands, read and write any file (lib/computer.js)
  masterPrompt: DEFAULT_MASTER_PROMPT,
  adultPrompt: ADULT_CONTENT, // that section, editable in Settings (default: lib/prompt.js ADULT_CONTENT)
  loraFolders: {}, // { modelId: folder in ComfyUI's loras folder ("" = all) } when the automatic match isn't right
  comfyCleanup: false, // delete a render from ComfyUI's output folder once Prompt Maker has copied it
  comfyOutputDir: '', // ComfyUI's output folder, if not the usual one next to its custom_nodes
  comfyDir: '', // ComfyUI's folder, to start it from Settings → Services ('' = the one found or last seen running)
  comfyArgs: '', // options to start ComfyUI with ('' = the ones it last ran with)
  logScrub: true, // deleting from History also cleans LM Studio's and ComfyUI's own logs of the deleted words and files
  comfyAutostart: false, // start ComfyUI along with Prompt Maker
  comfyRam: false, // when Prompt Maker starts ComfyUI, its output, input and temp folders are in memory (Linux)
  dataRam: false, // your work (History, renders, chat) in memory for the session only; read at start (SESSION_DIR)
  privacyLevel: '', // the Privacy level chosen ('' = not asked yet): normal | private | ram
  comfyLaunch: null, // how ComfyUI was last seen running here: { dir, python, pre, args } (learned, not typed)
  batches: [], // your saved batches: [{ id, name, count, mode: 'same' (one prompt) | 'different' (a prompt each) }]
};

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'default'];
export const PRIVACY_LEVELS = ['normal', 'private', 'ram'];

// Prompt Maker is stopping: a session in memory goes with it.
export async function endSession() {
  if (IN_MEMORY) await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
}

// Returns what was moved out of an old ./data folder, if anything.
export async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // A session in memory starts empty: what a session that ended badly left is removed first.
  if (IN_MEMORY) await fs.rm(SESSION_DIR, { recursive: true, force: true });
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const moved = await migrateLegacyData();
  await fs.mkdir(MODELS_DIR, { recursive: true });
  await fs.mkdir(CHAINS_DIR, { recursive: true });
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
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
    } else if (name === 'history.json') {
      // Both have a history: the old entries join the new ones, or the start-up sweep would take their renders
      // and images (moved in above) for leftovers.
      const [old, now] = await Promise.all([readJson(src, []), readJson(dst, [])]);
      if (!Array.isArray(old) || !Array.isArray(now)) continue;
      const have = new Set(now.map(e => e?.id));
      const all = [...now, ...old.filter(e => e?.id && !have.has(e.id))].sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
      await writeJson(dst, all);
      await fs.rm(src);
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

// A file that can't be read as JSON (emptied by a power cut, damaged) doesn't stop the app: the copy from before
// the last save (.bak) takes its place, losing only that last change. Without a good copy, the damaged file is set
// aside (.damaged-…, for you or a repair) and the app goes on as if the file were new.
async function readJson(file, fallback) {
  const parse = async f => JSON.parse(await fs.readFile(f, 'utf8'));
  try {
    return await parse(file);
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    const damaged = err.code !== 'ENOENT';
    const backup = await parse(`${file}.bak`).catch(() => undefined);
    if (damaged) {
      await fs.rename(file, `${file}.damaged-${Date.now()}`).catch(() => {});
      console.warn(`${path.basename(file)} couldn't be read (${err.message}). ${backup === undefined ? 'It was set aside and a new one starts.' : 'The copy from before the last save is used.'}`);
    }
    if (backup === undefined) return fallback;
    await fs.copyFile(`${file}.bak`, file).catch(() => {});
    return backup;
  }
}

// forget: the save removes something. The copy from before (.bak) would still hold it, so that copy is shredded
// and a copy of the new file takes its place (still a good copy for a power cut).
async function writeJson(file, data, { forget = false } = {}) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; // unique, so overlapping saves can't collide
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(data, null, 2) + '\n');
    await fh.sync(); // on the disk before it takes the old file's place, so a power cut can't leave it empty
  } finally {
    await fh.close();
  }
  // What it replaces stays as .bak (see readJson).
  await fs.rm(`${file}.bak`, { force: true });
  await fs.link(file, `${file}.bak`).catch(err => (err.code === 'ENOENT' ? null : fs.copyFile(file, `${file}.bak`).catch(() => {})));
  await fs.rename(tmp, file);
  if (forget) {
    await shredFile(`${file}.bak`);
    await fs.copyFile(file, `${file}.bak`).catch(() => {});
  }
}

// Removes a file the way a shredder does, so what it held can't be read back with a recovery tool: its bytes are
// written over three times (zeros, ones, random, each put on the disk before the next; the three passes of the
// DoD 5220.22-M wipe), the file gets a meaningless name so the old one leaves the folder's own records, then it goes.
// Honest limit: an SSD, or a file system that keeps old copies of blocks (Btrfs, ZFS, APFS), may keep the old bytes
// somewhere this can't reach. Returns false when there was no such file.
const SHRED_CHUNK = 1 << 20;
export async function shredFile(file) {
  const st = await fs.lstat(file).catch(() => null);
  if (!st) return false;
  if (!st.isFile()) { // a link to a file elsewhere: only the link is ours to remove
    await fs.rm(file, { force: true });
    return true;
  }
  let name = file;
  try {
    const fh = await fs.open(file, 'r+');
    try {
      const passes = [() => Buffer.alloc(SHRED_CHUNK, 0), () => Buffer.alloc(SHRED_CHUNK, 0xff), () => crypto.randomBytes(SHRED_CHUNK)];
      for (const make of passes) {
        for (let pos = 0; pos < st.size; pos += SHRED_CHUNK) {
          const buf = make();
          await fh.write(buf, 0, Math.min(SHRED_CHUNK, st.size - pos), pos);
        }
        await fh.sync();
      }
    } finally {
      await fh.close();
    }
    const scrambled = path.join(path.dirname(file), crypto.randomBytes(8).toString('hex'));
    await fs.rename(file, scrambled);
    name = scrambled;
  } catch { /* read-only or in use: it still goes */ }
  await fs.rm(name, { force: true });
  return true;
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
    if (typeof patch.assistantComputer === 'boolean') next.assistantComputer = patch.assistantComputer;
    if (typeof patch.masterPrompt === 'string') next.masterPrompt = patch.masterPrompt.trim() || DEFAULT_MASTER_PROMPT;
    if (typeof patch.adultPrompt === 'string') next.adultPrompt = patch.adultPrompt.trim() || ADULT_CONTENT;
    if (typeof patch.comfyCleanup === 'boolean') next.comfyCleanup = patch.comfyCleanup;
    if (typeof patch.comfyOutputDir === 'string') next.comfyOutputDir = patch.comfyOutputDir.trim().slice(0, 500);
    if (typeof patch.comfyDir === 'string') next.comfyDir = patch.comfyDir.trim().slice(0, 500);
    if (typeof patch.comfyArgs === 'string') next.comfyArgs = patch.comfyArgs.trim().slice(0, 1000);
    if (typeof patch.logScrub === 'boolean') next.logScrub = patch.logScrub;
    if (typeof patch.comfyAutostart === 'boolean') next.comfyAutostart = patch.comfyAutostart;
    if (typeof patch.comfyRam === 'boolean') next.comfyRam = patch.comfyRam;
    if (typeof patch.dataRam === 'boolean') next.dataRam = patch.dataRam;
    if (PRIVACY_LEVELS.includes(patch.privacyLevel)) next.privacyLevel = patch.privacyLevel;
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
    // The built-in instructions aren't written out while they're the ones in use, so a newer version's improved
    // ones reach you; only your own edits are kept.
    const out = { ...next };
    if (out.masterPrompt.trim() === DEFAULT_MASTER_PROMPT.trim()) delete out.masterPrompt;
    if (out.adultPrompt.trim() === ADULT_CONTENT.trim()) delete out.adultPrompt;
    await writeJson(SETTINGS_FILE, out);
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

function guide(g) {
  if (!g || typeof g !== 'object') return null;
  const text = (x, n) => String(x || '').trim().slice(0, n);
  const list = (x, n) => (Array.isArray(x) ? x : []).map(y => text(y, n)).filter(Boolean).slice(0, 8);
  const out = { bestFor: text(g.bestFor, 600), youNeed: text(g.youNeed, 400), steps: list(g.steps, 400), tryThese: list(g.tryThese, 400) };
  return out.bestFor || out.youNeed || out.steps.length || out.tryThese.length ? out : null;
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
  const imageRoles = toList(input.imageRoles).filter(r => IMAGE_ROLES.includes(r) && (r !== 'animate' || kind === 'video'));
  const templates = (Array.isArray(input.comfyTemplates) ? input.comfyTemplates : [])
    .filter(t => t && /^[\w.-]{1,120}$/.test(t.name || ''))
    .slice(0, 8)
    .map(t => ({ name: t.name, title: String(t.title || t.name).trim().slice(0, 120), ...(t.note ? { note: String(t.note).trim().slice(0, 300) } : {}) }));
  return {
    id,
    name,
    kind,
    description: String(input.description || '').trim(),
    // The plain-words how-to under the model cards in step ①.
    ...(guide(input.guide) ? { guide: guide(input.guide) } : {}),
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
    // The ways an attached image can be used; unset means every role that fits the kind.
    ...(imageRoles.length ? { imageRoles } : {}),
    // Character animation (e.g. Wan Animate 2): Create takes a motion video, whose moves the character performs.
    ...(kind === 'video' && input.motionVideo === true ? { motionVideo: true } : {}),
    // The image is a person to keep (Krea 2 Character, MiniMax H3 Reference): the Brain writes their character sheet
    // once, and every take carries all of it (in the guide's section named by sheetSection, if any).
    ...(input.characterSheet === true ? { characterSheet: true, ...(/^\w{1,40}$/.test(input.sheetSection || '') ? { sheetSection: input.sheetSection } : {}) } : {}),
    // ComfyUI's own templates for this model, offered first when adding a workflow.
    ...(templates.length ? { comfyTemplates: templates } : {}),
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
  // An edited built-in saved before it had a guide borrows the shipped one.
  const tag = (item, builtin, edited, shipped) => ({ ...(shipped?.guide && !item.guide ? { guide: shipped.guide } : {}), ...item, builtin, edited });
  const isBuiltin = id => exists(builtinFile(id));
  return {
    isBuiltin,
    async list() {
      const [shipped, mine] = await Promise.all([readDir(builtinDir), readDir(userDir)]);
      const items = [];
      for (const [id, item] of mine) if (!item.deleted) items.push(tag(item, shipped.has(id), shipped.has(id), shipped.get(id)));
      for (const [id, item] of shipped) if (!mine.has(id)) items.push(tag(item, true, false));
      return items.sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(id) {
      const shipped = await readJson(builtinFile(id), null);
      const mine = await readJson(userFile(id), null);
      if (mine) return mine.deleted ? null : tag(mine, Boolean(shipped), Boolean(shipped), shipped);
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

// An image the Create form let go of, unless an entry uses it or a prompt is being written from it.
export function deleteImageIfUnused(name) {
  return locked(async () => {
    if (!/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(name || '') || busyFiles.has(name) || filesInUse(await listHistory()).images.has(name)) return false;
    await shredFile(path.join(IMAGES_DIR, name));
    return true;
  });
}

// ---------- motion videos ----------

export const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v' };
export const VIDEO_NAME = /^[a-f0-9]{20}\.(mp4|webm|mov|mkv|m4v)$/;
export const MAX_VIDEO = 500 * 1024 * 1024;

// Stores a motion video under its content hash, streamed to disk (videos can be big). Returns its name.
export async function saveVideo(stream, mime) {
  const ext = VIDEO_TYPES[String(mime || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw httpError(400, 'Unsupported video. Use MP4, WebM, MOV or MKV.');
  const tmp = path.join(VIDEOS_DIR, `upload-${crypto.randomUUID()}.tmp`);
  const hash = crypto.createHash('sha1');
  let size = 0;
  const out = await fs.open(tmp, 'w');
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_VIDEO) throw httpError(413, `That video is too big (over ${MAX_VIDEO / 1024 / 1024} MB). Trim it to the part you need.`);
      hash.update(chunk);
      await out.write(chunk);
    }
  } catch (err) {
    await out.close();
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await out.close();
  if (!size) {
    await fs.rm(tmp, { force: true });
    throw httpError(400, 'That video is empty.');
  }
  const name = `${hash.digest('hex').slice(0, 20)}.${ext}`;
  const file = path.join(VIDEOS_DIR, name);
  if (await exists(file)) {
    await fs.rm(tmp, { force: true });
    const now = new Date();
    await fs.utimes(file, now, now); // added again: counts as new for the start-up sweep
  } else {
    await fs.rename(tmp, file);
  }
  return name;
}

// A motion video, or the small preview made for the browser (<hash>.preview.mp4).
export const PREVIEW_NAME = /^[a-f0-9]{20}\.preview\.mp4$/;
export const videoPath = name => (VIDEO_NAME.test(name || '') || PREVIEW_NAME.test(name || '') ? path.join(VIDEOS_DIR, name) : null);

// ---------- history ----------

export async function listHistory() {
  return readJson(HISTORY_FILE, []);
}

export async function getHistory(id) {
  return (await listHistory()).find(e => e.id === id) || null;
}

// Entries as the page shows them: renders whose file was moved or deleted outside the app (out of the renders
// folder) are left out, so they don't show as blank tiles. Their records stay, so a file put back shows again.
export async function withPresentFiles(entries) {
  const present = new Set(await fs.readdir(RENDERS_DIR).catch(() => []));
  const gone = r => (r.files || []).some(f => !present.has(f.file));
  const one = e => (!e?.variations?.some(v => (v.renders || []).some(gone)) ? e : {
    ...e,
    variations: e.variations.map(v => (!v.renders?.some(gone) ? v : {
      ...v,
      renders: v.renders.map(r => (gone(r) ? { ...r, files: r.files.filter(f => present.has(f.file)) } : r)).filter(r => r.files.length),
    })),
  });
  return Array.isArray(entries) ? entries.map(one) : one(entries);
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
  const videos = new Set();
  const lines = new Set(); // clips of spoken lines (voice/clips)
  for (const e of entries) {
    if (e.imageFile) images.add(e.imageFile);
    if (e.line?.file) lines.add(e.line.file);
    if (e.video?.file) videos.add(e.video.file);
    if (e.video?.sheet) images.add(e.video.sheet); // the frames the Brain saw
    for (const v of e.variations || []) for (const r of v.renders || []) for (const f of r.files || []) renders.add(f.file);
  }
  return { images, renders, videos, lines };
}

// Deleting is for good: the entry, its renders and its input image (unless another entry uses the same one), and
// any trace in what stays. Takes made from its renders keep their own image but lose the link and its prompt; the
// assistant conversation and the jobs lose any quote of its theme or prompts; the files are shredded, the copy of
// History from before the delete too. Returns the entry, the entries left, and the deleted words (phrases) for
// whatever else may quote them.
export function deleteHistory(id) {
  return locked(async () => {
    const all = await listHistory();
    const entry = all.find(e => e.id === id);
    if (!entry) return { entry: null, rest: all, phrases: [] };
    const rest = all.filter(e => e.id !== id);
    for (const e of rest) if (e.source?.entryId === id) delete e.source;
    await writeJson(HISTORY_FILE, rest, { forget: true });
    const renders = entry.variations.flatMap(v => v.renders || []);
    await removeFiles(renders, entry.imageFile, rest, entry.video);
    const phrases = phrasesOf([entry.theme, entry.line?.text, ...entry.variations.flatMap(v => v.versions.map(x => x.text))]);
    await scrubFile(ASSISTANT_FILE, phrases);
    await scrubFile(JOBS_FILE, phrases);
    return { entry, rest, phrases };
  });
}

// ---------- held files ----------
// A picture or motion video can be needed before any entry uses it: it sits in the Create form, waits in the line,
// or a prompt is being written from it right now. The start-up sweep leaves all of those alone. Deleting an entry
// that shares the file leaves it to a prompt waiting in line or being written; the form lets go of a deleted
// entry's picture and video, so those go with it.

// Being used by a request right now: name → how many.
const busyFiles = new Map();

// Keeps files while a request works with them. Returns the function that lets them go.
export function holdFiles(names) {
  const mine = names.filter(Boolean);
  for (const n of mine) busyFiles.set(n, (busyFiles.get(n) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const n of mine) { if (busyFiles.get(n) > 1) busyFiles.set(n, busyFiles.get(n) - 1); else busyFiles.delete(n); }
  };
}

const HELD_NAME = /^[a-f0-9]{20}\.(jpg|png|webp|mp4|webm|mov|mkv|m4v)$/;

// What a browser's Create page holds now, replacing what it said before: form (what step ③ shows) and line (what
// the prompts waiting in line use). A browser not heard from in 90 days no longer counts.
export function setHolds(client, { form, line } = {}) {
  return locked(async () => {
    if (!/^[\w-]{8,64}$/.test(client || '')) throw httpError(400, 'Invalid client.');
    const names = list => [...new Set((Array.isArray(list) ? list : []).filter(f => HELD_NAME.test(f || '')))].slice(0, 500);
    const all = await readJson(HOLDS_FILE, {}).catch(() => ({}));
    const cutoff = Date.now() - 90 * 864e5;
    for (const [id, h] of Object.entries(all)) if (!(Date.parse(h?.at) > cutoff)) delete all[id];
    all[client] = { at: new Date().toISOString(), form: names(form), line: names(line) };
    await writeJson(HOLDS_FILE, all);
    return all[client];
  });
}

// form: also what the Create forms show (the sweep), not only what a prompt in line or being written needs.
async function heldFiles({ form = false } = {}) {
  const all = await readJson(HOLDS_FILE, {}).catch(() => ({}));
  return new Set([...busyFiles.keys(), ...Object.values(all).flatMap(h => [...(h?.line || []), ...(form ? h?.form || [] : [])])]);
}

async function removeFiles(renders, imageFile, rest, video = null) {
  const used = filesInUse(rest);
  const held = await heldFiles();
  await removeRenderFiles(renders, used.renders);
  for (const image of [imageFile, video?.sheet]) {
    if (/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(image || '') && !used.images.has(image) && !held.has(image)) await shredFile(path.join(IMAGES_DIR, image));
  }
  if (VIDEO_NAME.test(video?.file || '') && !used.videos.has(video.file) && !held.has(video.file)) {
    await shredFile(videoPath(video.file));
    await shredFile(path.join(VIDEOS_DIR, `${video.file.slice(0, 20)}.preview.mp4`));
  }
}

export async function removeRenderFiles(renders, keep = new Set()) {
  for (const r of renders) {
    for (const f of r.files || []) {
      if (/^[\w-]+\.\w+$/.test(f.file) && !keep.has(f.file)) await shredFile(path.join(RENDERS_DIR, f.file));
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
    await writeJson(HISTORY_FILE, all, { forget: true });
    await removeFiles([removed], null, all);
    return { entry, removed, rest: all };
  });
}

// The words of a deleted entry: its theme, its spoken line, each prompt, and each one's first 140 characters (what
// the assistant is shown of a prompt). tails: the pieces LM Studio's log keeps of a long text, the first and last
// 50 characters of it as JSON writes it ("... <Truncated in logs> ..." between). Anything shorter than 12
// characters is too common to replace.
const LOG_KEEP = 50;
export function phrasesOf(texts, { tails = false } = {}) {
  const clean = texts.map(t => String(t || '').trim()).filter(t => t.length >= 12);
  const forms = t => {
    const esc = JSON.stringify(t).slice(1, -1);
    return [t, t.slice(0, 140), ...(tails ? [t.slice(0, LOG_KEEP), t.slice(-LOG_KEEP), esc.slice(0, LOG_KEEP), esc.slice(-LOG_KEEP)] : [])];
  };
  return [...new Set(clean.flatMap(forms))].filter(t => t.length >= 12);
}

// Replaces the phrases with "[deleted]" in a text, also where they sit inside JSON (escaped), longest first.
export function scrubText(text, phrases) {
  if (typeof text !== 'string' || !phrases.length) return text;
  const forms = [...new Set(phrases.flatMap(p => [p, JSON.stringify(p).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  return forms.reduce((acc, p) => (acc.includes(p) ? acc.split(p).join('[deleted]') : acc), text);
}

// Replaces the phrases in a text file in place (the program that writes the file may keep it open to append to it,
// so a new file in its place would be left behind with the words still in it). Returns whether it changed; a file
// too big to hold in memory is left alone.
const TEXT_MAX = 256 << 20;
export async function scrubTextFile(file, phrases) {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile() || !phrases.length) return false;
  if (st.size > TEXT_MAX) { console.warn(`${file} is too big to scrub.`); return false; }
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return false;
  const out = scrubText(text, phrases);
  if (out === text) return false;
  const fh = await fs.open(file, 'r+');
  try {
    const buf = Buffer.from(out, 'utf8');
    await fh.write(buf, 0, buf.length, 0);
    await fh.truncate(buf.length);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

const scrubDeep = (value, phrases) => {
  if (typeof value === 'string') return scrubText(value, phrases);
  if (Array.isArray(value)) return value.map(v => scrubDeep(v, phrases));
  if (value && typeof value === 'object') for (const k of Object.keys(value)) value[k] = scrubDeep(value[k], phrases);
  return value;
};

// Replaces quotes of deleted words wherever a JSON file (the assistant conversation, the jobs' plans and logs) has
// them, tool calls' JSON included. The copy from before is shredded with the words still in it.
async function scrubFile(file, phrases) {
  const data = await readJson(file, null);
  if (!phrases.length || data === null) return;
  const before = JSON.stringify(data);
  const after = scrubDeep(data, phrases);
  if (JSON.stringify(after) !== before) await writeJson(file, after, { forget: true });
}

// At start-up, removes what nothing in History uses anymore: leftovers of deletes from older versions, of a render
// interrupted between saving its file and its entry, or of a save cut short. An unused image or video goes after a
// day (it may have just been added), unless a Create page still holds it; before any page has said what it holds,
// none of them go. Nothing is swept without a history file to compare with.
export async function sweepOrphans() {
  if (!(await exists(HISTORY_FILE))) return 0;
  const used = filesInUse(await listHistory());
  // A History that couldn't be read was set aside: what its entries used must not be taken for leftovers.
  if ((await fs.readdir(SESSION_DIR)).some(name => name.startsWith(`${path.basename(HISTORY_FILE)}.damaged-`))) return 0;
  const pagesKnown = await exists(HOLDS_FILE);
  const held = await heldFiles({ form: true });
  const dayAgo = Date.now() - 864e5;
  let removed = 0;
  const sweep = async (dir, keep, old = () => true) => {
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile() || keep(name) || !old(st)) continue;
      await shredFile(file);
      removed++;
    }
  };
  await sweep(RENDERS_DIR, name => used.renders.has(name));
  await sweep(IMAGES_DIR, name => !pagesKnown || used.images.has(name) || held.has(name), st => st.mtimeMs < dayAgo);
  const usedVideos = new Set([...used.videos, ...held].map(name => name.slice(0, 20))); // a preview goes with its video
  await sweep(VIDEOS_DIR, name => !pagesKnown || usedVideos.has(name.slice(0, 20)), st => st.mtimeMs < dayAgo);
  await sweep(SESSION_DIR, name => !name.endsWith('.tmp'), st => st.mtimeMs < Date.now() - 6e5);
  if (IN_MEMORY) await sweep(DATA_DIR, name => !name.endsWith('.tmp'), st => st.mtimeMs < Date.now() - 6e5);
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

// ---------- your renders: your order ----------
// The cards of 🎞 Your renders in the order you dragged them, as "render id/file name" keys. Renders that aren't in
// it (made since) come first, newest first. Empty: newest first.

export async function getRenderOrder() {
  const data = await readJson(ORDER_FILE, {});
  return { order: Array.isArray(data.order) ? data.order : [] };
}

export function saveRenderOrder(order) {
  const keys = (Array.isArray(order) ? order : []).map(String).filter(k => k.length <= 300 && /^[\w-]+\/[^/\\]+$/.test(k));
  return locked(() => writeJson(ORDER_FILE, { order: [...new Set(keys)].slice(0, 100000) }));
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

// ---------- jobs (the assistant's long tasks) ----------
// The page runs a job and saves it here after every step, so its log survives reloads. Newest first, at most 30.

const JOBS_MAX = 30;
export async function listJobs() {
  const data = await readJson(JOBS_FILE, {});
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export function saveJob(job) {
  if (!job || typeof job !== 'object' || !/^[\w-]{1,64}$/.test(job.id || '')) throw httpError(400, 'A job needs an id.');
  if (JSON.stringify(job).length > 2e6) throw httpError(413, 'That job is too big to save.');
  return locked(async () => {
    const jobs = await listJobs();
    const i = jobs.findIndex(j => j.id === job.id);
    if (i >= 0) jobs[i] = job; else jobs.unshift(job);
    await writeJson(JOBS_FILE, { jobs: jobs.slice(0, JOBS_MAX) });
    return job;
  });
}

export function deleteJob(id) {
  return locked(async () => {
    const jobs = await listJobs();
    await writeJson(JOBS_FILE, { jobs: jobs.filter(j => j.id !== id) }, { forget: true });
  });
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
