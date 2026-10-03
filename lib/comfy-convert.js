// Converts a ComfyUI editor ("UI") workflow — what ComfyUI saves to disk — into the API ("prompt")
// format its server executes, using the server's /object_info to know every node's inputs.
// Handles bypassed/muted nodes, reroutes, primitive nodes, Set/Get nodes and (nested) subgraphs.
// Verified against ComfyUI's own frontend conversion (app.graphToPrompt).

const FRONTEND_ONLY = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'SetNode', 'GetNode', 'Group', 'Label (rgthree)', 'Fast Groups Bypasser (rgthree)', 'Fast Groups Muter (rgthree)', 'Bookmark (rgthree)']);
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize', 'increment-wrap']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
const MODE_MUTED = 2;
const MODE_BYPASS = 4;

export class ConvertError extends Error {}

export function isUiWorkflow(json) {
  return Boolean(json && Array.isArray(json.nodes) && Array.isArray(json.links ?? []));
}

// API workflows are { "id": { class_type, inputs } }.
export function isApiWorkflow(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const nodes = Object.values(json);
  return nodes.length > 0 && nodes.every(n => n && typeof n.class_type === 'string' && typeof n.inputs === 'object');
}

function normalizeLinks(links = []) {
  const map = new Map();
  for (const l of links) {
    if (!l) continue;
    const link = Array.isArray(l)
      ? { id: l[0], origin: l[1], originSlot: l[2], target: l[3], targetSlot: l[4], type: l[5] }
      : { id: l.id, origin: l.origin_id, originSlot: l.origin_slot, target: l.target_id, targetSlot: l.target_slot, type: l.type };
    map.set(link.id, link);
  }
  return map;
}

function specOf(info) {
  const specs = new Map();
  for (const section of ['required', 'optional']) {
    for (const [name, spec] of Object.entries(info?.input?.[section] || {})) specs.set(name, spec);
  }
  return specs;
}

const specType = spec => (Array.isArray(spec?.[0]) ? 'COMBO' : spec?.[0]);
const specOpts = spec => (spec && typeof spec[1] === 'object' && spec[1]) || {};
const isDynamicCombo = spec => typeof specType(spec) === 'string' && specType(spec).startsWith('COMFY_DYNAMICCOMBO');
// A type like "FLOAT,INT" is a widget when it names its widget (widgetType).
const isWidgetSpec = spec => spec && !specOpts(spec).forceInput && (WIDGET_TYPES.has(specType(spec)) || WIDGET_TYPES.has(specOpts(spec).widgetType) || isDynamicCombo(spec));
// The editor adds a "control after generate" widget to seeds even when the node doesn't declare it.
const hasControl = (spec, name) => Boolean(specOpts(spec).control_after_generate) || (specType(spec) === 'INT' && /^(noise_)?seed$/.test(name));

// Sub-inputs a dynamic combo adds for the selected option, e.g. SaveVideo format "auto" → "format.codec".
function dynamicDefaults(name, spec, selected) {
  const out = {};
  const option = (specOpts(spec).options || []).find(o => o.key === selected) || (specOpts(spec).options || [])[0];
  for (const section of ['required', 'optional']) {
    for (const [sub, subSpec] of Object.entries(option?.inputs?.[section] || {})) {
      const key = `${name}.${sub}`;
      if (isDynamicCombo(subSpec)) {
        const first = specOpts(subSpec).options?.[0]?.key;
        out[key] = specOpts(subSpec).default ?? first;
        Object.assign(out, dynamicDefaults(key, subSpec, out[key]));
      } else if (section === 'required' && isWidgetSpec(subSpec)) {
        out[key] = specOpts(subSpec).default ?? (Array.isArray(subSpec[0]) ? subSpec[0][0] : undefined);
      }
    }
  }
  return out;
}

