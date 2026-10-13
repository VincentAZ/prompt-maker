// A picture's or video's recipe: what it was made with, as the file itself carries it (read in the browser, see
// public/recipe.js). ComfyUI keeps the whole graph it ran ("prompt"); A1111, Forge and Civitai keep a "parameters"
// text. Either becomes one shape: the prompt, the model files, the LoRAs and their strengths, the seed, the size,
// the length and the sampler settings. Then the workflow of yours it matches, with the sampler settings put in its terms.
import { analyze, samplerParams, loraNodes } from './workflows.js';
import { MODEL_FILE } from './models.js';

const slashes = s => String(s).replace(/\\/g, '/');
const baseName = s => slashes(s).split('/').pop();
const stem = s => baseName(s).replace(MODEL_FILE, '').toLowerCase();
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SETTING_KINDS = ['steps', 'cfg', 'sampler', 'scheduler', 'denoise'];
// The loader inputs that name the model itself (not its VAE, text encoder or a LoRA).
const MAIN_MODEL = /^(ckpt_name|unet_name|model_name|model)$/;

// A1111's sampler and schedule names as ComfyUI calls them.
const SAMPLERS = {
  'euler a': 'euler_ancestral', euler: 'euler', heun: 'heun', lms: 'lms', dpm2: 'dpm_2', 'dpm2 a': 'dpm_2_ancestral',
  'dpm++ 2s a': 'dpmpp_2s_ancestral', 'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde', 'dpm++ 2m sde': 'dpmpp_2m_sde',
  'dpm++ 3m sde': 'dpmpp_3m_sde', 'dpm fast': 'dpm_fast', 'dpm adaptive': 'dpm_adaptive', ddim: 'ddim', ddpm: 'ddpm',
  unipc: 'uni_pc', lcm: 'lcm', 'res multistep': 'res_multistep', deis: 'deis',
};
const SCHEDULES = { karras: 'karras', exponential: 'exponential', 'sgm uniform': 'sgm_uniform', simple: 'simple', normal: 'normal', beta: 'beta', 'align your steps': 'align_your_steps', 'kl optimal': 'kl_optimal', automatic: null };

