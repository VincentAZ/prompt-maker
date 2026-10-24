// Deterministic render cycles: shared by the browser and settings validation. No Brain calls.
export function normalizeSweep(value) {
  if (!value?.axes?.length) return null;
  if (!['cycle', 'combinations'].includes(value.mode)) throw new Error('Choose cycle together or every combination.');
  if (value.axes.length > 32) throw new Error('Use at most 32 changing settings per batch.');
  const axes = value.axes.map(a => {
    if (!['param', 'size', 'seed', 'loraOn', 'loraStrength'].includes(a.target) || typeof a.key !== 'string' || !a.key || a.key.length > 240 || ['__proto__', 'prototype', 'constructor'].includes(a.key)) throw new Error('Unknown batch setting.');
    if (!Array.isArray(a.values) || !a.values.length || a.values.length > 50) throw new Error('Each changing setting needs 1–50 values.');
    const values = a.values.map(v => {
      if (!['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)) || String(v).length > 240 || v === '') throw new Error('Use a number, option, or on/off value for each setting.');
      if (a.target === 'loraOn' && typeof v !== 'boolean') throw new Error('LoRA use must be on or off.');
      if (a.target === 'loraStrength' && typeof v !== 'number') throw new Error('LoRA strength must be a number.');
      if (a.target === 'seed' && (!Number.isSafeInteger(v) || v < 0 || v > 2 ** 48)) throw new Error('Seeds must be whole numbers from 0 to 281474976710656.');
      if (a.target === 'size' && !['aspectRatio', 'resolution', 'duration'].includes(a.key)) throw new Error('Unknown size setting.');
      if (a.target === 'size') {
        const parts = a.key === 'aspectRatio' ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(v)) : a.key === 'resolution' ? /^(\d{2,4})[x×](\d{2,4})$/.exec(String(v)) : null;
        if (a.key === 'duration') { if (!/^\d+(?:\.\d+)?s?$/.test(String(v)) || parseFloat(v) < 1 || parseFloat(v) > 20) throw new Error('Duration must be 1–20 seconds.'); }
        else if (!parts || Number(parts[1]) <= 0 || Number(parts[2]) <= 0) throw new Error('Use a positive width and height for shapes and sizes.');
      }
      return v;
    });
    return { target: a.target, key: a.key, label: String(a.label || a.key).slice(0, 180), values };
  });
  if (new Set(axes.map(a => `${a.target}:${a.key}`)).size !== axes.length) throw new Error('Each setting can appear only once.');
  const sweep = { workflowId: String(value.workflowId || '').slice(0, 100), mode: value.mode, axes };
  sweepRows(sweep, 1); // reject oversized combinations at save time too
  return sweep;
}
export function sweepRows(sweep, count) {
  if (!sweep?.axes?.length) return [];
  const { axes } = sweep;
  const total = sweep.mode === 'combinations' ? axes.reduce((n, a) => n * a.values.length, 1) : count;
  if (!Number.isInteger(total) || total < 1 || total > 50) throw new Error(`This batch would make ${total} renders. Use at most 50; reduce the values or cycle together.`);
  return Array.from({ length: total }, (_, i) => {
    let remaining = i;
    return axes.map(a => {
      const at = sweep.mode === 'combinations' ? remaining % a.values.length : i % a.values.length;
      remaining = Math.floor(remaining / a.values.length);
      return { ...a, value: a.values[at] };
    });
  });
}
export function sweepSetup(base, row, size) {
  const next = structuredClone(base);
  next.size = { ...size };
  next.loras ||= { tweaks: {}, added: [] };
  next.loras.tweaks ||= {};
  next.loras.added ||= [];
  next.overrides ||= {};
  for (const a of row) {
    if (a.target === 'param') next.overrides[a.key] = a.value;
    else if (a.target === 'seed') next.seed = { mode: 'fixed', value: a.value };
    else if (a.target === 'size') next.size[a.key] = a.value;
    else {
      const prop = a.target === 'loraOn' ? 'on' : 'strength';
      if (a.key.startsWith('+')) {
        const lora = next.loras.added.find(l => l.name === a.key.slice(1));
        if (!lora) throw new Error(`The batch LoRA ${a.key.slice(1)} is no longer in this workflow.`);
        lora[prop] = a.value;
      } else next.loras.tweaks[a.key] = { ...next.loras.tweaks[a.key], [prop]: a.value };
    }
  }
  return next;
}
