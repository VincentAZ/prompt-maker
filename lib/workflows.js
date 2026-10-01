// ComfyUI workflows attached to target models: storage, automatic input mapping, and building
// the exact prompt to queue (your text, image, size, duration and a fresh seed dropped in).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, httpError } from './store.js';

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
    seed: !seed ? null : w.options?.randomizeSeed !== false ? 'random' : valueOf(seed),
  };
}

export function summary(w) {
  const m = w.mapping || {};
  return {
    settings: settingsAtAGlance(w),
    loras: {
      nodes: loraNodes(w.prompt).map(({ key, name, title, strength, on }) => ({ key, name, title, strength, on })),
      tweaks: w.loras?.tweaks || {},
      added: w.loras?.added || [],
    },
    id: w.id,
    modelId: w.modelId,
    name: w.name,
    source: w.source || '',
    sourceModified: w.sourceModified ?? null,
    nodes: Object.keys(w.prompt || {}).length,
    maps: {
      prompt: Boolean(m.prompt?.length),
      image: Boolean(m.image),
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
    options: sanitizeOptions(input.options ?? existing?.options),
    overrides: sanitizeOverrides(input.overrides ?? existing?.overrides, input.prompt ?? existing?.prompt),
    loras: sanitizeLoras(input.loras ?? existing?.loras, input.prompt ?? existing?.prompt),
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
  if (existing.options?.randomizeSeed !== false) mapping.seed = fresh.seed;
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
    image: one(m.image),
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
  for (const [key, value] of Object.entries(o || {})) {
    const p = params.get(key);
    if (!p) continue;
    if (p.kind === 'sampler' || p.kind === 'scheduler') {
      if (typeof value === 'string' && value && (!p.options || p.options.includes(value))) out[key] = value;
    } else if (Number.isFinite(Number(value))) {
      const n = Number(value);
      if (p.kind === 'seed') out[key] = Math.max(0, Math.floor(n));
      else if (p.kind === 'steps') out[key] = Math.min(1000, Math.max(1, Math.round(n)));
      else out[key] = Math.min(100, Math.max(0, n));
    }
  }
  return out;
}

function sanitizeOptions(o = {}) {
  return {
    snap: [1, 8, 16, 32, 64].includes(Number(o.snap)) ? Number(o.snap) : 16,
    frameRule: ['exact', '8n+1', '4n+1'].includes(o.frameRule) ? o.frameRule : 'exact',
    fps: Number(o.fps) > 0 ? Number(o.fps) : 24,
    randomizeSeed: o.randomizeSeed !== false,
  };
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

export function analyze(prompt, objectInfo = null) {
  const candidates = { text: [], image: [], width: [], height: [], aspect: [], frames: [], seconds: [], fps: [], seed: [] };
  const positive = new Map();
  const negative = new Map();
  for (const [id, node] of Object.entries(prompt)) {
    if (isLink(node.inputs.positive)) for (const [n, d] of upstream(prompt, id, 'positive')) positive.set(n, Math.min(d, positive.get(n) ?? 99));
    if (isLink(node.inputs.negative)) for (const [n, d] of upstream(prompt, id, 'negative')) negative.set(n, Math.min(d, negative.get(n) ?? 99));
    if (isLink(node.inputs.conditioning) && /Guider/.test(node.class_type)) for (const [n, d] of upstream(prompt, id, 'conditioning')) positive.set(n, Math.min(d, positive.get(n) ?? 99));
  }

  for (const [id, node] of Object.entries(prompt)) {
    const title = titleOf(prompt, id).toLowerCase();
    const cls = node.class_type;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value)) continue;
      const entry = { node: id, input, label: label(prompt, id, input), value };
      const lower = input.toLowerCase();
      if (typeof value === 'string') {
        if (lower === 'image' && (/LoadImage/i.test(cls) || FILE_RE.test(value) || value === '')) candidates.image.push({ ...entry, score: /LoadImage/i.test(cls) ? 10 : 5 });
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
          candidates.text.push({ ...entry, score });
        }
      } else if (typeof value === 'number') {
        const isInt = Number.isInteger(value);
        if (/^(noise_)?seed$/.test(lower)) candidates.seed.push({ ...entry, score: 10 });
        else if (lower === 'width' || (lower === 'value' && /\bwidth\b/.test(title))) candidates.width.push({ ...entry, score: /Empty/.test(cls) ? 10 : /\bwidth\b/.test(title) ? 12 : 5 });
        else if (lower === 'height' || (lower === 'value' && /\bheight\b/.test(title))) candidates.height.push({ ...entry, score: /Empty/.test(cls) ? 10 : /\bheight\b/.test(title) ? 12 : 5 });
        else if (isInt && (/^(length|frames|num_frames|frame_count|video_length)$/.test(lower) || (lower === 'value' && /^(frames|length|frame count)$/.test(title)))) candidates.frames.push({ ...entry, score: /Empty|Latent/.test(cls) ? 10 : 6 });
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
    image: best(candidates.image),
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
  };
  const outputs = Object.values(prompt).map(n => n.class_type);
  const producesVideo = outputs.some(c => /Video|VHS_VideoCombine|Animated/i.test(c));
  const warnings = [];
  const enhancer = Object.entries(prompt).find(([, n]) => /TextGenerate|PromptEnhanc|Enhancer|Florence|Ollama|LLM/i.test(n.class_type));
  if (enhancer) warnings.push(`This workflow runs its own prompt writer (#${enhancer[0]} ${titleOf(prompt, enhancer[0])}), which may rewrite Prompt Maker's prompt. Turn it off in ComfyUI if you want the prompt used as-is.`);
  candidates.params = samplerParams(prompt, objectInfo);
  return { candidates, mapping, options, producesVideo, warnings };
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
  const set = (t, v) => { if (t && prompt[t.node]) prompt[t.node].inputs[t.input] = v; };

  for (const [key, value] of Object.entries(workflow.overrides || {})) {
    const i = key.lastIndexOf('|');
    set({ node: key.slice(0, i), input: key.slice(i + 1) }, value);
  }
  for (const t of m.prompt) set(t, values.text);
  if (m.image && values.imageName) set(m.image, values.imageName);

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
  if (m.seed.length && values.seed !== null) {
    const seed = values.seed ?? randomSeed();
    for (const t of m.seed) set(t, seed);
    applied.seed = seed;
  } else if (m.seed.length) {
    applied.seed = prompt[m.seed[0].node]?.inputs?.[m.seed[0].input] ?? null;
  }
  applied.loras = applyLoras(prompt, workflow.loras, objectInfo);
  const sampler = samplerParams(prompt);
  const first = kind => sampler.find(p => p.kind === kind)?.value;
  applied.sampler = first('sampler') ?? null;
  applied.steps = first('steps') ?? null;
  applied.cfg = first('cfg') ?? null;
  // The editor fills %date:…% and %Node.widget% in file names at queue time; do the same.
  for (const node of Object.values(prompt)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v === 'string' && /filename_prefix|output_path/.test(k) && v.includes('%')) node.inputs[k] = expandTokens(v, prompt);
    }
  }
  return { prompt, applied };
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
  for (const l of loraNodes(prompt)) {
    const t = loras?.tweaks?.[l.key];
    const on = t ? t.on : l.on;
    const strength = t ? t.strength : l.strength;
    if (l.kind === 'power') Object.assign(prompt[l.node].inputs[l.row], { on, strength });
    else if (!on) bypassLora(prompt, l.node);
    else if (t) {
      prompt[l.node].inputs.strength_model = strength;
      if (typeof prompt[l.node].inputs.strength_clip === 'number') prompt[l.node].inputs.strength_clip = strength;
    }
    if (on) used.push({ name: l.name, strength });
  }
  const added = (loras?.added || []).filter(a => a.on);
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