// A1111 / Forge / Civitai "parameters": the prompt, "Negative prompt: …", then one line of "Key: value, …".
// <lora:name:0.8> tags in the prompt are LoRAs, not words: they come out of the prompt.
export function fromParameters(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const last = lines.findLastIndex(l => /^\s*Steps:\s*\d+/.test(l));
  const settings = last >= 0 ? lines[last] : '';
  const body = (last >= 0 ? lines.slice(0, last) : lines).join('\n');
  const neg = body.search(/^Negative prompt:/m);
  let prompt = (neg >= 0 ? body.slice(0, neg) : body);
  const loras = [];
  prompt = prompt.replace(/<lora:([^:>]+):?([-\d.]*)[^>]*>/gi, (_, name, w) => {
    loras.push({ name: name.trim(), strength: Number.isFinite(parseFloat(w)) ? parseFloat(w) : 1 });
    return '';
  }).replace(/[ \t]+,/g, ',').replace(/,\s*,/g, ',').replace(/[ \t]{2,}/g, ' ').trim().replace(/^,\s*|,\s*$/g, '');
  const field = {};
  for (const m of settings.matchAll(/\s*([\w ][\w ()/-]*?):\s*("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/g)) field[m[1].trim().toLowerCase()] = m[2].trim().replace(/^"|"$/g, '');
  const size = /^(\d+)x(\d+)$/.exec(field.size || '');
  let sampler = (field.sampler || '').toLowerCase();
  let scheduler = (field['schedule type'] || '').toLowerCase();
  const old = / (karras|exponential)$/.exec(sampler); // "DPM++ 2M Karras" (before Schedule type had its own field)
  if (old) { sampler = sampler.slice(0, old.index); scheduler ||= old[1]; }
  const settingsOut = {
    ...(Number(field.steps) ? { steps: Number(field.steps) } : {}),
    ...(Number(field['cfg scale']) ? { cfg: Number(field['cfg scale']) } : {}),
    ...(SAMPLERS[sampler] ? { sampler: SAMPLERS[sampler] } : {}),
    ...(SCHEDULES[scheduler] ? { scheduler: SCHEDULES[scheduler] } : {}),
    ...(Number(field['denoising strength']) ? { denoise: Number(field['denoising strength']) } : {}),
  };
  return {
    from: 'a1111',
    prompt,
    loras,
    modelFiles: field.model ? [field.model] : [],
    model: field.model || null,
    seed: /^\d+$/.test(field.seed || '') ? Number(field.seed) : null,
    size: size ? { width: Number(size[1]), height: Number(size[2]) } : null,
    aspect: null,
    seconds: null,
    settings: settingsOut,
    params: [],
    graph: null,
    takesPicture: false,
    pictures: [],
    video: false,
  };
}

// A ComfyUI graph (API format), as it ran.
export function fromGraph(graph, objectInfo = null) {
  const { mapping, candidates, producesVideo } = analyze(graph, objectInfo);
  const valueAt = t => (t ? graph[t.node]?.inputs?.[t.input] : undefined);
  const prompt = mapping.prompt[0] ? String(valueAt(mapping.prompt[0]) ?? '') : '';
  const loras = loraNodes(graph).filter(l => l.on).map(l => ({ name: slashes(l.name), strength: l.strength, key: l.key }));
  const modelFiles = [];
  let model = null;
  for (const node of Object.values(graph)) {
    for (const [input, v] of Object.entries(node?.inputs || {})) {
      if (typeof v !== 'string' || !MODEL_FILE.test(v) || input === 'lora_name') continue;
      modelFiles.push(slashes(v));
      if (!model && MAIN_MODEL.test(input)) model = slashes(v);
    }
  }
  const width = num(valueAt(mapping.width));
  const height = num(valueAt(mapping.height));
  const seedAt = mapping.seed.find(t => num(valueAt(t)) != null);
  const params = samplerParams(graph, objectInfo).map(p => ({ key: `${p.node}|${p.input}`, kind: p.kind, value: p.value, classType: p.classType }));
  const first = kind => params.find(p => p.kind === kind)?.value;
  const frames = num(valueAt(mapping.frames));
  const fps = num(valueAt(mapping.fps)) || 24;
  const seconds = num(valueAt(mapping.seconds)) ?? (frames && producesVideo ? Math.round(((frames - 1) / fps) * 10) / 10 : null);
  return {
    from: 'comfyui',
    prompt,
    loras,
    modelFiles,
    model,
    seed: seedAt ? valueAt(seedAt) : num(first('seed')),
    size: width && height ? { width, height } : null,
    aspect: typeof valueAt(mapping.aspect) === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(valueAt(mapping.aspect)) ? valueAt(mapping.aspect) : null,
    seconds: seconds > 0 ? seconds : null,
    settings: Object.fromEntries(SETTING_KINDS.map(k => [k, first(k)]).filter(([, v]) => v != null)),
    params,
    graph,
    takesPicture: (mapping.images || []).length > 0 || Boolean(mapping.image && candidates.image[0]?.score >= 10),
    // The pictures it started from, as ComfyUI named them (Prompt Maker's own: "prompt-maker_" and the data folder's name).
    pictures: (mapping.images || []).map(t => valueAt(t)).filter(v => typeof v === 'string' && v),
    video: producesVideo,
  };
}

// The model files a workflow loads, by name without folder or extension (LoRAs aside).
function filesOf(prompt) {
  const main = new Set();
  const rest = new Set();
  for (const node of Object.values(prompt || {})) {
    for (const [input, v] of Object.entries(node?.inputs || {})) {
      if (typeof v !== 'string' || !MODEL_FILE.test(v) || input === 'lora_name') continue;
      (MAIN_MODEL.test(input) ? main : rest).add(stem(v));
    }
  }
  return { main, rest };
}

// How much of the recipe's graph is this workflow: the same node ids holding the same kind of node. (Nodes Prompt
// Maker put in, pm_…, like the LoRAs you added, aren't the workflow's.)
function sameShape(graph, prompt) {
  const ids = Object.keys(graph || {}).filter(id => !id.startsWith('pm_'));
  if (!ids.length || !prompt) return 0;
  return ids.filter(id => prompt[id]?.class_type === graph[id].class_type).length / ids.length;
}

// The workflow of yours the recipe was made with, or the one that loads the same model: { workflow, same } or null.
// same: it is that very workflow (a render of yours, or a copy of the same graph). On a tie, the one in use now wins.
export function matchWorkflow(recipe, workflows, currentId = null) {
  const wanted = recipe.modelFiles.map(stem);
  const wantedMain = recipe.model ? stem(recipe.model) : null;
  let best = null;
  for (const w of workflows) {
    const { main, rest } = filesOf(w.prompt);
    const shape = recipe.graph ? sameShape(recipe.graph, w.prompt) : 0;
    let score = 0;
    if (wantedMain && main.has(wantedMain)) score += 10;
    for (const f of wanted) if (f !== wantedMain && (main.has(f) || rest.has(f))) score += 1;
    if (!score) continue; // never a workflow that loads none of the same model files
    if (shape >= 0.8) score += 100 * shape; // the closest graph first
    if (Boolean(recipe.video) === Boolean(w.mapping?.frames || w.mapping?.seconds)) score += 0.5;
    if (w.id === currentId) score += 0.25;
    if (!best || score > best.score) best = { workflow: w, same: shape >= 0.8, score };
  }
  return best && { workflow: best.workflow, same: best.same };
}

// The recipe's sampler settings as the workflow's own (its "node|input" keys). The very same workflow: setting for
// setting. Another one: a kind only where each has exactly one (one steps, one CFG…), so a two-pass workflow's
// second pass never gets the first one's steps. Samplers and schedulers only by a name the workflow offers.
export function settingsFor(recipe, workflow, same) {
  const own = samplerParams(workflow.prompt || {});
  const out = {};
  const offered = (p, v) => typeof v === (typeof p.value) && (!p.options || p.options.includes(v));
  if (same) {
    for (const r of recipe.params) {
      const p = own.find(x => `${x.node}|${x.input}` === r.key);
      if (p && SETTING_KINDS.includes(r.kind) && r.value !== p.value && offered(p, r.value)) out[r.key] = r.value;
    }
    return out;
  }
  for (const kind of SETTING_KINDS) {
    const v = recipe.settings[kind];
    const mine = own.filter(p => p.kind === kind);
    const theirs = recipe.params.filter(p => p.kind === kind);
    if (v == null || mine.length !== 1 || theirs.length > 1) continue;
    if (mine[0].value !== v && offered(mine[0], v)) out[`${mine[0].node}|${mine[0].input}`] = v;
  }
  return out;
}

// A LoRA as ComfyUI has it: the same path, else the same file in another folder, else the same name without its
// extension (A1111 names a LoRA without one). null: ComfyUI doesn't have it.
export function findLora(name, list) {
  if (!Array.isArray(list)) return undefined; // (ComfyUI not reachable: can't tell)
  const n = slashes(name);
  return list.find(x => x === n)
    || list.find(x => baseName(x) === baseName(n))
    || list.find(x => stem(x) === stem(n))
    || null;
}
