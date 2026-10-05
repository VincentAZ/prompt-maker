// ComfyUI workflows attached to target models: storage, automatic input mapping, and building
// the exact prompt to queue (your text, image, size, duration and a fresh seed dropped in).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, httpError } from './store.js';
import { sanitizeLinks } from './models.js';

const DIR = path.join(DATA_DIR, 'workflows');
export const EXPORT_FORMAT = 'prompt-maker-workflow';

export async function initWorkflows() {
  await fs.mkdir(DIR, { recursive: true });
}

const fileOf = id => path.join(DIR, `${String(id).replace(/[^\w-]/g, '')}.json`);

async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; // unique, so overlapping saves can't collide
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export async function listWorkflows() {
  const out = [];
  for (const f of (await fs.readdir(DIR)).filter(x => x.endsWith('.json'))) {
    try {
      const w = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8'));
      out.push(summary(w));
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The main sampler settings (first of each kind), with overrides applied, for the render bar.
function settingsAtAGlance(w) {
  const params = samplerParams(w.prompt || {});
  const pick = kind => params.find(p => p.kind === kind);
  const valueOf = p => (p ? (w.overrides?.[`${p.node}|${p.input}`] ?? p.value) : null);
  const seed = pick('seed');
  return {
    sampler: valueOf(pick('sampler')),
    scheduler: valueOf(pick('scheduler')),
    steps: valueOf(pick('steps')),
    cfg: valueOf(pick('cfg')),
    denoise: valueOf(pick('denoise')),
    seed: !seed ? null : seedState(w).mode === 'random' ? 'random' : seedState(w).value,
  };
}

export function summary(w) {
  const m = w.mapping || {};
  return {
    settings: settingsAtAGlance(w),
    loras: {
      nodes: loraGroups(w.prompt || {}).leads.map(({ key, name, title, strength, on, pieces }) => ({ key, name, title, strength, on, pieces })),
      tweaks: w.loras?.tweaks || {},
      added: w.loras?.added || [],
    },
    id: w.id,
    modelId: w.modelId,
    name: w.name,
    source: w.source || '',
    sourceModified: w.sourceModified ?? null,
    seed: seedState(w),
    overrides: w.overrides || {}, // sampler settings changed from the workflow's own (restored with an entry from History)
    // How much an image-to-image render may change the input image (0–1), where the workflow has it.
    denoise: samplerParams(w.prompt || {}).filter(p => p.kind === 'denoise').map(p => ({ key: `${p.node}|${p.input}`, title: p.title, original: p.value, value: w.overrides?.[`${p.node}|${p.input}`] ?? p.value })),
    nodes: Object.keys(w.prompt || {}).length,
    motionFrames: clipFrames(w.prompt || {}), // how much of a motion video it animates (character animation)
    background: backgroundOf(w), // whose background a character animation keeps (SCAIL 2), where it can be picked
    maps: {
      prompt: Boolean(m.prompt?.length),
      motion: Boolean(m.motion?.length),
      image: Boolean(m.image),
      video: Boolean(m.video),
      size: Boolean((m.width && m.height) || m.aspect),
      duration: Boolean(m.frames || m.seconds),
      seed: Boolean(m.seed?.length),
    },
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export async function getWorkflow(id) {
  try {
    return JSON.parse(await fs.readFile(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

// The workflow with the LoRAs and sampler settings a run was queued with, not the ones it has now.
export function withSetup(w, setup) {
  if (!w || !setup || typeof setup !== 'object') return w;
  return { ...w, loras: sanitizeLoras(setup.loras, w.prompt), overrides: sanitizeOverrides(setup.overrides, w.prompt) };
}

export async function saveWorkflow(input, existing = null) {
  const now = new Date().toISOString();
  const w = {
    id: existing?.id || crypto.randomUUID(),
    modelId: String(input.modelId ?? existing?.modelId ?? ''),
    name: String(input.name ?? existing?.name ?? 'Workflow').trim().slice(0, 120) || 'Workflow',
    source: String(input.source ?? existing?.source ?? ''),
    // When the ComfyUI file was last saved as of this copy (ms), to notice later edits made in ComfyUI.
    sourceModified: Number.isFinite(Number(input.sourceModified)) && input.sourceModified !== null ? Number(input.sourceModified) : (existing?.sourceModified ?? null),
    prompt: input.prompt ?? existing?.prompt,
    mapping: sanitizeMapping(input.mapping ?? existing?.mapping, input.prompt ?? existing?.prompt),
    options: sanitizeOptions({ ...existing?.options, ...input.options }),
    overrides: sanitizeOverrides(input.overrides ?? existing?.overrides, input.prompt ?? existing?.prompt),
    loras: sanitizeLoras(input.loras ?? existing?.loras, input.prompt ?? existing?.prompt),
    models: sanitizeLinks(input.models ?? existing?.models), // download links for its model files, from the workflow
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (!w.modelId) throw httpError(400, 'A workflow must belong to a model.');
  if (!w.prompt || typeof w.prompt !== 'object') throw httpError(400, 'The workflow is empty.');
  if (!w.mapping.prompt.length) throw httpError(400, 'Pick where the prompt text goes.');
  await writeJson(fileOf(w.id), w);
  return w;
}

// A new version of a workflow (edited in ComfyUI, or a new file): keep your setup wherever it still fits,
// and fill the rest from a fresh analysis. lost: the slots you had set that no longer exist.
export function carryOver(existing, prompt, suggested) {
  const mine = sanitizeMapping(existing.mapping, prompt);
  const fresh = sanitizeMapping(suggested, prompt);
  const isSet = v => (Array.isArray(v) ? v.length > 0 : Boolean(v));
  const mapping = {};
  const lost = [];
  for (const key of Object.keys(mine)) {
    mapping[key] = isSet(mine[key]) ? mine[key] : fresh[key];
    if (key !== 'seed' && isSet(existing.mapping?.[key]) && !isSet(mine[key])) lost.push(key);
  }
  // A randomized seed covers every seed input, including new ones.
  mapping.seed = fresh.seed; // every seed input, so the seed mode reaches all of them
  const overrides = sanitizeOverrides(existing.overrides, prompt);
  const loras = sanitizeLoras(existing.loras, prompt);
  const before = existing.prompt || {};
  const changes = {
    added: Object.keys(prompt).filter(id => !before[id]).length,
    removed: Object.keys(before).filter(id => !prompt[id]).length,
    changed: Object.keys(prompt).filter(id => before[id] && JSON.stringify(before[id]) !== JSON.stringify(prompt[id])).length,
    droppedTweaks: Object.keys(existing.overrides || {}).filter(k => !(k in overrides)).length,
  };
  return { mapping, overrides, loras, lost, changes };
}

export async function deleteWorkflow(id) {
  await fs.rm(fileOf(id), { force: true });
}

export async function deleteWorkflowsForModel(modelId) {
  for (const w of await listWorkflows()) if (w.modelId === modelId) await deleteWorkflow(w.id);
}

const target = t => (t && typeof t.node === 'string' && typeof t.input === 'string' ? { node: t.node, input: t.input } : null);
function sanitizeMapping(m = {}, prompt = {}) {
  const exists = t => t && prompt[t.node] && t.input in prompt[t.node].inputs;
  const one = t => (exists(target(t)) ? target(t) : null);
  const many = list => (Array.isArray(list) ? list.map(target).filter(exists) : []);
  return {
    prompt: many(m.prompt),
    motion: many(m.motion), // the Motion line of a character-animation prompt (e.g. Wan Animate 2's pose prompt)
    image: one(m.image),
    video: one(m.video), // the motion video (a Load Video node)
    width: one(m.width),
    height: one(m.height),
    aspect: one(m.aspect),
    frames: one(m.frames),
    seconds: one(m.seconds),
    fps: one(m.fps),
    seed: many(m.seed),
  };
}

// Sampler tweaks: { "node|input": value }, kept only for real sampler inputs with sensible values.
function sanitizeOverrides(o = {}, prompt = {}) {
  const out = {};
  const params = new Map(samplerParams(prompt).map(p => [`${p.node}|${p.input}`, p]));
  const switches = new Set(backgroundSwitches(prompt).map(t => `${t.node}|${t.input}`));
  for (const [key, value] of Object.entries(o || {})) {
    if (switches.has(key)) { if (typeof value === 'boolean') out[key] = value; continue; }
    const p = params.get(key);
    if (!p) continue;
    if (p.kind === 'sampler' || p.kind === 'scheduler') {
      if (typeof value === 'string' && value && (!p.options || p.options.includes(value))) out[key] = value;
    } else if (Number.isFinite(Number(value))) {
      const n = Number(value);
      if (p.kind === 'seed') out[key] = Math.max(0, Math.floor(n));
      else if (p.kind === 'denoise' || p.kind === 'poseStart' || p.kind === 'poseEnd') out[key] = Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
      else if (p.kind === 'pose' || p.kind === 'identity') out[key] = Math.round(Math.min(10, Math.max(0, n)) * 100) / 100;
      else if (p.kind === 'steps') out[key] = Math.min(1000, Math.max(1, Math.round(n)));
      else out[key] = Math.min(100, Math.max(0, n));
    }
  }
  return out;
}

export const SEED_MODES = ['random', 'fixed', 'increment', 'decrement'];
const seedNumber = v => (v !== null && v !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);

// seedMode works like ComfyUI's "control after generate": a new random seed each render, always the same one,
// or one higher / lower each render. seed is the next seed to use (not for random); lastSeed the last one used.
function sanitizeOptions(o = {}) {
  const seedMode = SEED_MODES.includes(o.seedMode) ? o.seedMode : o.randomizeSeed === false ? 'fixed' : 'random';
  return {
    snap: [1, 8, 16, 32, 64].includes(Number(o.snap)) ? Number(o.snap) : 16,
    frameRule: ['exact', '8n+1', '4n+1'].includes(o.frameRule) ? o.frameRule : 'exact',
    fps: Number(o.fps) > 0 ? Number(o.fps) : 24,
    randomizeSeed: seedMode === 'random',
    seedMode,
    seed: seedNumber(o.seed),
    lastSeed: seedNumber(o.lastSeed),
  };
}

// The workflow's own seed value (with an older seed override applied), the starting point before you pick one.
function workflowSeed(w) {
  const p = samplerParams(w.prompt || {}).find(x => x.kind === 'seed');
  return p ? seedNumber(w.overrides?.[`${p.node}|${p.input}`] ?? p.value) : null;
}

export function seedState(w) {
  const o = sanitizeOptions(w.options);
  return { mode: o.seedMode, value: o.seed ?? workflowSeed(w) ?? 0, last: o.lastSeed, inputs: samplerParams(w.prompt || {}).filter(x => x.kind === 'seed').length };
}

// Hands out the seeds for the next `count` renders and moves the workflow on (increment / decrement),
// one call at a time, so renders started together never share a seed. fresh: a new random seed regardless.
let seedQueue = Promise.resolve();
export function takeSeeds(id, count, { fresh = false } = {}) {
  const run = seedQueue.then(async () => {
    const w = await getWorkflow(id);
    if (!w) return Array(count).fill(null);
    const s = seedState(w);
    const mode = fresh ? 'random' : s.mode;
    const seeds = Array.from({ length: count }, (_, i) => (mode === 'random' ? randomSeed() : mode === 'decrement' ? Math.max(0, s.value - i) : s.value + i));
    const options = { ...w.options, lastSeed: seeds.at(-1) };
    if (mode === 'increment') options.seed = s.value + count;
    if (mode === 'decrement') options.seed = Math.max(0, s.value - count);
    await writeJson(fileOf(id), { ...w, options: sanitizeOptions(options) });
    return seeds;
  });
  seedQueue = run.catch(() => {});
  return run;
}

// ---------- automatic mapping ----------

const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
const FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|png|jpe?g|webp|gif|mp4|webm|mov|wav|mp3|flac|json|yaml)$/i;
const NOT_TEXT = /^(filename_.*|output_path|format|codec|.*_name|sampler.*|scheduler|type|device|weight_dtype|mode|method|upscale_method|crop|direction|image|video|audio|expression|save_output|pix_fmt|find|replace|pattern|regex|delimiter|separator|suffix|prefix|stack_data|background_color|color|.*\..*)$/i;
const NEGATIVE_WORDS = /\b(worst quality|low quality|lowres|blurry|ugly|deformed|watermark|jpeg artifacts|bad anatomy|bad hands|disfigured|cartoon|pc game|video game|oversaturated|signature)\b/gi;

function isComboInput(objectInfo, classType, input) {
  const spec = objectInfo?.[classType]?.input?.required?.[input] ?? objectInfo?.[classType]?.input?.optional?.[input];
  return Boolean(spec && (Array.isArray(spec[0]) || spec[0] === 'COMBO' || String(spec[0]).startsWith('COMFY_DYNAMICCOMBO')));
}

const titleOf = (prompt, id) => prompt[id]?._meta?.title || prompt[id]?.class_type || id;
const label = (prompt, id, input) => `#${id} ${titleOf(prompt, id)} → ${input}`;

// Nodes upstream of a sampler's positive (or negative) input. Nodes that carry both branches
// (e.g. LTXVConditioning, CFG guides) output positive on slot 0 and negative on slot 1, so the
// walk only follows the matching branch through them.
function upstream(prompt, startId, inputName) {
  const start = prompt[startId]?.inputs?.[inputName];
  const seen = new Map();
  const queue = isLink(start) ? [[start[0], start[1], 1, inputName]] : [];
  while (queue.length) {
    const [id, slot, depth, branch] = queue.shift();
    if (seen.has(id) || !prompt[id]) continue;
    seen.set(id, depth);
    const inputs = prompt[id].inputs;
    const both = isLink(inputs.positive) && isLink(inputs.negative);
    const follow = both ? (slot === 1 ? 'negative' : 'positive') : null;
    for (const [name, v] of Object.entries(inputs)) {
      if (!isLink(v)) continue;
      if (both && (name === 'positive' || name === 'negative') && name !== follow) continue;
      queue.push([v[0], v[1], depth + 1, follow || branch]);
    }
  }
  return seen;
}

const PARAM_KINDS = [
  ['seed', /^(noise_)?seed$|_seed$/],
  ['steps', /^steps$|_steps$/],
  ['cfg', /^cfg$|_cfg$|^cfg_|^guidance$/],
  ['sampler', /^sampler_name$|_sampler_name$|^sampler$/],
  ['scheduler', /^scheduler$|_scheduler$/],
  ['denoise', /^denoise$|_denoise$/],
  // Character animation (Wan Animate 2): how strongly the motion video and the character image steer the result.
  ['pose', /^pose_strength$/],
  ['poseStart', /^pose_start_percent$/],
  ['poseEnd', /^pose_end_percent$/],
  ['identity', /^reference_image_strength$/],
];

// Seed / steps / CFG / sampler / scheduler inputs, in node order: what the user can tweak per workflow.
export function samplerParams(prompt, objectInfo = null) {
  const out = [];
  for (const [id, node] of Object.entries(prompt)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue;
      const lower = input.toLowerCase();
      const kind = PARAM_KINDS.find(([, re]) => re.test(lower))?.[0];
      if (!kind) continue;
      const isText = typeof value === 'string';
      if ((kind === 'sampler' || kind === 'scheduler') !== isText) continue;
      if (kind !== 'sampler' && kind !== 'scheduler' && typeof value !== 'number') continue;
      if (kind === 'seed' && /random_seed/.test(lower) && !/sampler|noise/i.test(node.class_type)) continue;
      const spec = objectInfo?.[node.class_type]?.input?.required?.[input] ?? objectInfo?.[node.class_type]?.input?.optional?.[input];
      const options = Array.isArray(spec?.[0]) ? spec[0] : Array.isArray(spec?.[1]?.options) && typeof spec[1].options[0] === 'string' ? spec[1].options : null;
      out.push({ node: id, input, kind, value, options, title: titleOf(prompt, id), classType: node.class_type });
    }
  }
  return out;
}

// Which nodes feed a sampler's positive and negative inputs (and a pose prompt), each with its distance.
function branches(prompt) {
  const positive = new Map();
  const negative = new Map();
  const motion = new Map(); // text feeding a pose-video prompt (Wan Animate 2's positive_pose)
  for (const [id, node] of Object.entries(prompt)) {
    if (isLink(node.inputs.positive_pose)) for (const [n, d] of upstream(prompt, id, 'positive_pose')) motion.set(n, Math.min(d, motion.get(n) ?? 99));
    if (isLink(node.inputs.positive)) for (const [n, d] of upstream(prompt, id, 'positive')) positive.set(n, Math.min(d, positive.get(n) ?? 99));
    if (isLink(node.inputs.negative)) for (const [n, d] of upstream(prompt, id, 'negative')) negative.set(n, Math.min(d, negative.get(n) ?? 99));
    if (isLink(node.inputs.conditioning) && /Guider/.test(node.class_type)) for (const [n, d] of upstream(prompt, id, 'conditioning')) positive.set(n, Math.min(d, positive.get(n) ?? 99));
  }
  return { positive, negative, motion };
}

// Copies of an input in other copies of the same part: same kind of node, same title, same value, in another subgraph
// (node ids "213:3" and "262:258"). A workflow that renders in pieces (a long video in 81-frame parts, each a copy of
// the same subgraph) has one per piece, and every piece needs the same prompt, size and frame count. Never two nodes
// side by side (a first and a last frame), and never a copy on the negative side only.
const partOf = id => (id.includes(':') ? id.slice(0, id.lastIndexOf(':')) : null);
export function twinsOf(prompt, t, negative = branches(prompt)) {
  const n = prompt[t?.node];
  const v = n?.inputs?.[t.input];
  if (!partOf(t.node) || v === undefined || v === '' || isLink(v) || (v && typeof v === 'object')) return [];
  const title = titleOf(prompt, t.node);
  return Object.entries(prompt)
    .filter(([id, m]) => partOf(id) && partOf(id) !== partOf(t.node) && m.class_type === n.class_type && titleOf(prompt, id) === title && m.inputs?.[t.input] === v)
    .filter(([id]) => !(negative.negative.has(id) && !negative.positive.has(id)))
    .map(([id]) => ({ node: id, input: t.input }));
}

// SCAIL 2's replacement_mode, which picks whose background the render keeps: on, the motion video's (the character
// replaces its performer); off, the character image's (the image is animated). Returns where it is set: the input
// itself, or the boolean node it is wired to, once each.
export function backgroundSwitches(prompt) {
  const out = new Map();
  for (const [id, node] of Object.entries(prompt || {})) {
    const v = node.inputs?.replacement_mode;
    if (typeof v === 'boolean') out.set(`${id}|replacement_mode`, { node: id, input: 'replacement_mode', value: v });
    else if (isLink(v)) {
      const src = prompt[v[0]];
      const input = src && Object.keys(src.inputs || {}).find(k => typeof src.inputs[k] === 'boolean');
      if (input) out.set(`${v[0]}|${input}`, { node: v[0], input, value: src.inputs[input] });
    }
  }
  return [...out.values()];
}

// Whose background a render keeps ('video' or 'picture'), the workflow's own and with your choice, or null when the
// workflow has no such switch.
function backgroundOf(w) {
  const t = backgroundSwitches(w.prompt);
  if (!t.length) return null;
  const key = x => `${x.node}|${x.input}`;
  const word = on => (on ? 'video' : 'picture');
  return { keys: t.map(key), original: word(t[0].value), value: word(w.overrides?.[key(t[0])] ?? t[0].value) };
}

// A character-animation workflow (Wan Animate 2, SCAIL): a node takes the character as reference_image and the moves
// as pose_video.
export const animatesCharacter = prompt => Object.values(prompt || {}).some(n => 'reference_image' in (n.inputs || {}) && 'pose_video' in (n.inputs || {}));

// How many frames of the motion video a character-animation workflow animates: 'all' when it loops over the whole
// video (ComfyUI's Wan Animate 2 template), else the frames of its pieces (81 each, less the frames each next piece
// repeats to carry the motion on), or null when it can't be told (or it isn't character animation).
const LOOP = /^(StartLoop|EndLoop)$|ForLoop|WhileLoop/;
// A frame count: a number, a primitive, or the size of a batch cut from the video (ImageFromBatch's length).
function frameCount(prompt, v, depth = 0) {
  if (typeof v === 'number') return v;
  if (!isLink(v) || depth > 8) return null;
  const n = prompt[v[0]];
  if (!n) return null;
  const i = n.inputs || {};
  if (/^GetImageSize/.test(n.class_type)) return v[1] === 2 ? frameCount(prompt, i.image, depth + 1) : null; // its 3rd output: the batch size
  if (/FromBatch/.test(n.class_type)) return frameCount(prompt, i.length, depth + 1);
  if (/Resize|Scale|Crop|Upscale/i.test(n.class_type)) return frameCount(prompt, i.input ?? i.image ?? i.images, depth + 1);
  if (/Primitive|^Int/.test(n.class_type) && typeof i.value === 'number') return i.value;
  return null;
}
const characterNodes = prompt => Object.keys(prompt).filter(id => 'reference_image' in (prompt[id].inputs || {}) && 'pose_video' in (prompt[id].inputs || {}));
// How many frames a piece repeats from the one before (to carry the motion on).
const repeatsOf = i => (isLink(i.previous_frames) ? (typeof i.previous_frame_count === 'number' ? i.previous_frame_count : 5) : isLink(i.continue_motion) ? 1 : 0);

export function clipFrames(prompt) {
  const pieces = characterNodes(prompt);
  if (!pieces.length) return null;
  if (pieces.some(id => [...ancestors(prompt, id)].some(a => LOOP.test(prompt[a].class_type)))) return 'all';
  if (extendPlan(prompt)) return 'all'; // more pieces are added to cover the video
  let total = 0;
  for (const id of pieces) {
    const frames = frameCount(prompt, prompt[id].inputs.length);
    if (!frames) return null;
    total += frames - repeatsOf(prompt[id].inputs);
  }
  return total;
}

// A workflow made of pieces in a chain (SCAIL 2's "Extend", Wan Animate 2 subgraphs chained by hand): each piece a
// subgraph that carries on from the one before, the pieces joined by a Batch node. Prompt Maker can add pieces like the
// last one to cover a longer video. Returns how, or null:
//   part / prev   the last piece's subgraph and the one before it (node ids "262:…" and "213:…")
//   length, step  frames per piece, and how many a further piece adds (less the frames it repeats)
//   join          the Batch node's input that takes the last piece, to add one like it per new piece
//   window        a number in the last piece that says which piece it is (SCAIL counts its windows), or null
export function extendPlan(prompt) {
  const pieces = characterNodes(prompt).filter(id => partOf(id));
  if (pieces.length < 2) return null;
  const linkPart = (id, input) => { const v = prompt[id].inputs[input]; return isLink(v) ? [...ancestors(prompt, v[0]), v[0]].map(partOf).find(Boolean) : null; };
  // The last piece: carries on from another piece, and no piece carries on from it.
  const before = new Map(pieces.map(id => [id, linkPart(id, 'previous_frames') || linkPart(id, 'continue_motion')]));
  const last = pieces.find(id => before.get(id) && before.get(id) !== partOf(id) && !pieces.some(o => before.get(o) === partOf(id)));
  if (!last) return null;
  const part = partOf(last);
  const prev = before.get(last);
  const length = frameCount(prompt, prompt[last].inputs.length);
  const repeats = repeatsOf(prompt[last].inputs);
  if (!length || length - repeats < 1) return null;
  // The Batch node joining the pieces, and its input that takes this one.
  let join = null;
  for (const [id, n] of Object.entries(prompt)) {
    if (partOf(id) === part || !/Batch/i.test(n.class_type)) continue;
    const key = Object.keys(n.inputs).find(k => /^images\.image\d+$/.test(k) && isLink(n.inputs[k]) && partOf(n.inputs[k][0]) === part);
    if (key) join = { node: id, input: key };
  }
  if (!join) return null;
  const nodes = Object.keys(prompt).filter(id => partOf(id) === part);
  // A primitive in the last piece holding its number (2 for the second), that feeds where it cuts the video.
  const number = pieces.length;
  const window = nodes.find(id => /Primitive|^Int/.test(prompt[id].class_type) && prompt[id].inputs.value === number
    && Object.entries(prompt).some(([c, n]) => partOf(c) === part && Object.values(n.inputs).some(v => isLink(v) && v[0] === id))) || null;
  return { part, prev, nodes, pieces: pieces.length, length, step: length - repeats, join, window };
}

// Adds pieces like the last one until the workflow covers videoFrames, each carrying on from the one before (what the
// last piece took from the piece before it, a new one takes from the piece before it), and joins them to the rest.
// Returns how many pieces it makes in all.
function extendPieces(prompt, videoFrames) {
  const plan = extendPlan(prompt);
  if (!plan || !(videoFrames > 0)) return null;
  const { part, prev, nodes, pieces, length, step, join } = plan;
  const covered = length + (pieces - 1) * step; // roughly: the first piece may differ, but it's the same template
  const joined = Object.keys(prompt[join.node].inputs).filter(k => /^images\.image\d+$/.test(k)).length;
  const add = Math.max(0, Math.min(Math.ceil((videoFrames - covered) / step), 50 - joined)); // a Batch node takes 50
  const suffix = id => id.slice(id.lastIndexOf(':') + 1);
  // What the last piece takes from the piece before: in a new piece, the same kind of node in the piece before it.
  const downstream = new Set(nodes.filter(id => [...ancestors(prompt, id)].some(a => characterNodes(prompt).includes(a) && partOf(a) === part) || characterNodes(prompt).includes(id)));
  const analog = src => nodes.filter(id => prompt[id].class_type === prompt[src]?.class_type && downstream.has(id));
  // Nodes the same in every piece (the model, its LoRAs, the character's own tracking) are shared, not copied: only
  // what depends on which piece it is (its stretch of the video, the piece before it) is.
  const memo = new Map();
  const varies = id => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false);
    const v = id === plan.window || Object.values(prompt[id].inputs).some(x => isLink(x) && (partOf(x[0]) === prev || (partOf(x[0]) === part && varies(x[0]))));
    memo.set(id, v);
    return v;
  };
  const copied = nodes.filter(varies);
  let from = part;
  for (let k = 1; k <= add; k++) {
    const to = `pm${k}`;
    for (const id of copied) {
      const node = structuredClone(prompt[id]);
      for (const [input, v] of Object.entries(node.inputs)) {
        if (!isLink(v)) continue;
        if (partOf(v[0]) === part) { if (varies(v[0])) node.inputs[input] = [`${to}:${suffix(v[0])}`, v[1]]; }
        else if (partOf(v[0]) === prev) {
          const [match] = analog(v[0]);
          if (match) node.inputs[input] = [`${from}:${suffix(match)}`, v[1]];
        }
      }
      prompt[`${to}:${suffix(id)}`] = node;
    }
    if (plan.window) prompt[`${to}:${suffix(plan.window)}`].inputs.value = pieces + k;
    const src = prompt[join.node].inputs[join.input];
    prompt[join.node].inputs[`images.image${joined + k - 1}`] = [`${to}:${suffix(src[0])}`, src[1]];
    from = to;
  }
  return pieces + add;
}

// A video made in pieces ends in a Batch node gluing every piece's frames together, Create Video and Save Video. Glued
// in ComfyUI, the whole video's frames are copied into one block in a single step (13 GB for 35 pieces at 896×480),
// more than the 10 GB ComfyUI keeps free, and it's killed for running out of memory as the render finishes. Instead
// each piece gets its own Create Video and Save Video, and Prompt Maker joins the saved pieces (videotools.join).
// Returns { saves: the Save Video node of each piece, in order; audio: whether the video had the motion video's
// sound }, or null when the workflow doesn't end that way.
export function splitPieces(prompt, joinId) {
  const allUsers = id => Object.keys(prompt).filter(c => Object.values(prompt[c].inputs).some(v => isLink(v) && v[0] === id));
  // Nodes that save nothing (ComfyUI skips them) don't count, and go with the join.
  const saves = id => SAVE_NODE.test(prompt[id].class_type) || allUsers(id).some(saves);
  const dead = id => allUsers(id).filter(c => !saves(c));
  const users = id => allUsers(id).filter(saves);
  const join = prompt[joinId];
  const [create, ...others] = join ? users(joinId) : [];
  if (!create || others.length || prompt[create].class_type !== 'CreateVideo') return null;
  const [save, ...more] = users(create);
  if (!save || more.length || prompt[save].class_type !== 'SaveVideo') return null;
  const order = k => Number(k.slice('images.image'.length));
  const keys = Object.keys(join.inputs).filter(k => /^images\.image\d+$/.test(k) && isLink(join.inputs[k])).sort((a, b) => order(a) - order(b));
  if (keys.length < 2) return null;
  const { audio, ...videoInputs } = prompt[create].inputs; // the sound goes on once the pieces are joined
  const prefix = String(prompt[save].inputs.filename_prefix || 'video/ComfyUI');
  const gone = [joinId, create, save, ...dead(joinId), ...dead(create)];
  const pieceSaves = keys.map((key, k) => {
    const n = String(k + 1).padStart(3, '0');
    prompt[`pmvideo${n}`] = { ...structuredClone(prompt[create]), inputs: { ...structuredClone(videoInputs), images: join.inputs[key] } };
    prompt[`pmsave${n}`] = {
      ...structuredClone(prompt[save]),
      inputs: { ...structuredClone(prompt[save].inputs), filename_prefix: `${prefix}_piece${n}`, video: [`pmvideo${n}`, 0] },
      _meta: { title: `Save Video (piece ${k + 1})` },
    };
    return `pmsave${n}`;
  });
  const drop = id => { for (const c of allUsers(id)) drop(c); delete prompt[id]; }; // and what only fed on it
  for (const id of gone) if (prompt[id]) drop(id);
  return { saves: pieceSaves, audio: isLink(audio) };
}

// For a workflow that loops over the whole motion video in pieces: how many pieces a video of this many frames takes
// (ComfyUI's template: piece length b, each next piece repeats one frame), or null.
export function loopPieces(prompt, videoFrames) {
  if (clipFrames(prompt) !== 'all' || !(videoFrames > 0)) return null;
  const frag = Object.values(prompt).find(n => /fragment/i.test(n._meta?.title || '') && typeof n.inputs?.value === 'number')?.inputs.value || 81;
  return Math.max(1, Math.floor((videoFrames - 2) / (frag - 1)) + 1);
}

export function analyze(prompt, objectInfo = null) {
  const candidates = { text: [], motion: [], image: [], video: [], width: [], height: [], aspect: [], frames: [], seconds: [], fps: [], seed: [] };
  const { positive, negative, motion } = branches(prompt);

  for (const [id, node] of Object.entries(prompt)) {
    const title = titleOf(prompt, id).toLowerCase();
    const cls = node.class_type;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue;
      const entry = { node: id, input, label: label(prompt, id, input), value };
      const lower = input.toLowerCase();
      if (typeof value === 'string') {
        if (lower === 'image' && (/LoadImage/i.test(cls) || FILE_RE.test(value) || value === '')) candidates.image.push({ ...entry, score: /LoadImage/i.test(cls) ? 10 : 5 });
        else if (/LoadVideo/i.test(cls) && /^(file|video)$/.test(lower)) candidates.video.push({ ...entry, score: /pose|motion|driv/.test(title) ? 12 : 10 });
        else if (/^(aspect_ratio|aspect|ratio)$/.test(lower)) candidates.aspect.push({ ...entry, score: 10 });
        else if (!FILE_RE.test(value) && !NOT_TEXT.test(input) && !isComboInput(objectInfo, cls, input) && !/^[\d.,\s-]+$/.test(value.trim() || 'x')) {
          let score = 0;
          if (/text|prompt|string/i.test(cls)) score += 3;
          if (/^(text|prompt|positive|text_g|text_l|t5xxl|clip_l|value|wildcard_text)$/.test(lower)) score += 3;
          if (/system|instruction/.test(lower) || /system/.test(title)) score -= 8;
          if (/negative/.test(title) || /negative/.test(lower)) score -= 20;
          if (/positive|prompt/.test(title)) score += 2;
          if (positive.has(id)) score += 12 - Math.min(positive.get(id), 6);
          if (negative.has(id) && !positive.has(id)) score -= 20;
          if (value.length > 20) score += 1;
          if ((value.match(NEGATIVE_WORDS) || []).length >= 2) score -= 15;
          if (motion.has(id)) {
            // A pose prompt is its own slot: it describes the motion, not the picture.
            candidates.motion.push({ ...entry, score: score + 10 - Math.min(motion.get(id), 6) });
            score -= 10;
          }
          candidates.text.push({ ...entry, score });
        }
      } else if (typeof value === 'number') {
        const isInt = Number.isInteger(value);
        if (/^(noise_)?seed$/.test(lower)) candidates.seed.push({ ...entry, score: 10 });
        else if (lower === 'width' || lower.endsWith('.width') || (lower === 'value' && /\bwidth\b/.test(title))) candidates.width.push({ ...entry, score: /Empty/.test(cls) ? 10 : /\bwidth\b/.test(title) ? 12 : 5 });
        else if (lower === 'height' || lower.endsWith('.height') || (lower === 'value' && /\bheight\b/.test(title))) candidates.height.push({ ...entry, score: /Empty/.test(cls) ? 10 : /\bheight\b/.test(title) ? 12 : 5 });
        // A batch slice's length (ImageFromBatch) is never the clip's frame count.
        else if (isInt && !/FromBatch/.test(cls) && (/^(length|frames|num_frames|frame_count|video_length)$/.test(lower) || (lower === 'value' && /^(frames|length|frame count)$/.test(title)))) candidates.frames.push({ ...entry, score: /Empty|Latent/.test(cls) ? 10 : 6 });
        else if (/^(duration|seconds|length_seconds)$/.test(lower) || (/^value$/.test(lower) && /duration|seconds/.test(title))) candidates.seconds.push({ ...entry, score: 10 });
        else if (/^(fps|frame_rate|framerate)$/.test(lower) || (lower === 'value' && /frame ?rate|fps/.test(title))) candidates.fps.push({ ...entry, score: 10 });
      }
    }
  }
  for (const list of Object.values(candidates)) list.sort((a, b) => b.score - a.score);

  const best = list => (list[0] && list[0].score > 0 ? { node: list[0].node, input: list[0].input } : null);
  const bestText = candidates.text[0] && candidates.text[0].score > 0 ? candidates.text[0] : null;
  // Width and height from the same node when possible.
  let width = best(candidates.width);
  let height = best(candidates.height);
  if (width && height && width.node !== height.node) {
    const pair = candidates.width.find(w => candidates.height.some(h => h.node === w.node));
    if (pair && prompt[pair.node].class_type.startsWith('Empty')) {
      width = { node: pair.node, input: pair.input };
      height = { node: pair.node, input: candidates.height.find(h => h.node === pair.node).input };
    }
  }
  const classes = Object.values(prompt).map(n => n.class_type).join(' ');
  const fpsTarget = best(candidates.fps);
  const mapping = {
    prompt: bestText ? [{ node: bestText.node, input: bestText.input }] : [],
    motion: candidates.motion[0] ? [{ node: candidates.motion[0].node, input: candidates.motion[0].input }] : [],
    image: best(candidates.image),
    video: best(candidates.video),
    width,
    height,
    aspect: best(candidates.aspect),
    frames: best(candidates.frames),
    seconds: best(candidates.seconds),
    fps: fpsTarget,
    seed: candidates.seed.map(c => ({ node: c.node, input: c.input })),
  };
  const options = {
    snap: /LTX/i.test(classes) ? 32 : 16,
    frameRule: /LTX/i.test(classes) ? '8n+1' : /Wan|Hunyuan/i.test(classes) ? '4n+1' : 'exact',
    fps: fpsTarget ? Number(prompt[fpsTarget.node].inputs[fpsTarget.input]) || 24 : 24,
    randomizeSeed: true,
    seedMode: 'random',
  };
  const outputs = Object.values(prompt).map(n => n.class_type);
  const producesVideo = outputs.some(c => /Video|VHS_VideoCombine|Animated/i.test(c));
  const warnings = [];
  for (const [id, node] of Object.entries(prompt)) {
    const { pose_start_percent: start, pose_end_percent: end } = node.inputs;
    if (typeof start === 'number' && typeof end === 'number' && end <= start) warnings.push(`#${id} ${titleOf(prompt, id)} uses the motion video only between ${start} and ${end} of the steps, so the motion video does almost nothing. Set Pose end above Pose start in 🎛️ Sampler.`);
  }
  const pieces = mapping.prompt.length ? twinsOf(prompt, mapping.prompt[0], { positive, negative }).length : 0;
  const same = ['prompt', mapping.width && 'size', mapping.frames && 'length'].filter(Boolean);
  if (pieces) warnings.push(`This workflow renders in ${pieces + 1} pieces (copies of the same part). Each piece gets the same ${same.length > 1 ? `${same.slice(0, -1).join(', ')} and ${same.at(-1)}` : same[0]}.`);
  const enhancer = Object.entries(prompt).find(([, n]) => /TextGenerate|PromptEnhanc|Enhancer|Florence|Ollama|LLM/i.test(n.class_type));
  if (enhancer) warnings.push(`This workflow runs its own prompt writer (#${enhancer[0]} ${titleOf(prompt, enhancer[0])}), which may rewrite Prompt Maker's prompt. Turn it off in ComfyUI if you want the prompt used as-is.`);
  candidates.params = samplerParams(prompt, objectInfo);
  return { candidates, mapping, options, producesVideo, warnings };
}

const SAVE_NODE = /^(Save|VHS_VideoCombine)/;
// Every node a node depends on.
function ancestors(prompt, id, seen = new Set()) {
  for (const v of Object.values(prompt[id]?.inputs || {})) {
    if (isLink(v) && prompt[v[0]] && !seen.has(v[0])) { seen.add(v[0]); ancestors(prompt, v[0], seen); }
  }
  return seen;
}

// Known mistakes in workflows as ComfyUI ships them, fixed in Prompt Maker's copy. Returns what was fixed.
// (The caller prunes nodes left with nothing to feed.)
export function repair(prompt) {
  const notes = [];
  // ComfyUI's Wan Animate 2 templates also save a side-by-side of the render and the motion video. As a second
  // render it would land in the Gallery next to every result, so only the render itself is saved.
  if (animatesCharacter(prompt)) {
    const saves = Object.keys(prompt).filter(id => SAVE_NODE.test(prompt[id].class_type));
    const stitched = saves.filter(id => [...ancestors(prompt, id)].some(a => prompt[a].class_type === 'ImageStitch'));
    if (stitched.length && stitched.length < saves.length) {
      for (const id of stitched) delete prompt[id];
      notes.push(`Left out the side-by-side video (your render next to the motion video) that this workflow also saves: only the render is kept.`);
    }
    // One that renders in pieces may also save its first piece on its own. The full video has it (a Batch node joins
    // the pieces), so only that one is kept.
    const left = saves.filter(id => prompt[id]);
    const framesOf = id => {
      const v = prompt[id].inputs.video ?? prompt[id].inputs.images;
      const src = isLink(v) ? v[0] : null;
      const im = prompt[src]?.class_type === 'CreateVideo' ? prompt[src].inputs.images : null;
      return im ? (isLink(im) ? im[0] : null) : src;
    };
    const joins = (b, src) => [...ancestors(prompt, b)].some(n => /Batch/i.test(prompt[n].class_type) && Object.values(prompt[n].inputs).some(v => isLink(v) && v[0] === src));
    const partial = left.filter(a => framesOf(a) && left.some(b => b !== a && joins(b, framesOf(a))));
    if (partial.length && partial.length < left.length) {
      for (const id of partial) delete prompt[id];
      notes.push(`Left out the video of the first piece that this workflow also saves: the full video has it, so only that one is kept.`);
    }
  }
  for (const [id, node] of Object.entries(prompt)) {
    // ComfyUI's Wan Animate 2 template (templates 0.11) wires its pose_start_percent input to both ends of the pose
    // window, so the window is empty and the motion video is ignored. The node's default end is 1.0.
    const i = node.inputs;
    if (node.class_type === 'WanAnimate2ToVideo' && typeof i.pose_start_percent === 'number' && i.pose_end_percent === i.pose_start_percent) {
      i.pose_end_percent = 1;
      notes.push(`Fixed #${id} ${titleOf(prompt, id)}: its pose window ended where it started (${i.pose_start_percent}), which leaves the motion video unused, as ComfyUI's template has it. Pose end is now 1.0 (change it in 🎛️ Sampler).`);
    }
  }
  return notes;
}

// A character-animation take is "<look and setting>" plus a last "Motion: …" line, which goes to the workflow's motion
// prompt. Returns { main, motion } (motion is '' when the take has no such line).
export function splitMotion(text) {
  const m = /(?:^|\n)[ \t*_]*motion(?: description)?[ \t*_]*[:：][ \t*_]*([\s\S]*)$/i.exec(String(text || ''));
  if (!m || m.index === 0) return { main: String(text || '').trim(), motion: '' };
  return { main: text.slice(0, m.index).trim(), motion: m[1].trim() };
}

// ---------- building the prompt to queue ----------

const ratioOf = s => {
  const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(String(s || '').trim());
  return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
};

// Width × height from a take's settings: "1920×1080", or "720p"/"2K" plus the aspect ratio.
export function sizeFor(resolution, aspectRatio, snap = 16) {
  const round = v => Math.max(snap, Math.round(v / snap) * snap);
  const exact = /^(\d+)\s*[×x]\s*(\d+)$/.exec(String(resolution || '').trim());
  if (exact) return { width: round(Number(exact[1])), height: round(Number(exact[2])) };
  const ar = ratioOf(aspectRatio) || 1;
  const p = /^(\d+)\s*p$/i.exec(String(resolution || '').trim());
  const k = /^(\d+(?:\.\d+)?)\s*k$/i.exec(String(resolution || '').trim());
  if (p) {
    const short = Number(p[1]);
    return ar >= 1 ? { width: round(short * ar), height: round(short) } : { width: round(short), height: round(short / ar) };
  }
  if (k) {
    const long = Number(k[1]) === 4 ? 3840 : Number(k[1]) * 1024;
    return ar >= 1 ? { width: round(long), height: round(long / ar) } : { width: round(long * ar), height: round(long) };
  }
  const area = 1024 * 1024;
  return { width: round(Math.sqrt(area * ar)), height: round(Math.sqrt(area / ar)) };
}

export function framesFor(seconds, fps, rule) {
  const raw = Math.max(1, Math.round(seconds * fps));
  if (rule === '8n+1') return Math.round((raw - 1) / 8) * 8 + 1;
  if (rule === '4n+1') return Math.round((raw - 1) / 4) * 4 + 1;
  return raw;
}

// Picks the workflow's own option closest to the requested aspect ratio (for combo inputs).
function closestOption(options, aspectRatio) {
  const want = ratioOf(aspectRatio);
  if (!want || !options?.length) return aspectRatio;
  if (options.includes(aspectRatio)) return aspectRatio;
  let best = null;
  for (const o of options) {
    const r = ratioOf(String(o).split(/\s/)[0]);
    if (r && (!best || Math.abs(Math.log(r / want)) < Math.abs(Math.log(ratioOf(String(best).split(/\s/)[0]) / want)))) best = o;
  }
  return best ?? aspectRatio;
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 48);

// Returns { prompt, applied } where applied describes what was set (shown to the user).
export function buildPrompt(workflow, values, objectInfo = null) {
  const prompt = structuredClone(workflow.prompt);
  const m = workflow.mapping;
  const o = workflow.options;
  const applied = {};
  const setOne = (t, v) => { if (t && prompt[t.node]) prompt[t.node].inputs[t.input] = v; };
  // What goes into a slot also goes into its copies in a workflow that renders in pieces (see twinsOf): the prompt,
  // size and length. (The image and the video are files each piece is wired to.)
  const mapped = new Set(Object.values(m).flat().filter(Boolean).map(t => `${t.node}|${t.input}`));
  const sides = branches(workflow.prompt);
  const set = (t, v) => {
    if (!t) return;
    setOne(t, v);
    for (const x of twinsOf(workflow.prompt, t, sides)) if (!mapped.has(`${x.node}|${x.input}`)) setOne(x, v);
  };

  for (const [key, value] of Object.entries(workflow.overrides || {})) {
    const i = key.lastIndexOf('|');
    setOne({ node: key.slice(0, i), input: key.slice(i + 1) }, value);
  }
  // With a motion-prompt slot, a take's Motion line goes there and the rest to the prompt.
  const parts = m.motion?.length ? splitMotion(values.text) : null;
  for (const t of m.prompt) set(t, parts?.motion ? parts.main : values.text);
  if (parts?.motion) for (const t of m.motion) set(t, parts.motion);
  if (m.image && values.imageName) setOne(m.image, values.imageName);
  if (m.video && values.videoName) setOne(m.video, values.videoName);

  if ((m.width && m.height) && values.resolution !== undefined) {
    const { width, height } = sizeFor(values.resolution, values.aspectRatio, o.snap);
    set(m.width, width);
    set(m.height, height);
    applied.size = `${width}×${height}`;
  }
  if (m.aspect && values.aspectRatio) {
    const node = prompt[m.aspect.node];
    const spec = objectInfo?.[node.class_type]?.input?.required?.[m.aspect.input] ?? objectInfo?.[node.class_type]?.input?.optional?.[m.aspect.input];
    const options = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
    const value = closestOption(options, values.aspectRatio);
    set(m.aspect, value);
    applied.aspect = value;
  }
  const seconds = Number(String(values.duration || '').replace(/[^\d.]/g, '')) || 0;
  if (seconds) {
    const fps = m.fps ? Number(prompt[m.fps.node].inputs[m.fps.input]) || o.fps : o.fps;
    if (m.seconds) set(m.seconds, Number.isInteger(prompt[m.seconds.node].inputs[m.seconds.input]) ? Math.round(seconds) : seconds);
    if (m.frames) {
      const frames = framesFor(seconds, fps, o.frameRule);
      set(m.frames, frames);
      applied.frames = frames;
    }
    applied.duration = `${seconds}s`;
  }
  // Every seed input gets the render's seed (older workflows may not list them in the mapping).
  const seedTargets = m.seed.length ? m.seed : samplerParams(prompt).filter(p => p.kind === 'seed');
  if (seedTargets.length && values.seed != null) {
    for (const t of seedTargets) setOne(t, values.seed);
    applied.seed = values.seed;
  } else if (seedTargets.length) {
    applied.seed = prompt[seedTargets[0].node]?.inputs?.[seedTargets[0].input] ?? null;
  }
  applied.loras = applyLoras(prompt, workflow.loras, objectInfo);
  const sampler = samplerParams(prompt);
  const first = kind => sampler.find(p => p.kind === kind)?.value;
  applied.sampler = first('sampler') ?? null;
  applied.steps = first('steps') ?? null;
  applied.cfg = first('cfg') ?? null;
  // A workflow made of pieces (SCAIL 2) gets as many as the motion video needs. With joinInApp (ffmpeg is here), each
  // piece is saved on its own and Prompt Maker joins them (see splitPieces).
  let split = null;
  if (values.videoFrames) {
    const joinId = values.joinInApp ? extendPlan(prompt)?.join.node : null;
    const pieces = extendPieces(prompt, values.videoFrames);
    if (pieces) applied.pieces = pieces;
    if (joinId) split = splitPieces(prompt, joinId);
  }
  // The editor fills %date:…% and %Node.widget% in file names at queue time; do the same.
  for (const node of Object.values(prompt)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === 'string' && /filename_prefix|output_path/.test(k) && v.includes('%')) node.inputs[k] = expandTokens(v, prompt);
    }
  }
  return { prompt, applied, parts: split };
}

// ---------- LoRAs ----------

const LORA_FILE = /\.(safetensors|pt|pth|ckpt|bin)$/i;

// The LoRAs a workflow loads itself: LoraLoader-style nodes, and the rows of rgthree's Power Lora Loader.
export function loraNodes(prompt) {
  const out = [];
  for (const [node, n] of Object.entries(prompt || {})) {
    const ins = n.inputs || {};
    const title = n._meta?.title || n.class_type;
    if (typeof ins.lora_name === 'string' && typeof ins.strength_model === 'number') {
      out.push({ key: node, node, title, name: ins.lora_name, strength: ins.strength_model, on: true, kind: 'loader' });
    }
    for (const [k, v] of Object.entries(ins)) {
      if (/^lora_\d+$/i.test(k) && v && typeof v === 'object' && !Array.isArray(v) && typeof v.lora === 'string' && v.lora && v.lora !== 'None') {
        out.push({ key: `${node}|${k}`, node, row: k, title, name: v.lora, strength: Number(v.strength ?? 1), on: v.on !== false, kind: 'power' });
      }
    }
  }
  return out;
}

// The workflow's own LoRAs, one row per LoRA. A workflow that renders in pieces loads each LoRA once per piece
// (copies of the same subgraph, see twinsOf); the copies follow the first one, so a change reaches every piece.
// leads: the LoRAs as shown, each with how many pieces load it; copyOf: a copy's key → the key it follows.
export function loraGroups(prompt) {
  const all = loraNodes(prompt);
  const copyOf = new Map();
  const sides = branches(prompt);
  for (const l of all) {
    if (l.kind !== 'loader' || copyOf.has(l.key)) continue;
    for (const t of twinsOf(prompt, { node: l.node, input: 'lora_name' }, sides)) {
      const c = all.find(x => x.key === t.node && x.kind === 'loader');
      if (c && !copyOf.has(c.key) && c.strength === l.strength) copyOf.set(c.key, l.key);
    }
  }
  const leads = all.filter(l => !copyOf.has(l.key)).map(l => ({ ...l, pieces: 1 + [...copyOf.values()].filter(k => k === l.key).length }));
  return { leads, copyOf };
}

// Your LoRA choices for a workflow: { tweaks: { key: { on, strength } } for its own LoRAs, added: [{ name, strength, on }] }.
function sanitizeLoras(l = {}, prompt = {}) {
  const own = new Map(loraNodes(prompt).map(x => [x.key, x]));
  const strength = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Math.min(5, Math.max(-5, Number(v))) * 100) / 100 : 1);
  const tweaks = {};
  for (const [key, t] of Object.entries(l?.tweaks || {})) {
    const o = own.get(key);
    if (!o || !t || typeof t !== 'object') continue;
    const tweak = { on: t.on !== false, strength: strength(t.strength) };
    if (tweak.on !== o.on || tweak.strength !== o.strength) tweaks[key] = tweak;
  }
  const added = (Array.isArray(l?.added) ? l.added : [])
    .filter(a => a && typeof a.name === 'string' && LORA_FILE.test(a.name) && !a.name.includes('..'))
    .slice(0, 12)
    .map(a => ({ name: a.name.slice(0, 300), strength: strength(a.strength), on: a.on !== false }));
  return { tweaks, added };
}

const linksTo = (prompt, node, slot) => Object.entries(prompt).flatMap(([id, n]) => Object.entries(n.inputs || {})
  .filter(([, v]) => Array.isArray(v) && String(v[0]) === String(node) && v[1] === slot).map(([input]) => ({ node: id, input })));

const MODEL_LOADERS = /^(UNETLoader|UnetLoaderGGUF|CheckpointLoaderSimple|CheckpointLoader|ImageOnlyCheckpointLoader)$/;

// Where the workflow loads its diffusion model(s): nodes that output a MODEL without taking one in.
function modelSources(prompt, objectInfo) {
  const out = [];
  for (const [node, n] of Object.entries(prompt)) {
    const spec = objectInfo?.[n.class_type];
    let slots;
    if (spec) {
      slots = (spec.output || []).map((t, i) => (t === 'MODEL' ? i : -1)).filter(i => i >= 0);
      const inputs = { ...spec.input?.required, ...spec.input?.optional };
      if (!slots.length || Object.entries(n.inputs || {}).some(([k, v]) => Array.isArray(v) && inputs[k]?.[0] === 'MODEL')) continue;
    } else if (MODEL_LOADERS.test(n.class_type)) {
      slots = [0];
    } else continue;
    for (const slot of slots) if (linksTo(prompt, node, slot).length) out.push({ node, slot });
  }
  return out;
}

// Takes a LoRA node out of the graph, wiring what it fed straight to what fed it (its file isn't loaded at all).
function bypassLora(prompt, node) {
  const through = [prompt[node].inputs.model, prompt[node].inputs.clip]; // outputs: 0 = MODEL, 1 = CLIP
  for (const n of Object.values(prompt)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && String(v[0]) === String(node) && through[v[1]]) n.inputs[k] = through[v[1]];
    }
  }
  delete prompt[node];
}

