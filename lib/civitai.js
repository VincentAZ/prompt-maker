// What Civitai reads from a render to say which model made it (it requires that for some uploads, competitions
// among them): the ComfyUI "workflow" with only extra.airs, Civitai's id of the model (an AIR), and the "prompt" with
// only the node that loads the model. No prompt text, no other node. Matched by the model file the workflow loads.
// AIRs from Civitai's API (model-versions/<id> → air); MiniMax H3's is the one Civitai accepted on an upload.
const AIRS = [
  [/minimax[_-]?h3/i, 'urn:air:minimaxh3:checkpoint:civitai:2821932@3216500'],
  [/krea2?[_-]?2?[_-]?raw/i, 'urn:air:krea2:checkpoint:civitai:2726029@3147780'],
  [/krea2?[_-]?2?[_-]?turbo/i, 'urn:air:krea2:checkpoint:civitai:2726029@3091481'],
  [/ltx[_-]?2\.?3/i, 'urn:air:ltxv23:checkpoint:civitai:2448150@2752717'],
  [/qwen[_-]?image[_-]?edit/i, 'urn:air:qwen:checkpoint:civitai:1884704@2133258'],
  [/z[_-]?image[_-]?turbo/i, 'urn:air:zimageturbo:diffusionmodel:civitai:2168935@2442439'],
];

const MODEL_INPUTS = ['unet_name', 'ckpt_name', 'weight_dtype'];

// ComfyUI's job (its API "prompt", as text or parsed) → the tags a render keeps. With a known model:
// { workflow, prompt } as Civitai reads them; otherwise { model: <name in Prompt Maker> }.
export function renderTags(job, modelName) {
  let graph = job;
  if (typeof job === 'string') { try { graph = JSON.parse(job); } catch { graph = null; } }
  const loaders = Object.values(graph && typeof graph === 'object' ? graph : {})
    .filter(n => n && typeof n === 'object' && (typeof n.inputs?.unet_name === 'string' || typeof n.inputs?.ckpt_name === 'string'));
  const airs = [...new Set(loaders.map(n => AIRS.find(([re]) => re.test(n.inputs.unet_name || n.inputs.ckpt_name))?.[1]).filter(Boolean))];
  if (!airs.length) return modelName ? { model: modelName } : {};
  const prompt = Object.fromEntries(loaders.map((n, i) => [String(i + 1), {
    inputs: Object.fromEntries(MODEL_INPUTS.filter(k => typeof n.inputs[k] === 'string').map(k => [k, n.inputs[k]])),
    class_type: n.class_type,
    ...(n._meta?.title ? { _meta: { title: n._meta.title } } : {}),
  }]));
  return { workflow: JSON.stringify({ extra: { airs } }), prompt: JSON.stringify(prompt) };
}
