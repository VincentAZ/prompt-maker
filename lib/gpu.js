// One local GPU workload at a time. Do not kill unrelated processes or interrupt external renders.
import { setTimeout as delay } from 'node:timers/promises';
import { assertLocalUrl, listLlms } from './lmstudio.js';
import * as store from './store.js';

let tail = Promise.resolve();
let waiting = 0;
const releasers = new Map();
export const registerGpuRelease = (kind, release) => releasers.set(kind, release);
export const isOutOfMemory = err => /out.?of.?memory|CUDA.*alloc|not enough.*(?:VRAM|memory)/i.test(err?.message || String(err));
export function memoryError(err) {
  if (!isOutOfMemory(err) || err.status === 507) return err;
  return Object.assign(new Error('The graphics card ran out of memory. Prompt Maker releases idle Brain, render and voice models before switching tasks. Other apps may still be using the card: close their loaded models, or choose a smaller model, picture size or video duration, then try again. ' + (err.message || String(err)).slice(0, 650)), { status: 507 });
}
async function json(base, route, body) {
  const res = await fetch(new URL(route, assertLocalUrl(base)), { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Memory release failed (${res.status}) at ${route}. Update the local service and try again.`);
  return res.json().catch(() => ({}));
}
async function releaseBrain(settings) {
  const llms = await listLlms(settings.lmStudioUrl).catch(() => []); // LM Studio need not run to render or speak
  for (const m of llms.filter(m => m.loaded)) {
    if (!m.instances?.length) throw new Error('Update LM Studio to enable automatic GPU memory release, or unload its models before rendering or using Voices.');
    for (const id of m.instances) await json(settings.lmStudioUrl, '/api/v1/models/unload', { instance_id: id });
    await store.noteBrain(m.id, { ...(m.contextLoaded ? { room: m.contextLoaded } : {}), memoryReleasedAt: new Date().toISOString() });
  }
}
async function releaseComfy(settings, signal, onStatus) {
  let q;
  try { q = await json(settings.comfyUrl, '/queue'); } catch { return; } // ComfyUI is optional for Brain/voice work
  const deadline = Date.now() + 30 * 60e3;
  while (q.queue_running?.length || q.queue_pending?.length) {
    if (Date.now() > deadline) throw new Error('ComfyUI is still busy. Finish or cancel its renders, then try again.');
    onStatus('Waiting for ComfyUI to finish before freeing graphics memory…');
    await delay(500, undefined, { signal });
    q = await json(settings.comfyUrl, '/queue');
  }
  await json(settings.comfyUrl, '/free', { unload_models: true, free_memory: true });
}
export async function acquireGpu(kind, settings, { signal, onStatus = () => {} } = {}) {
  const before = tail;
  let unlock;
  tail = new Promise(resolve => { unlock = resolve; });
  if (waiting++) onStatus('Waiting for graphics memory…');
  const release = () => { waiting--; unlock(); };
  // A cancelled waiter leaves its place in the queue intact until the earlier work finishes.
  let onAbort;
  try {
    await Promise.race([before, signal && new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); }
    })].filter(Boolean));
  } catch (err) { before.finally(release); throw err; } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  try {
    signal?.throwIfAborted();
    for (const [owner, release] of releasers) if (owner !== kind) await release();
    if (kind !== 'brain') await releaseBrain(settings);
    if (kind !== 'render') await releaseComfy(settings, signal, onStatus);
    signal?.throwIfAborted();
    return release;
  } catch (err) { release(); throw memoryError(err); }
}
export async function withGpu(kind, settings, options, work) {
  const release = await acquireGpu(kind, settings, options);
  try { return await work(); } catch (err) { throw memoryError(err); } finally { release(); }
}