// Applies your LoRA choices: the workflow's own are re-weighted or switched off, and yours go right after each
// model loader (LoRAs add up, so their place in the chain doesn't matter). Returns the LoRAs the render uses.
function applyLoras(prompt, loras, objectInfo) {
  const used = [];
  const { copyOf } = loraGroups(prompt);
  for (const l of loraNodes(prompt)) {
    const t = loras?.tweaks?.[copyOf.get(l.key) ?? l.key]; // a copy in another piece follows the first
    const strength = t ? t.strength : l.strength;
    const on = (t ? t.on : l.on) && Number(strength) !== 0; // at 0 it's left out, so it can't touch the render at all
    if (l.kind === 'power') Object.assign(prompt[l.node].inputs[l.row], { on, strength });
    else if (!on) bypassLora(prompt, l.node);
    else if (t) {
      prompt[l.node].inputs.strength_model = strength;
      if (typeof prompt[l.node].inputs.strength_clip === 'number') prompt[l.node].inputs.strength_clip = strength;
    }
    if (on && !copyOf.has(l.key)) used.push({ name: l.name, strength }); // listed once, not once per piece
  }
  const added = (loras?.added || []).filter(a => a.on && Number(a.strength) !== 0);
  if (!added.length) return used;
  const sources = modelSources(prompt, objectInfo);
  if (!sources.length) throw httpError(400, 'Couldn\'t find where this workflow loads its model, so your added LoRAs can\'t go in. Add a LoRA loader to the workflow in ComfyUI instead.');
  let n = 0;
  for (const src of sources) {
    const consumers = linksTo(prompt, src.node, src.slot);
    let from = [src.node, src.slot];
    for (const a of added) {
      const id = `pm_lora_${++n}`;
      prompt[id] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: a.name, strength_model: a.strength, model: from }, _meta: { title: 'LoRA (Prompt Maker)' } };
      from = [id, 0];
    }
    for (const c of consumers) prompt[c.node].inputs[c.input] = from;
  }
  used.push(...added.map(a => ({ name: a.name, strength: a.strength, added: true })));
  return used;
}

function expandTokens(text, prompt) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return text
    .replace(/%date:([^%]+)%/g, (_, fmt) => fmt
      .replace(/yyyy/g, now.getFullYear()).replace(/yy/g, String(now.getFullYear()).slice(2))
      .replace(/MM/g, pad(now.getMonth() + 1)).replace(/dd/g, pad(now.getDate()))
      .replace(/hh/g, pad(now.getHours())).replace(/mm/g, pad(now.getMinutes())).replace(/ss/g, pad(now.getSeconds())))
    .replace(/%([^%.]+)\.([^%]+)%/g, (whole, nodeName, widget) => {
      const node = Object.values(prompt).find(n => n._meta?.title === nodeName || n.class_type === nodeName);
      const v = node?.inputs?.[widget];
      return v === undefined || Array.isArray(v) ? whole : String(v).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    });
}