export function convertUiWorkflow(ui, objectInfo) {
  if (!isUiWorkflow(ui)) throw new ConvertError('This is not a ComfyUI workflow file.');
  const defs = new Map(((ui.definitions && ui.definitions.subgraphs) || []).map(s => [s.id, s]));
  const missing = new Set();
  const prompt = {};

  // A scope is the top-level graph or one subgraph instance.
  const makeScope = (graph, prefix, parent, instance, def) => ({
    nodes: new Map((graph.nodes || []).map(n => [n.id, n])),
    links: normalizeLinks(graph.links),
    prefix,
    parent,
    instance,
    def,
    children: new Map(),
  });

  function childScope(scope, node) {
    if (!scope.children.has(node.id)) {
      const def = defs.get(node.type);
      scope.children.set(node.id, makeScope(def, `${scope.prefix}${node.id}:`, scope, node, def));
    }
    return scope.children.get(node.id);
  }

  const PROMOTED = { promoted: true };

  // A subgraph input that ends in an inner node's widget, so the subgraph node shows it as a widget of its own.
  const feedsWidget = (scope, subInput) => (subInput.linkIds || []).some(id => {
    const link = scope.links.get(id);
    return Boolean(link && scope.nodes.get(link.target)?.inputs?.[link.targetSlot]?.widget);
  });

  // A subgraph input shown as a widget on the subgraph node. Older saves keep its value on the
  // instance (widgets_values, in widget order); newer saves keep it on an inner node's widget.
  // The editor makes those widgets in the subgraph's input order, so that order wins when it accounts for every
  // value (the instance's own input list can be missing some, as in ComfyUI's Wan Animate 2 template).
  function promotedValue(scope, subInput, instInput) {
    const inst = scope.instance;
    const values = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
    const widgetInputs = (inst.inputs || []).filter(i => i.widget);
    const ordered = (scope.def.inputs || []).filter(i => feedsWidget(scope, i));
    if (values.length && values.length === ordered.length && ordered.includes(subInput)) return { value: values[ordered.indexOf(subInput)] };
    if (values.length && instInput?.widget) {
      const index = widgetInputs.indexOf(instInput);
      if (index >= 0 && index < values.length) return { value: values[index] };
    }
    for (const linkId of subInput?.linkIds || []) {
      const link = scope.links.get(linkId);
      const target = link && scope.nodes.get(link.target);
      if (!target || defs.has(target.type)) continue;
      const input = (target.inputs || [])[link.targetSlot];
      const name = input?.widget?.name;
      const info = objectInfo[target.type];
      if (name && info) {
        const widgets = widgetValues(target, info);
        if (name in widgets) return { value: widgets[name] };
      }
    }
    return PROMOTED;
  }

  function resolveLink(scope, linkId, seen = new Set()) {
    const link = scope.links.get(linkId);
    if (!link) return null;
    const key = `${scope.prefix}|${linkId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return resolveOutput(scope, link.origin, link.originSlot, link.type, seen);
  }

  function resolveOutput(scope, nodeId, slot, type, seen) {
    // Subgraph input boundary: continue outside, on the instance's matching input.
    if (scope.def && nodeId === (scope.def.inputNode?.id ?? -10)) {
      const subInput = scope.def.inputs?.[slot];
      const instInputs = scope.instance.inputs || [];
      // By name; by position only when the node lists every input (it can list fewer, see promotedValue).
      const instInput = instInputs.find(i => i.name === subInput?.name) || (instInputs.length === (scope.def.inputs || []).length ? instInputs[slot] : null);
      if (instInput?.link != null) return resolveLink(scope.parent, instInput.link, seen);
      return promotedValue(scope, subInput, instInput);
    }
    const node = scope.nodes.get(nodeId);
    if (!node) return null;
    if (defs.has(node.type)) {
      if (node.mode === MODE_MUTED) return null;
      const inner = childScope(scope, node);
      const outId = inner.def.outputNode?.id ?? -20;
      const link = [...inner.links.values()].find(l => l.target === outId && l.targetSlot === slot);
      return link ? resolveOutput(inner, link.origin, link.originSlot, link.type, seen) : null;
    }
    if (node.mode === MODE_MUTED) return null;
    if (node.mode === MODE_BYPASS) {
      const outType = node.outputs?.[slot]?.type ?? type;
      const inputs = node.inputs || [];
      const same = inputs[slot] && inputs[slot].type === outType ? inputs[slot] : inputs.find(i => i.type === outType && i.link != null);
      return same?.link != null ? resolveLink(scope, same.link, seen) : null;
    }
    if (node.type === 'Reroute' || node.type === 'SetNode') {
      const input = (node.inputs || []).find(i => i.link != null);
      return input ? resolveLink(scope, input.link, seen) : null;
    }
    if (node.type === 'GetNode') {
      const name = node.widgets_values?.[0];
      const setter = [...scope.nodes.values()].find(n => n.type === 'SetNode' && n.widgets_values?.[0] === name);
      const input = setter && (setter.inputs || []).find(i => i.link != null);
      return input ? resolveLink(scope, input.link, seen) : null;
    }
    if (node.type === 'PrimitiveNode') return { value: node.widgets_values?.[0] };
    return { ref: [`${scope.prefix}${node.id}`, slot] };
  }

  function widgetValues(node, info) {
    const specs = specOf(info);
    const values = node.widgets_values;
    const byName = {};
    if (node.type.startsWith('Power Lora Loader')) {
      byName.PowerLoraLoaderHeaderWidget = {};
      let n = 0;
      for (const v of values || []) {
        if (v && typeof v === 'object' && 'lora' in v) {
          const { strengthTwo, ...rest } = v;
          byName[`lora_${++n}`] = strengthTwo == null ? rest : v;
        }
      }
      byName['➕ Add Lora'] = '';
      return byName;
    }
    if (values && !Array.isArray(values)) {
      for (const [k, v] of Object.entries(values)) if (specs.has(k) || k.includes('.')) byName[k] = v;
      return byName;
    }
    const list = values || [];
    const widgetInputs = (node.inputs || []).filter(i => i.widget);
    // The node's input list names every widget in newer saves; others list only the linked ones (then the
    // values follow the node definition's order, as in older saves).
    const listed = new Set(widgetInputs.map(i => i.widget?.name ?? i.name));
    const complete = [...specs].every(([name, spec]) => !isWidgetSpec(spec) || listed.has(name));
    let w = 0;
    if (widgetInputs.length && complete) {
      for (const input of widgetInputs) {
        const name = input.widget?.name ?? input.name;
        const spec = specs.get(name);
        const value = list[w++];
        if (hasControl(spec, name) && CONTROL_VALUES.has(list[w])) w++;
        if (spec || name.includes('.')) byName[name] = value;
      }
    } else {
      const take = (name, spec) => {
        byName[name] = list[w++];
        if (hasControl(spec, name) && CONTROL_VALUES.has(list[w])) w++;
        const o = specOpts(spec);
        if ((o.image_upload || o.video_upload || o.audio_upload) && typeof list[w] === 'string' && !specs.has(list[w])) w++;
        // A dynamic combo's sub-widgets for the selected option come right after it, e.g. resize_type → resize_type.width.
        if (isDynamicCombo(spec)) {
          const option = (o.options || []).find(x => x.key === byName[name]);
          for (const section of ['required', 'optional']) {
            for (const [sub, subSpec] of Object.entries(option?.inputs?.[section] || {})) if (isWidgetSpec(subSpec) && w < list.length) take(`${name}.${sub}`, subSpec);
          }
        }
      };
      const order = [...(info?.input_order?.required || []), ...(info?.input_order?.optional || [])];
      for (const name of order.length ? order : specs.keys()) {
        const spec = specs.get(name);
        if (!isWidgetSpec(spec)) continue;
        if (w >= list.length) break;
        take(name, spec);
      }
    }
    // Inputs added to a node after the workflow was saved get their default, as in the editor.
    for (const [name, spec] of specs) {
      if (name in byName || !isWidgetSpec(spec)) continue;
      const o = specOpts(spec);
      const t = specType(spec);
      if (isDynamicCombo(spec)) byName[name] = o.default ?? o.options?.[0]?.key;
      else if (t === 'COMBO') byName[name] = o.default ?? (Array.isArray(spec[0]) ? spec[0][0] : o.options?.[0]);
      else if (t === 'INT' || t === 'FLOAT') byName[name] = o.default ?? o.min ?? 0;
      else if (t === 'BOOLEAN') byName[name] = o.default ?? false;
      else byName[name] = o.default ?? '';
    }
    // Fill in dynamic sub-inputs that older saves don't carry.
    for (const [name, spec] of specs) {
      if (isDynamicCombo(spec) && name in byName) {
        for (const [k, v] of Object.entries(dynamicDefaults(name, spec, byName[name]))) if (!(k in byName)) byName[k] = v;
      }
    }
    return byName;
  }

  function emit(scope) {
    for (const node of scope.nodes.values()) {
      if (defs.has(node.type)) {
        if (node.mode !== MODE_MUTED && node.mode !== MODE_BYPASS) emit(childScope(scope, node));
        continue;
      }
      if (FRONTEND_ONLY.has(node.type) || node.mode === MODE_MUTED || node.mode === MODE_BYPASS) continue;
      const info = objectInfo[node.type];
      if (!info) {
        missing.add(node.type);
        continue;
      }
      const widgets = widgetValues(node, info);
      const inputs = {};
      const linked = new Set((node.inputs || []).filter(i => i.link != null).map(i => i.widget?.name ?? i.name));
      for (const [name, value] of Object.entries(widgets)) if (!linked.has(name)) inputs[name] = value;
      for (const input of node.inputs || []) {
        if (input.link == null) continue;
        const name = input.widget?.name ?? input.name;
        const r = resolveLink(scope, input.link);
        if (r === PROMOTED) {
          if (name in widgets) inputs[name] = widgets[name];
        } else if (r?.ref) inputs[name] = r.ref;
        else if (r && 'value' in r) inputs[name] = r.value;
      }
      prompt[`${scope.prefix}${node.id}`] = {
        inputs,
        class_type: node.type,
        _meta: { title: node.title || info.display_name || node.type },
      };
    }
  }

  emit(makeScope(ui, '', null, null, null));
  if (missing.size) {
    throw new ConvertError(`This workflow uses nodes your ComfyUI doesn't have installed: ${[...missing].sort().join(', ')}. Install them (ComfyUI Manager → Install Missing Custom Nodes), then try again.`);
  }
  if (!Object.keys(prompt).length) throw new ConvertError('This workflow has no runnable nodes.');
  return prompt;
}

// Keeps only nodes that feed an output node, which is all ComfyUI executes anyway.
export function pruneToOutputs(prompt, objectInfo) {
  const keep = new Set();
  const visit = id => {
    if (keep.has(id) || !prompt[id]) return;
    keep.add(id);
    for (const v of Object.values(prompt[id].inputs)) if (Array.isArray(v) && typeof v[0] === 'string' && prompt[v[0]]) visit(v[0]);
  };
  for (const [id, node] of Object.entries(prompt)) if (objectInfo[node.class_type]?.output_node) visit(id);
  if (!keep.size) return prompt;
  return Object.fromEntries(Object.entries(prompt).filter(([id]) => keep.has(id)));
}
