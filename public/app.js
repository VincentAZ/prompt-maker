// Prompt Maker front end. Plain ES module, no dependencies, talks only to the local server.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// Smooth scrolling, unless the user asked their system for reduced motion.
const scrollMode = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

const state = {
  prev: [], // earlier runs kept on the stage so their renders can be compared with the new one
  models: [],
  settings: null,
  llms: [],
  llmOk: null,
  llmError: '',
  modelId: null,
  image: null, // { file } once stored on the server; { dataUrl } while it uploads
  video: null, // the motion video (character-animation models): { file, sheet, seconds, frames, width, height, ratio }
  imageRole: 'reference', // the user's choice; "animate" falls back to reference on image models
  length: 'medium',
  variations: 1,
  entry: null, // history entry behind the visible takes
  cards: [],
  timings: {},
  busy: false,
  controller: null,
  runId: null,
  stopping: false,
  history: [],
  historyFilter: '',
  historyFav: false,
  historyLimit: 48,
  editId: null,
  dirty: false,
  settingsDirty: false,
  chain: { steps: [], renders: 1, recipeId: null }, // the Then steps being built on Create (step ⑥)
  recipes: [], // saved chains
  run: null, // the chain run shown above the results
  chainActive: false, // a chain is running steps right now
  batchPick: '', // what Generate runs (step ⑤ Batch): '' no batch, a saved batch's id, or '*' every batch in order
  batchRun: null, // while batches run: { list, index, name, total, done, allDone, stopped }
  workflows: [],
  loraList: null, // every LoRA ComfyUI has, e.g. "krea2/film_grain.safetensors" (loaded when needed)
  loraPicker: { open: false, q: '' },
  wfStale: new Set(), // workflows edited in ComfyUI since Prompt Maker copied them
  wfMissing: new Map(), // workflow id → model files it needs that ComfyUI doesn't have
  trim: null, // { a, b }: the frames kept (a first, b after the last) while picking part of the motion video (✂️ Trim)
  downloads: [], // model downloads into ComfyUI (running in the server)
  comfy: null,
  renderRuns: new Set(),
  galleryKind: '',
  galleryModel: '',
};

// ---------- utilities ----------

const saved = {
  get(k, fallback) { try { const v = localStorage.getItem(`pm.${k}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(`pm.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Turns browser-level network failures into something a human can act on.
function friendly(err) {
  const msg = err?.message || String(err);
  if (/^(terminated|Failed to fetch|NetworkError|network error|Load failed)/i.test(msg)) {
    return 'Lost the connection to the Prompt Maker server. Is it still running? (Start it with ./start.sh)';
  }
  return msg;
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw Object.assign(new Error(friendly(err)), { appDown: true }); // the Prompt Maker server itself didn't answer
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

// POSTs and reads the server's newline-delimited JSON event stream.
// Without a body it's a GET (following something already running).
async function streamApi(path, body, onEvent, signal) {
  const res = await fetch(path, body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), data.missing ? { missing: data.missing } : {});
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
// action: optional { label, run } shown as a button in the toast (e.g. Undo), which then stays up longer.
function toast(msg, bad = false, action = null) {
  const t = $('#toast');
  t.hidden = true;
  void t.offsetWidth; // restart the pop-in animation
  t.textContent = msg;
  if (action) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'toast-act', textContent: action.label });
    b.addEventListener('click', () => { clearTimeout(toastTimer); t.hidden = true; action.run(); });
    t.append(b);
  }
  t.classList.toggle('bad', bad);
  t.classList.toggle('has-act', Boolean(action));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : bad ? 5000 : 2400);
}

// Screen-reader announcements (the stage itself is not a live region; streaming tokens would flood it).
function announce(msg) {
  const el = $('#srStatus');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = msg; });
}

const BASE_TITLE = 'Prompt Maker';
function setTitle(prefix) {
  document.title = prefix ? `${prefix} · ${BASE_TITLE}` : BASE_TITLE;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.busy) setTitle(''); });

async function copyText(text, btn) {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    ok = document.execCommand('copy');
    ta.remove();
  }
  if (!ok) return toast('Copy failed. Select the text and press Ctrl+C.', true);
  if (btn) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('copied'); }, 1400);
  } else toast('📋 Copied to clipboard');
  announce('Copied to clipboard');
}

const countWords = s => (s.trim().match(/\S+/g) || []).length;

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function dayGroup(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 31) return 'This month';
  return 'Earlier';
}

function autosize(ta) {
  if (!ta.offsetParent) return; // hidden: measured again when it becomes visible
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  sel.value = options.includes(value) ? value : (options[0] ?? '');
}

function setActive(root, value) {
  $$('button[data-value]', root).forEach(b => {
    const on = b.dataset.value === String(value);
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
}

// "Click again to confirm" instead of blocking dialogs.
function confirmClick(btn, label, action) {
  if (btn.dataset.armed) {
    clearTimeout(btn._armT);
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.armLabel;
    return action();
  }
  btn.dataset.armed = '1';
  btn.dataset.armLabel = btn.textContent;
  btn.textContent = label;
  btn.classList.add('armed');
  btn._armT = setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.armLabel;
  }, 3000);
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const takesText = texts => (texts.length === 1 ? texts[0] : texts.map((t, i) => `--- Take ${i + 1} ---\n${t}`).join('\n\n'));

// ---------- model identity ----------

const PALETTE = ['#ff4d8d', '#22d3ee', '#a47bff', '#c6ff4d', '#ffb347', '#3ee08f'];
function modelColor(m) {
  if (m?.color) return m.color;
  let h = 0;
  for (const c of m?.id || m?.name || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const kindIcon = kind => (kind === 'video' ? '🎬' : '📷');
const modelById = id => state.models.find(m => m.id === id) || null;
const currentModel = () => modelById(state.modelId);

function lengthTarget(model, length) {
  const r = /(\d+)\s*[–—-]\s*(\d+)/.exec(model?.lengthGuide?.[length] || '');
  return r ? [Number(r[1]), Number(r[2])] : null;
}

// "16:9", "2.35:1" or "1920×1080" → width / height.
function ratioOf(s) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(String(s || '').trim());
  return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
}
const ratioDist = (a, b) => Math.abs(Math.log(a / b));

// The model's aspect option closest to a shape (width / height).
function closestAspect(m, ratio) {
  let best = null;
  for (const a of m?.aspectRatios || []) {
    const ar = ratioOf(a);
    if (ar && ratio && (!best || ratioDist(ar, ratio) < ratioDist(ratioOf(best), ratio))) best = a;
  }
  return best;
}

// A W×H resolution in the aspect's shape (e.g. 9:16 → 1080×1920, not 1920×1080), nearest in size to current.
function resolutionFor(m, aspect, current) {
  const ar = ratioOf(aspect);
  if (!m || !ar) return null;
  const cur = ratioOf(current);
  if (cur && ratioDist(cur, ar) < 0.05 && m.resolutions.includes(current)) return current;
  const pixels = s => s.split(/[×x]/).reduce((a, b) => a * Number(b), 1);
  const matches = m.resolutions.filter(r => ratioOf(r) && ratioDist(ratioOf(r), ar) < 0.05);
  if (!matches.length) return null;
  const target = cur ? pixels(current) : pixels(matches[0]);
  return matches.sort((a, b) => Math.abs(pixels(a) - target) - Math.abs(pixels(b) - target))[0];
}

// A shape as a short ratio: 0.684 → "13:19"; "1.46:1" when no small one fits.
function ratioLabel(r) {
  for (let q = 1; q <= 32; q++) {
    const p = Math.round(r * q);
    if (p >= 1 && p <= 64 && ratioDist(p / q, r) < 0.005) return `${p}:${q}`;
  }
  return `${r.toFixed(2)}:1`;
}

// A video's first frame sets its shape, so a video model gets the image's own ratio when none of its presets fits.
function ownAspect(m, ratio) {
  if (m?.kind !== 'video' || !ratio || !m.aspectRatios.length) return null;
  return m.aspectRatios.some(a => ratioOf(a) && ratioDist(ratioOf(a), ratio) < 0.01) ? null : ratioLabel(ratio);
}

// The Resolution choices for an Aspect: the model's own, or for an image's own ratio, its W×H sizes redrawn in that
// shape (same pixel counts, multiples of 32). Models with "768p"/"2K" sizes keep theirs; the size follows the ratio.
function sizeChoices(m, aspect) {
  const ar = ratioOf(aspect);
  if (!m || !ar || m.aspectRatios.includes(aspect)) return m?.resolutions || [];
  const snap = v => Math.max(32, Math.round(v / 32) * 32);
  const sizes = m.resolutions.map(r => /^(\d+)\s*[×x]\s*(\d+)$/.exec(r)).filter(Boolean).map(x => Number(x[1]) * Number(x[2]))
    .sort((a, b) => a - b).map(px => `${snap(Math.sqrt(px * ar))}×${snap(Math.sqrt(px / ar))}`);
  return sizes.length ? [...new Set(sizes)] : m.resolutions;
}

// Fills Aspect with the model's presets, plus the attached image's own ratio when it needs one.
// The shape the clip takes: the attached image's. On a character-animation model that's the character's, as in
// Wan-AI's own code (the motion video is cropped to it, at the center); the motion video's until there's a character.
const shapeRatio = (m = currentModel()) => state.image?.ratio || (m?.motionVideo && state.video?.ratio) || null;
const shapeIcon = (m = currentModel()) => (!state.image?.ratio && m?.motionVideo && state.video?.ratio ? '🕺' : '🖼️');

function fillAspect(m, value) {
  const own = ownAspect(m, shapeRatio(m));
  fillSelect($('#aspect'), own ? [...m.aspectRatios, own] : m.aspectRatios, value);
  if (own) $(`#aspect option[value="${own}"]`).textContent = `${own} ${shapeIcon(m)}`; // the image icon, like the "from image" note
}

// Sets Aspect to the attached image's shape: its own ratio on a video model, else the model's closest option.
function matchImageAspect() {
  const m = currentModel();
  const r = shapeRatio(m);
  if (!m || !r) return null;
  const own = ownAspect(m, r);
  if (own) fillAspect(m, own);
  const best = own || closestAspect(m, r);
  if (!best) return null;
  $('#aspect').value = best;
  syncResolution();
  $('#aspectNote').hidden = false;
  const fromVideo = shapeIcon(m) === '🕺';
  $('#aspectNote').textContent = fromVideo ? '🕺 from video' : m.motionVideo ? '🧍 from character' : '🖼️ from image';
  $('#aspectNote').title = fromVideo ? 'Picked to match your motion video\'s shape' : m.motionVideo ? 'Picked to match your character image\'s shape: Wan Animate 2 makes the clip in that shape' : 'Picked to match your image\'s shape';
  savePrefs();
  return best;
}

// Keeps the resolution in step with the aspect ratio (and its choices, for an image's own ratio).
function syncResolution() {
  const m = currentModel();
  if (!m) return;
  const sel = $('#resolution');
  const aspect = $('#aspect').value;
  const choices = sizeChoices(m, aspect);
  const cur = sel.value; // its size picks the nearest new one
  if (choices.join() !== [...sel.options].map(o => o.value).join()) fillSelect(sel, choices, cur);
  const r = resolutionFor({ ...m, resolutions: choices }, aspect, cur);
  if (r) sel.value = r;
}

// The image roles a model offers: its own list (e.g. only "character" for Wan Animate 2), else reference and recreate,
// plus animate on video models. The role actually used is the one picked if offered, else the first.
const rolesFor = m => (m?.imageRoles?.length ? m.imageRoles : ['reference', 'recreate', ...(m?.kind === 'video' ? ['animate'] : [])]);
const effectiveRole = () => {
  const offered = rolesFor(currentModel());
  return offered.includes(state.imageRole) ? state.imageRole : offered[0];
};

// ---------- navigation ----------

const VIEWS = ['create', 'history', 'gallery', 'models', 'settings'];
const isView = name => $(`#view-${name}`).classList.contains('active');

// Textareas measured while hidden (or at another width) need re-measuring.
function resizeTextareas() {
  $$('.view.active .prompt-text:not([hidden]), .view.active .example textarea').forEach(autosize);
}
window.addEventListener('resize', resizeTextareas);

// While a job step runs, its tools don't pull you back to Create from another page.
let quietNav = false;

function showView(name, { push = true } = {}) {
  const [view, sub] = String(name).split('/');
  name = VIEWS.includes(view) ? view : 'create';
  if (quietNav && name === 'create' && !isView('create')) return;
  if (name === 'models') showModelsPane(sub || modelsPane, { push: false });
  $$('.tabs button').forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  const hash = name === 'models' && modelsPane === 'brains' ? '#models/brains' : `#${name}`;
  if (push && location.hash !== hash) history.pushState(null, '', hash);
  if (name === 'history') loadHistory();
  if (name === 'gallery') loadGallery();
  if (name === 'settings' && !state.settingsDirty) renderSettings();
  if (name === 'settings') showOutputDir();
  if (name === 'settings') loadServices();
  if (name === 'settings') loadProviders();
  if (name === 'models' && !state.dirty && (!state.editId || !modelById(state.editId))) {
    if (state.models.length) editModel(state.modelId || state.models[0].id); else newModel();
  } else if (name === 'models') renderWorkflowList(); // workflows may have changed elsewhere (e.g. in ComfyUI)
  requestAnimationFrame(resizeTextareas);
}
window.addEventListener('popstate', () => showView(location.hash.slice(1), { push: false }));
$$('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- LM Studio ("Brain") ----------

let llmLoading = null;
function loadLlms() {
  llmLoading ??= (async () => {
    const res = await api('/api/llms').catch(err => ({ ok: false, error: err.message, appDown: Boolean(err.appDown), models: [] }));
    const cameBack = state.llmOk === false && res.ok;
    const appBack = state.appDown && !res.appDown;
    state.appDown = Boolean(res.appDown);
    state.llmOk = res.ok;
    state.llmError = res.error || '';
    if (res.ok) state.llms = res.models; // offline: keep last-known names for the picker
    else if (res.models?.length) state.llms = [...state.llms.filter(m => !m.cloud), ...res.models]; // cloud Brains still work
    renderLlmSelect();
    renderBrains();
    renderBanner();
    renderVisionWarning();
    if (appBack && !state.booted) location.reload(); // the page came from its offline copy: load it for real
    else if (appBack) {
      toast(res.ok ? '🔌 Prompt Maker is back' : '🔌 Prompt Maker is back, but LM Studio is still off');
      if (/Prompt Maker server/.test($('#stageError').textContent)) showError('');
    } else if (cameBack) {
      toast('🔌 LM Studio is back');
      if (/LM Studio/.test($('#stageError').textContent)) showError('');
    }
    llmLoading = null;
  })();
  return llmLoading;
}

// While LM Studio or the app's own server is down (or LM Studio is still indexing its models), keep checking
// so the page catches up on its own.
setInterval(() => {
  if ((state.llmOk === false || (state.llmOk && !state.llms.length)) && !document.hidden && !state.busy) loadLlms();
}, 5000);

// Turns on LM Studio's local server (works with the app open or closed).
async function startLmStudio(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await api('/api/lmstudio/start', { method: 'POST' });
    await loadLlms();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastFocusRefresh < 5000 || state.busy) return;
  lastFocusRefresh = Date.now();
  loadLlms();
});

function renderBanner() {
  const down = state.llmOk === false;
  $('#banner').hidden = !down;
  // With the app's server gone, the page can't start anything itself, but the promptmaker:// link can, where
  // the app has set it up (remembered from when the server was up).
  const canLaunch = Boolean(state.appDown && saved.get('launcher', false));
  $('#bannerStart').hidden = Boolean(state.appDown);
  $('#bannerLaunch').hidden = !canLaunch;
  if (!down) return;
  $('#bannerTitle').textContent = state.appDown ? "Prompt Maker's server isn't running." : "LM Studio's server is off.";
  $('#bannerLong').textContent = !state.appDown
    ? `Nothing is answering at ${state.settings?.lmStudioUrl || 'localhost:1234'}. Start it here, or in LM Studio → Developer. It reconnects on its own.`
    : canLaunch
      ? 'It stopped, or your computer restarted. Click Start (the first time, your browser asks to open Prompt Maker: allow it). This page reconnects on its own.'
      : 'It stopped, or your computer restarted. Open Prompt Maker from your app menu, or run ./start.sh in its folder. This page reconnects on its own.';
}

function renderLlmSelect() {
  const sel = $('#llmSelect');
  const current = state.settings?.llmModel || '';
  if (!state.llmOk) {
    const known = state.llms.find(m => m.id === current);
    sel.innerHTML = `<option value="${esc(current)}">${current ? esc(known?.name || current) : 'LM Studio offline'}</option>`;
    updateLlmDot();
    renderLlmPick();
    return;
  }
  const label = m => {
    const speed = brainSpeed(m);
    return [`${brainIcon(m)}${m.name}`, speed && `~${fmtSecs(speed.seconds)}`, !m.cloud && m.loaded && 'loaded', isNewBrain(m) && 'new'].filter(Boolean).join('  · ');
  };
  const group = (title, list, why = () => '') => (list.length
    ? `<optgroup label="${esc(title)}">${list.map(m => `<option value="${esc(m.id)}">${esc(label(m) + why(m))}</option>`).join('')}</optgroup>`
    : '');
  const known = state.llms.some(m => m.id === current);
  const model = currentModel();
  const suggested = suggestedBrains(model, Boolean(state.image));
  const reasons = new Map(suggested.map(x => [x.m.id, x.why]));
  const rest = state.llms.filter(m => !reasons.has(m.id));
  sel.innerHTML =
    '<option value="">Auto: whatever is loaded</option>' +
    (current && !known ? `<option value="${esc(current)}">${esc(current)} (missing)</option>` : '') +
    group(`Suggested for ${model?.name}`, suggested.map(x => x.m), m => ` — ${reasons.get(m.id)}`) +
    group('Loaded now', rest.filter(m => !m.cloud && m.loaded)) +
    group('Vision models 👁 (can see images)', rest.filter(m => !m.cloud && !m.loaded && m.vision)) +
    group('Text-only models', rest.filter(m => !m.cloud && !m.loaded && !m.vision)) +
    group('☁️ Cloud (sends your prompts to the provider)', rest.filter(m => m.cloud));
  sel.value = current;
  updateLlmDot();
  renderLlmPick();
}

// ---------- Brain picker (top bar) ----------
// A searchable menu over the hidden #llmSelect: type to narrow it down, sort it smart, by last used or by name.

const brainIcon = m => (m.cloud ? '☁️ ' : m.vision ? '👁 ' : '');
const lastUsedAt = m => [m.stats?.lastUsed, m.record?.last].filter(Boolean).sort().at(-1) || '';
const escRe = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const searchWords = q => q.toLowerCase().split(/\s+/).filter(Boolean);
let llmSort = saved.get('llmSort', 'smart');
let llmActive = 0; // the highlighted option, picked by Enter

// 0 if the Brain doesn't match the search; else higher for better matches. Every word typed must appear in its
// name or id, in any order ("qwen 27" finds "Qwen3.8 27B …"); names that start with the search come first.
function brainMatch(m, q) {
  const words = searchWords(q);
  if (!words.length) return 1;
  const name = m.name.toLowerCase();
  if (!words.every(w => `${name} ${m.id.toLowerCase()}`.includes(w))) return 0;
  return name.startsWith(words[0]) ? 3 : new RegExp(`(^|[^a-z0-9])${escRe(words[0])}`).test(name) ? 2 : 1;
}

function highlight(text, q) {
  const words = searchWords(q);
  if (!words.length) return esc(text);
  return text.split(new RegExp(`(${words.map(escRe).join('|')})`, 'gi')).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

const byName = (a, b) => a.name.localeCompare(b.name);
const byRecent = (a, b) => lastUsedAt(b).localeCompare(lastUsedAt(a)) || byName(a, b);

function renderLlmPick() {
  const current = state.settings?.llmModel || '';
  const m = llmById(current);
  $('#llmPickName').textContent = !state.llmOk ? (current ? m?.name || current : state.appDown ? 'Not connected' : 'LM Studio offline')
    : !current ? 'Auto: whatever is loaded'
    : m ? `${brainIcon(m)}${m.name}` : `${current} (missing)`;
  if (!$('#llmMenu').hidden) renderLlmMenu();
}

// The menu's groups for the search and sort: [{ title?, items: [brain] }]. "Auto" is { id: '' }.
// Filters for the Brain menu and Models → Brains. Pick any number of traits (a Brain needs all of them) and any
// number of providers (a Brain from any of them); nothing picked shows every Brain.
const isUncensored = m => /uncensor|abliterat|heretic|nsfw|unfilter|unalign|dolphin|lewd|erotic|\bderestrict/i.test(`${m.name} ${m.id}`);
const BRAIN_TRAITS = {
  vision: { label: '👁 Vision', test: m => m.vision },
  uncensored: { label: '🔓 Uncensored', test: isUncensored },
  loaded: { label: '⚡ Loaded', test: m => !m.cloud && m.loaded },
};
const providerOf = m => (m.cloud ? m.providerId || m.cloud : 'local');
// [{ key, label, n }]: LM Studio first, then each cloud provider by name.
function brainProviders() {
  const by = new Map();
  for (const m of state.llms) {
    const key = providerOf(m);
    if (!by.has(key)) by.set(key, { key, label: m.cloud ? `☁️ ${m.cloud}` : '💻 LM Studio', n: 0 });
    by.get(key).n++;
  }
  return [...by.values()].sort((a, b) => (b.key === 'local') - (a.key === 'local') || a.label.localeCompare(b.label));
}
function loadBrainFilter(key) {
  const f = saved.get(key, {});
  return {
    traits: Array.isArray(f?.traits) ? f.traits.filter(t => BRAIN_TRAITS[t]) : [],
    providers: Array.isArray(f?.providers) ? f.providers.filter(p => typeof p === 'string') : [],
  };
}
const isFiltered = f => f.traits.length > 0 || f.providers.length > 0;
const brainFilterTest = f => m => f.traits.every(t => BRAIN_TRAITS[t].test(m)) && (!f.providers.length || f.providers.includes(providerOf(m)));
function brainFilterLabel(f) {
  const names = new Map(brainProviders().map(p => [p.key, p.label]));
  return [...f.traits.map(t => BRAIN_TRAITS[t].label), f.providers.map(p => names.get(p) || p).join(' or ')].filter(Boolean).join(' + ');
}
// Trait chips, then provider checkboxes (only when there's more than one provider to choose from).
function brainFilterControls(f) {
  const chip = (attrs, on, label, n) => `<button type="button" ${attrs} aria-pressed="${on}" class="${on ? 'active' : ''}">${label} <span class="n">${n}</span></button>`;
  const traits = chip('data-all', !isFiltered(f), 'All', state.llms.length) + Object.entries(BRAIN_TRAITS)
    .map(([key, t]) => [key, t, state.llms.filter(t.test).length])
    .filter(([key, , n]) => n || f.traits.includes(key))
    .map(([key, t, n]) => chip(`data-trait="${key}"`, f.traits.includes(key), t.label, n)).join('');
  const providers = brainProviders();
  for (const key of f.providers) if (!providers.some(p => p.key === key)) providers.push({ key, label: key, n: 0 }); // removed, but still ticked
  const boxes = providers.length < 2 ? '' : `<div class="brain-providers" role="group" aria-label="Providers">${providers.map(p =>
    `<label><input type="checkbox" data-provider="${esc(p.key)}"${f.providers.includes(p.key) ? ' checked' : ''}> ${esc(p.label)} <span class="n">${p.n}</span></label>`).join('')}</div>`;
  return `<div class="brain-traits" role="group" aria-label="Show only">${traits}</div>${boxes}`;
}
// Wires a filter box: changes `f` in place, saves it under `key`, then calls `done`.
function wireBrainFilter(box, f, key, done) {
  box.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-all]')) {
      f.traits = [];
      f.providers = [];
    } else if (b.dataset.trait) {
      const t = b.dataset.trait;
      f.traits = f.traits.includes(t) ? f.traits.filter(x => x !== t) : [...f.traits, t];
    } else return;
    saved.set(key, f);
    done();
  });
  box.addEventListener('change', e => {
    const p = e.target.dataset.provider;
    if (p === undefined) return;
    f.providers = e.target.checked ? [...f.providers, p] : f.providers.filter(x => x !== p);
    saved.set(key, f);
    done();
  });
}
const llmFilter = loadBrainFilter('llmFilters');

function llmMenuGroups(q, suggested) {
  const auto = { id: '', name: 'Auto: whatever is loaded' };
  const pool = state.llms.filter(brainFilterTest(llmFilter));
  const current = state.settings?.llmModel || '';
  const inUse = !isFiltered(llmFilter) && !q ? pool.filter(m => m.id === current) : [];
  const head = !isFiltered(llmFilter) ? [{ items: [auto] }, { title: 'In use', items: inUse }] : [];
  const others = pool.filter(m => !inUse.includes(m));
  if (q) {
    const hits = pool.map(m => ({ m, score: brainMatch(m, q) })).filter(x => x.score);
    hits.sort((a, b) => b.score - a.score || (llmSort === 'name' ? byName(a.m, b.m) : byRecent(a.m, b.m)));
    return [{ items: hits.map(x => x.m) }];
  }
  if (llmSort === 'name') return [...head, { title: inUse.length ? 'All Brains' : '', items: [...others].sort(byName) }];
  if (llmSort === 'recent') {
    return [
      ...head,
      { title: 'Last used', items: others.filter(lastUsedAt).sort(byRecent) },
      { title: 'Not used yet', items: others.filter(m => !lastUsedAt(m)).sort(byName) },
    ];
  }
  const fitting = suggested.filter(x => others.includes(x.m));
  const ids = new Set(fitting.map(x => x.m.id));
  const rest = others.filter(m => !ids.has(m.id));
  return [
    ...head,
    { title: `Suggested for ${currentModel()?.name}`, items: fitting.map(x => x.m) },
    { title: 'Loaded now', items: rest.filter(m => !m.cloud && m.loaded) },
    { title: 'Vision 👁 (can see images)', items: rest.filter(m => !m.cloud && !m.loaded && m.vision) },
    { title: 'Text-only', items: rest.filter(m => !m.cloud && !m.loaded && !m.vision) },
    { title: '☁️ Cloud (sends your prompts to the provider)', items: rest.filter(m => m.cloud) },
  ];
}

function renderLlmMenu() {
  const q = $('#llmSearch').value.trim();
  const current = state.settings?.llmModel || '';
  const suggested = suggestedBrains(currentModel(), Boolean(state.image));
  const why = new Map(suggested.map(x => [x.m.id, x.why]));
  let i = 0;
  const option = m => {
    const speed = m.id && brainSpeed(m);
    const last = m.id && lastUsedAt(m);
    const detail = !m.id ? 'Uses the model LM Studio has loaded'
      : [why.get(m.id), m.cloud && `cloud: ${m.cloud}`, m.vision ? 'sees images' : m.vision === false ? 'text-only' : '', speed && `~${fmtSecs(speed.seconds)}`, last && `used ${timeAgo(last)}`, !m.cloud && m.loaded && 'loaded', isNewBrain(m) && 'new'].filter(Boolean).join(' · ');
    return `<li role="option" id="llmOpt${i}" data-i="${i++}" data-id="${esc(m.id)}" aria-selected="${m.id === current}"><span class="n">${m.id ? brainIcon(m) : ''}${highlight(m.name, q)}${m.id && isUncensored(m) ? ' <span class="badge" title="Uncensored">🔓</span>' : ''}</span><span class="d">${esc(detail)}</span></li>`;
  };
  const html = llmMenuGroups(q, suggested).filter(g => g.items.length)
    .map(g => (g.title ? `<li class="grp" role="presentation">${esc(g.title)}</li>` : '') + g.items.map(option).join('')).join('');
  const none = `No Brain matches${q ? ` "${q}"` : ''}${isFiltered(llmFilter) ? ` ${brainFilterLabel(llmFilter)}` : ''}.`;
  $('#llmList').innerHTML = html || `<li class="none" role="presentation">${esc(none)}</li>`;
  setLlmActive(Math.min(llmActive, i - 1));
  $$('.llm-sort button').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === llmSort);
    b.setAttribute('aria-checked', String(b.dataset.sort === llmSort));
  });
  $('#llmFilters').innerHTML = brainFilterControls(llmFilter);
}

function setLlmActive(i, scroll = true) {
  const opts = $$('#llmList [role="option"]');
  llmActive = Math.max(0, Math.min(i, opts.length - 1));
  opts.forEach((o, k) => o.classList.toggle('active', k === llmActive));
  const el = opts[llmActive];
  $('#llmSearch').setAttribute('aria-activedescendant', el?.id || '');
  if (scroll) el?.scrollIntoView({ block: 'nearest' });
}

function openLlmMenu() {
  $('#llmSearch').value = '';
  $('#llmMenu').hidden = false;
  $('#llmPick').setAttribute('aria-expanded', 'true');
  llmActive = 0;
  renderLlmMenu();
  setLlmActive(Math.max(0, $$('#llmList [role="option"]').findIndex(o => o.getAttribute('aria-selected') === 'true')));
  $('#llmSearch').focus();
}

function closeLlmMenu({ focus = true } = {}) {
  if ($('#llmMenu').hidden) return;
  $('#llmMenu').hidden = true;
  $('#llmPick').setAttribute('aria-expanded', 'false');
  if (focus) $('#llmPick').focus();
}

function pickLlm(id) {
  closeLlmMenu();
  if (id !== (state.settings?.llmModel || '')) setBrain(id);
}

$('#llmPick').addEventListener('click', () => ($('#llmMenu').hidden ? openLlmMenu() : closeLlmMenu()));
$('#llmSearch').addEventListener('input', () => {
  llmActive = 0;
  renderLlmMenu();
});
$('#llmSearch').addEventListener('keydown', e => {
  const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
  if (move) {
    e.preventDefault();
    setLlmActive(llmActive + move);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const el = $$('#llmList [role="option"]')[llmActive];
    if (el) pickLlm(el.dataset.id);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation(); // don't also stop a run
    closeLlmMenu();
  } else if (e.key === 'Tab') closeLlmMenu({ focus: false });
});
$('#llmList').addEventListener('click', e => {
  const el = e.target.closest('[role="option"]');
  if (el) pickLlm(el.dataset.id);
});
$('#llmList').addEventListener('mousemove', e => {
  const el = e.target.closest('[role="option"]');
  if (el && Number(el.dataset.i) !== llmActive) setLlmActive(Number(el.dataset.i), false);
});
wireBrainFilter($('#llmFilters'), llmFilter, 'llmFilters', () => {
  llmActive = 0;
  renderLlmMenu();
  $('#llmSearch').focus();
});
$$('.llm-sort button').forEach(b => b.addEventListener('click', () => {
  llmSort = b.dataset.sort;
  saved.set('llmSort', llmSort);
  llmActive = 0;
  renderLlmMenu();
  $('#llmSearch').focus();
}));
document.addEventListener('pointerdown', e => {
  if (!$('#llmMenu').hidden && !e.target.closest('#llmBox')) closeLlmMenu({ focus: false });
});

function selectedLlm() {
  const id = state.settings?.llmModel;
  if (!id) return state.llms.find(m => m.loaded) || null;
  return state.llms.find(m => m.id === id) || null;
}

function updateLlmDot() {
  const dot = $('#llmDot');
  const box = $('#llmBox');
  if (!state.llmOk) {
    dot.className = 'dot bad';
    box.title = state.llmError || 'LM Studio is not reachable';
    return;
  }
  const m = selectedLlm();
  if (!m) {
    dot.className = 'dot warn';
    box.title = 'Nothing loaded yet. Pick a model; LM Studio loads it on first use.';
  } else if (m.loaded) {
    dot.className = 'dot ok';
    box.title = `${m.name} is loaded and ready${m.vision ? ' (can see images)' : ' (text-only)'}`;
  } else {
    dot.className = 'dot warn';
    box.title = `${m.name} loads on first use, so the first run takes a few extra seconds`;
  }
  if (!m) return;
  const level = brainThinking(m);
  const note = level === 'off' ? thinkNote(m) : '';
  box.title += `\nThinking: ${THINKING_LABELS[level]}${m.thinking ? " (this Brain's own setting)" : ''}${note ? `. It ${note}` : ''}`;
  const speed = brainSpeed(m);
  if (speed) box.title += `\nAbout ${fmtSecs(speed.seconds)} per prompt (${speed.from})`;
}

// How "Thinking: Off" works for a Brain: LM Studio's own switch, or what the app learned by using it.
function thinkNote(m) {
  if (m.thinkSwitch) return 'LM Studio can switch it off';
  return {
    quiet: "doesn't think when Thinking is Off",
    trick: 'ignores Thinking: Off, so Prompt Maker switches it off another way',
    stubborn: 'keeps thinking even with Thinking: Off, so it is slow and needs a high Max tokens',
  }[m.thinkOff] || '';
}

const THINKING_LABELS = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', default: "Model's default" };
const brainThinking = m => m.thinking || state.settings?.thinking || 'off';
const llmById = id => state.llms.find(m => m.id === id);
const fmtSecs = s => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const isNewBrain = m => !m.stats?.runs && !m.check && !m.record;

// Seconds per prompt: from your runs (those that didn't include loading), else from the Quick check.
function brainSpeed(m) {
  const s = m.stats;
  if (s?.timed) return { seconds: s.seconds / s.timed, from: `${s.timed} run${s.timed > 1 ? 's' : ''}` };
  const checked = [m.check?.image, m.check?.video].filter(x => x?.ok);
  if (checked.length) return { seconds: checked.reduce((a, x) => a + x.seconds, 0) / checked.length, from: 'Quick check' };
  return null;
}

// How well a Brain suits a target model: what you rendered, starred and refined with it (for this model, then for
// others of the same kind), its Quick check, and how often it failed. { score, why, proven }: why is a short reason
// ('' with nothing to go on); proven means it comes from your own renders or ⭐, not only a check.
function brainFit(m, model) {
  if (!model) return { score: 0, why: '' };
  const r = m.record?.byModel?.[model.id] || {};
  const k = m.record?.[model.kind] || {};
  const kind = model.kind === 'video' ? 'video' : 'image';
  const check = m.check?.[kind];
  const s = m.stats || {};
  let score = 3 * (r.fav || 0) + 2 * (r.rendered || 0) + 0.5 * (r.refined || 0) + 0.25 * (r.takes || 0)
    + 0.5 * ((k.rendered || 0) - (r.rendered || 0)) + 1.5 * ((k.fav || 0) - (r.fav || 0));
  if (check) score += check.ok ? 1 : -2;
  if (s.runs >= 3) score -= (4 * ((s.room || 0) + (s.empty || 0) + (s.refused || 0))) / s.runs;
  if (m.thinkOff === 'stubborn' && brainThinking(m) === 'off') score -= 2;
  const why = r.fav || r.rendered ? [r.fav && `⭐ ${r.fav}`, r.rendered && `${r.rendered} rendered`].filter(Boolean).join(' · ')
    : k.fav || k.rendered ? [k.fav && `⭐ ${k.fav}`, k.rendered && `${k.rendered} rendered`].filter(Boolean).join(' · ') + ` with other ${kind} models`
    : check?.ok ? `passed the ${kind} check`
    : r.takes ? `wrote ${r.takes} take${r.takes > 1 ? 's' : ''}` : '';
  return { score, why, proven: Boolean(r.fav || r.rendered || k.fav || k.rendered) };
}

// Up to 3 Brains worth suggesting for a model, best first (only ones that see images when there's an image).
function suggestedBrains(model, needsVision) {
  return state.llms
    .filter(m => !needsVision || m.vision !== false)
    .map(m => ({ m, ...brainFit(m, model) }))
    .filter(x => x.why && x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function renderVisionWarning() {
  const llm = selectedLlm();
  const blind = Boolean(state.image && llm && llm.vision === false);
  const warn = $('#visionWarn');
  warn.hidden = !blind;
  if (blind) warn.textContent = `🙈 ${llm.name} can't see images. Switch the Brain (top right) to a 👁 vision model.`;
}

// Makes a model the Brain (or '' for "whatever is loaded").
async function setBrain(id) {
  const m = llmById(id);
  if (m?.cloud && !(await cloudConsent(m))) {
    $('#llmSelect').value = state.settings?.llmModel || '';
    return renderLlmPick();
  }
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: { llmModel: id } });
    $('#llmSelect').value = id;
    updateLlmDot();
    renderLlmPick();
    renderVisionWarning();
    renderBrains();
    const m = selectedLlm();
    const speed = m && brainSpeed(m);
    toast(id ? `🧠 Brain: ${m?.cloud ? '☁️ ' : ''}${m?.name || id}${speed ? ` · about ${fmtSecs(speed.seconds)} per prompt` : ''}` : '🧠 Brain: auto (uses whatever is loaded)');
  } catch (err) {
    toast(err.message, true);
  }
}
$('#llmSelect').addEventListener('change', e => setBrain(e.target.value));
$('#llmRefresh').addEventListener('click', async () => {
  await loadLlms();
  toast(state.llmOk ? `🔄 ${state.llms.length} models found in LM Studio` : '🔌 LM Studio is not reachable', !state.llmOk);
});
$('#bannerRetry').addEventListener('click', async () => {
  await loadLlms();
  if (!state.llmOk) toast(state.appDown ? "🔌 Prompt Maker's server still isn't answering" : '🔌 Still no answer from LM Studio', true);
});
$('#bannerStart').addEventListener('click', e => startLmStudio(e.currentTarget));

// ---------- create: form ----------

const SURPRISES = [
  'a woman at the beach with a soda in her hand, golden hour',
  'a neon-soaked cyberpunk ramen stall in the rain',
  'a claymation fox reading the morning newspaper',
  'an astronaut skateboarding down a desert highway at dusk',
  'a grandma DJ-ing a rooftop party in Tokyo',
  'a tiny dragon napping in a teacup',
  'a 1970s roller disco, mirror ball spinning',
  'a lighthouse in a storm, waves exploding on the rocks',
  'a street vendor flipping crêpes in Paris at dawn',
  'a samurai walking through a field of red spider lilies',
  'a corgi surfing a massive turquoise wave',
  'a jazz trio in a smoky 1950s basement club',
  'a camel caravan crossing dunes under the Milky Way',
  'a chef torching crème brûlée, extreme close-up',
  'a vintage rally car drifting through a mountain hairpin',
  'a ballerina dancing in an abandoned greenhouse',
  'koi fish swirling in a rainy pond, seen from above',
  'a robot barista pouring latte art',
];
const TRY = [
  ['🏖️ Beach + soda', 0], ['🍜 Cyberpunk ramen', 1], ['🦊 Claymation fox', 2], ['🛹 Desert astronaut', 3], ['🐉 Teacup dragon', 5], ['🏄 Surfing corgi', 10],
];
$('#tryChips').innerHTML = TRY.map(([label, i]) => `<button type="button" class="chip-btn" data-i="${i}">${esc(label)}</button>`).join('');
$('#tryChips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) replaceTheme(SURPRISES[b.dataset.i]);
});

function sizeTheme() {
  const t = $('#theme');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, 320)}px`;
}

// Replaces the theme in a way Ctrl+Z can undo, and offers a one-click Undo chip.
let themeUndo = null;
function replaceTheme(text, { focus = true } = {}) {
  const t = $('#theme');
  const prev = t.value;
  if (prev === text) return;
  t.focus({ preventScroll: true });
  t.select();
  if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) {
    t.value = text;
    t.dispatchEvent(new Event('input'));
  }
  if (!focus) t.blur();
  themeUndo = prev.trim() ? prev : null;
  $('#themeUndo').hidden = !themeUndo;
  clearTimeout(replaceTheme.timer);
  replaceTheme.timer = setTimeout(() => { themeUndo = null; $('#themeUndo').hidden = true; }, 30000);
}
$('#themeUndo').addEventListener('click', () => {
  const prev = themeUndo;
  if (prev === null) return;
  replaceTheme(prev);
  themeUndo = null;
  $('#themeUndo').hidden = true;
  toast('↶ Your theme is back');
});

let surpriseIdx = Math.floor(Math.random() * SURPRISES.length);
$('#surpriseBtn').addEventListener('click', () => {
  surpriseIdx = (surpriseIdx + 1 + Math.floor(Math.random() * (SURPRISES.length - 1))) % SURPRISES.length;
  replaceTheme(SURPRISES[surpriseIdx]);
});

// Rotating example placeholder while the theme box is empty.
// Rotating example placeholder while the theme box is empty. When animating, the theme says what happens.
const MOTIONS = [
  'she takes a sip and laughs as the camera slowly pushes in',
  'wind picks up, hair and fabric ripple, slow orbit around the subject',
  'he turns toward the camera and smiles, gentle handheld drift',
  'waves roll in while the camera cranes up to reveal the bay',
];
// Character animation: the motion video sets the moves, so the theme says where and from what angle.
const SETTINGS = [
  'on a rooftop at sunset, low angle, three-quarter view',
  'in a rainy neon alley at night, full body, eye level',
  'on a white studio backdrop with soft even light',
  'on a beach at golden hour, slightly from above',
];
let phIdx = 0;
const animating = () => Boolean(state.image) && effectiveRole() === 'animate';
function themePlaceholder() {
  const staging = Boolean(currentModel()?.motionVideo);
  const list = staging ? SETTINGS : animating() ? MOTIONS : SURPRISES;
  const ex = list[phIdx % list.length];
  $('#theme').placeholder = staging ? `Where are they, and from what angle? e.g. ${ex}… (optional)` : animating() ? `What happens? e.g. ${ex}… (optional)` : `e.g. ${ex}…`;
}
themePlaceholder();
setInterval(() => {
  if ($('#theme').value) return;
  phIdx++;
  themePlaceholder();
}, 3500);

function renderModelChips() {
  const grid = $('#modelChips');
  $('#createForm').classList.toggle('no-models', !state.models.length);
  if (!state.models.length) {
    grid.innerHTML = '<div class="model-empty"><p>No target models yet. Add one (or import a <code>.json</code>) to get going.</p><button type="button" class="btn primary small" data-go="models">＋ Add a model</button></div>';
    $('[data-go]', grid).addEventListener('click', () => { showView('models/models'); newModel(); });
    return;
  }
  const key = JSON.stringify(state.models.map(m => [m.id, m.name, m.kind, m.color, m.description]));
  if (grid.dataset.key !== key) {
    grid.dataset.key = key;
    grid.innerHTML = state.models.map(m => `<button type="button" class="model-card" role="radio" data-id="${esc(m.id)}" style="--m:${modelColor(m)}" aria-label="${esc(`${m.name}, ${m.kind} model`)}" title="${esc(m.description)}">
      <span class="mc-ico" aria-hidden="true">${kindIcon(m.kind)}</span><span class="mc-name">${esc(m.name)}</span><span class="mc-kind" aria-hidden="true">${esc(m.kind)}</span>
    </button>`).join('');
  }
  // Update selection in place so keyboard focus stays on the card.
  $$('.model-card', grid).forEach(c => {
    const on = c.dataset.id === state.modelId;
    c.classList.toggle('active', on);
    c.setAttribute('aria-checked', on);
  });
}

// Per-model memory of the dials (aspect, resolution, duration, length, temperature).
const prefsKey = id => `prefs.${id}`;
function savePrefs() {
  const m = currentModel();
  if (!m) return;
  const own = !m.aspectRatios.includes($('#aspect').value); // the image's own ratio: belongs to the image, not the model
  const before = own ? saved.get(prefsKey(m.id), {}) : null;
  saved.set(prefsKey(m.id), {
    aspectRatio: own ? before.aspectRatio : $('#aspect').value,
    resolution: own ? before.resolution : $('#resolution').value,
    duration: $('#duration').value,
    length: state.length,
    temperature: Number($('#temperature').value),
  });
}

function selectModel(id, { values } = {}) {
  const m = modelById(id) || state.models[0] || null;
  state.modelId = m?.id || null;
  saved.set('modelId', state.modelId);
  renderModelChips();
  document.documentElement.style.setProperty('--m', m ? modelColor(m) : '#ff4d8d');
  $('#modelDesc').textContent = m?.description || '';
  $('#modelDesc').hidden = !m?.description;
  renderWorkflowPicker();
  renderChainEditor();
  if (!m) return;
  const v = { ...m.defaults, ...(values || saved.get(prefsKey(m.id), {})) };
  fillAspect(m, v.aspectRatio);
  fillSelect($('#resolution'), sizeChoices(m, $('#aspect').value), v.resolution);
  fillSelect($('#duration'), m.durations, v.duration);
  $('#aspectField').hidden = !m.aspectRatios.length;
  $('#resolutionField').hidden = !m.resolutions.length;
  $('#durationField').hidden = m.kind !== 'video' || !m.durations.length;
  state.length = ['short', 'medium', 'long'].includes(v.length) ? v.length : m.defaults.length;
  setActive($('#lengthSeg'), state.length);
  setTemperature(Number.isFinite(Number(v.temperature)) ? v.temperature : m.defaults.temperature);
  $$('#lengthSeg button').forEach(b => { b.title = m.lengthGuide?.[b.dataset.value] || ''; });
  $('#aspectNote').hidden = true;
  if (!values) matchImageAspect();
  renderRole();
}

function setTemperature(t) {
  const v = Number(t);
  $('#temperature').value = v;
  $('#tempOut').textContent = v.toFixed(2);
  $('#tempWord').textContent = v < 0.35 ? 'locked-in' : v < 0.75 ? 'balanced' : v < 1.15 ? 'creative' : v < 1.5 ? 'spicy' : 'unhinged';
}

const ROLE_HINTS = {
  reference: ['Blends the image\'s look (subject, setting, light, mood) with your theme.', 'No theme? The AI suggests a prompt inspired by the image.'],
  recreate: ['Rebuilds the image as a prompt, with your theme applied as changes.', 'Rebuilds this image as a prompt, as faithfully as possible.'],
  animate: ['Image-to-video: your image is frame one, and your theme says what happens.', 'Image-to-video: your image is frame one, and the AI picks fitting motion.'],
  character: ['Your character performs the motion video\'s moves; your theme sets the place and the camera.', 'Your character performs the motion video\'s moves, somewhere the AI picks to suit them.'],
};

function renderRole() {
  const m = currentModel();
  const hasImage = Boolean(state.image);
  const role = effectiveRole();
  const offered = rolesFor(m);
  $('#roleBlock').hidden = !hasImage || offered.length < 2; // one way to use it: nothing to pick
  $('#roleHint').hidden = !hasImage;
  for (const b of $$('#roleBlock .role')) b.hidden = !offered.includes(b.dataset.value);
  setActive($('#roleBlock'), role);
  // Character animation: step 3 takes the character and the motion video (also for a chain step that animates one).
  const motion = Boolean(m?.motionVideo);
  $('#motionBlock').hidden = !motion && !chainNeedsVideo();
  $('#charLabel').hidden = !motion;
  $('#imageStepTitle').textContent = motion ? 'Character & motion' : 'Add an image';
  $('#imageStepOpt').textContent = motion ? 'both needed to render' : 'optional';
  const hasTheme = Boolean($('#theme').value.trim());
  $('#roleHint').textContent = ROLE_HINTS[role][hasTheme ? 0 : 1];
  $('#themeOpt').textContent = hasImage || (motion && state.video) ? 'optional' : '';
  themePlaceholder();
  renderVisionWarning();
  renderWorkflowWarning();
  if (state.llmOk !== null) renderLlmSelect(); // suggestions follow the model and the image
}

function setVariations(n, { persist = true } = {}) {
  state.variations = n;
  setActive($('#varSeg'), n);
  updateGenerateLabel();
  if (persist) saved.set('variations', n);
}

$('#modelChips').addEventListener('click', e => {
  const card = e.target.closest('.model-card');
  if (card) selectModel(card.dataset.id);
});
$('#lengthSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.length = b.dataset.value;
  setActive($('#lengthSeg'), state.length);
  savePrefs();
});
$('#varSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setVariations(Number(b.dataset.value));
});
$('#roleBlock').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.imageRole = b.dataset.value;
  saved.set('imageRole', state.imageRole);
  renderRole();
});
$('#temperature').addEventListener('input', e => setTemperature(e.target.value));
$('#temperature').addEventListener('change', savePrefs);
$('#aspect').addEventListener('change', () => {
  $('#aspectNote').hidden = true;
  syncResolution();
  savePrefs();
});
for (const id of ['#resolution', '#duration']) $(id).addEventListener('change', savePrefs);
$('#theme').addEventListener('input', e => {
  renderRole();
  sizeTheme();
  syncNewBtn();
  saved.set('theme', $('#theme').value);
  if (themeUndo !== null) {
    // Typing after a replacement retires the undo chip (replaceTheme re-arms it right after its own edit).
    themeUndo = null;
    $('#themeUndo').hidden = true;
  }
});

// ---------- create: image ----------

// source: the render this image came from, when it's the next step of a chain (kept as a link, and its
// original file is what ComfyUI gets).
// An image as the LLM gets it: a JPEG data URL of at most 1536px, plus its shape (width / height).
async function readImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const max = 1536;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), ratio: bitmap.width / bitmap.height };
}

// A render as the next step's input image, stored like an upload (ComfyUI still gets the original).
async function imageFromRender(file) {
  const blob = await (await fetch(`/renders/${encodeURIComponent(file.file)}`)).blob();
  const { dataUrl, ratio } = await readImage(blob);
  const { file: name } = await api('/api/images', { method: 'POST', body: { image: dataUrl } });
  return { file: name, ratio };
}

async function loadImageFile(file, { source = null, quiet = false } = {}) {
  if (!file || !file.type.startsWith('image/')) return toast('🤔 That file isn\'t an image.', true);
  let dataUrl;
  let ratio;
  try {
    ({ dataUrl, ratio } = await readImage(file));
  } catch {
    return toast('Could not read that image.', true);
  }
  setImage({ dataUrl, ratio, source });
  const aspect = matchImageAspect();
  // Store it right away: survives reloads and never has to be re-sent.
  try {
    const { file: name } = await api('/api/images', { method: 'POST', body: { image: dataUrl } });
    if (state.image?.dataUrl === dataUrl) {
      state.image = { file: name, dataUrl, ratio, source };
      saved.set('image', name);
    }
    if (quiet) return;
    toast(aspect ? `🖼️ Image added · aspect set to ${aspect} to match` : '🖼️ Image added');
    announce(aspect ? `Image added. Aspect ratio set to ${aspect} to match it.` : 'Image added');
  } catch (err) {
    toast(`Image upload failed: ${err.message}`, true);
  }
}

function setImage(img) {
  state.image = img;
  const preview = $('#imagePreview');
  if (img) {
    preview.onload = () => {
      if (state.image !== img || img.ratio) return;
      img.ratio = preview.naturalWidth / preview.naturalHeight;
      if (ownAspect(currentModel(), img.ratio)) matchImageAspect(); // restored without its shape: a video needs it
    };
    preview.src = img.dataUrl || `/images/${img.file}`;
  } else {
    preview.removeAttribute('src');
    $('#aspectNote').hidden = true;
    const m = currentModel();
    if (m && !m.aspectRatios.includes($('#aspect').value)) { // the image's own ratio goes with it
      fillAspect(m, closestAspect(m, ratioOf($('#aspect').value)));
      syncResolution();
    }
  }
  $('.dz-empty').hidden = Boolean(img);
  $('.dz-preview').hidden = !img;
  $('#dropzone').setAttribute('aria-label', img ? 'Image added' : 'Add an image: drop, paste or browse');
  if (!img) saved.set('image', null);
  else if (img.file) saved.set('image', img.file);
  saved.set('imageSource', img?.source || null);
  renderSourceBadge();
  renderRole();
  renderMotionHint(); // says when the character and the video differ in shape
  syncNewBtn();
}

const takeLabel = src => `${src.modelName} · take ${src.index + 1}${src.seed != null ? ` · seed ${src.seed}` : ''}`;

// "🔗 From your Krea 2 RAW still" on the image, when it came from a render.
function renderSourceBadge() {
  const src = state.image?.source;
  const badge = $('#dzSource');
  badge.hidden = !src;
  if (src) badge.textContent = `🔗 From ${takeLabel(src)}`;
}

const dz = $('#dropzone');
dz.addEventListener('click', e => { if (!state.image && !e.target.closest('button')) $('#imageInput').click(); });
dz.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === dz && !state.image) { e.preventDefault(); $('#imageInput').click(); }
});
$('#imageInput').addEventListener('change', e => { loadImageFile(e.target.files[0]); e.target.value = ''; });
$('#imageReplace').addEventListener('click', () => $('#imageInput').click());
$('#imageClear').addEventListener('click', () => { setImage(null); dz.focus(); });

// Drop an image anywhere on the Create page; never let the browser navigate to a dropped file.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => {
  if (!hasFiles(e) || !isView('create')) return;
  dragDepth++;
  $('#dropOverlay').hidden = false;
});
document.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropOverlay').hidden = true;
});
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  if (!isView('create')) return toast('Go to Create to use an image.', true);
  const files = [...e.dataTransfer.files];
  const file = files.find(f => f.type.startsWith('image/'));
  const video = files.find(isVideoFile);
  if (video) loadVideoFile(video); // a motion video (character animation)
  if (file) loadImageFile(file); else if (!video) toast('🤔 That file isn\'t an image.', true);
});
document.addEventListener('paste', e => {
  if (!isView('create')) return;
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); loadImageFile(file); }
});

// ---------- create: step 3, the motion video (character animation) ----------
// For models like Wan Animate 2: the character in the image performs the moves of this video. ComfyUI gets the file
// as it is; the Brain sees a contact sheet of its frames, so it can name the motion.

const SHEET_FRAMES = 6;
const VIDEO_EXT_MIME = { mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska' };
const isVideoFile = f => Boolean(f) && (f.type.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv)$/i.test(f.name || ''));
const secsLabel = s => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s * 10) / 10}s`);

// A video element with the file loaded, ready to seek. Rejects when the browser can't decode it.
function openVideo(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('This browser can\'t play that video, so it can\'t be used. Convert it to MP4 (H.264) or WebM first.'));
    v.src = src;
  });
}

// Seeks and waits for the frame (or gives up after a few seconds, keeping whatever frame is there).
const seekTo = (v, t) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); v.removeEventListener('seeked', done); resolve(); };
  const timer = setTimeout(done, 4000);
  v.addEventListener('seeked', done);
  v.currentTime = t;
});

// A video recorded in a browser can lack its duration until it's been read to the end.
async function videoDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  await seekTo(v, 1e7);
  const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime;
  await seekTo(v, 0);
  return d || 0;
}

// Frames taken evenly through the video, in reading order, each numbered with its time: one JPEG for the Brain.
async function contactSheet(v, seconds) {
  const ar = v.videoWidth / v.videoHeight || 1;
  const cols = ar >= 1 ? 2 : 3;
  const rows = Math.ceil(SHEET_FRAMES / cols);
  const max = 1536;
  let tw = Math.floor(max / cols);
  let th = Math.round(tw / ar);
  if (th * rows > max) { th = Math.floor(max / rows); tw = Math.round(th * ar); }
  const canvas = document.createElement('canvas');
  canvas.width = tw * cols;
  canvas.height = th * rows;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const size = Math.max(14, Math.round(Math.min(tw, th) * 0.07));
  ctx.font = `700 ${size}px sans-serif`;
  ctx.textBaseline = 'top';
  for (let i = 0; i < SHEET_FRAMES; i++) {
    const t = seconds ? Math.min(Math.max(0, seconds - 0.05), ((i + 0.5) * seconds) / SHEET_FRAMES) : 0;
    await seekTo(v, t);
    const x = (i % cols) * tw;
    const y = Math.floor(i / cols) * th;
    ctx.drawImage(v, x, y, tw, th);
    const label = `${i + 1} · ${t.toFixed(1)}s`;
    ctx.fillStyle = 'rgb(0 0 0 / 70%)';
    ctx.fillRect(x + 6, y + 6, ctx.measureText(label).width + size * 0.8, size * 1.5);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 6 + size * 0.4, y + 6 + size * 0.25);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(x, y, tw, th);
  }
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function uploadVideo(file, type) {
  let res;
  try {
    res = await fetch('/api/videos', { method: 'POST', headers: { 'Content-Type': type }, body: file });
  } catch (err) {
    throw new Error(friendly(err));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data.file;
}

// Reads a video, stores it and its contact sheet, and makes it the motion video. A video the browser can't decode
// (H.265 from a phone, mostly) is stored as it is for ComfyUI; the page then reads a preview the server makes with
// ffmpeg, if this computer has it.
// A Then step animates a character, so step 3's motion video is for it.
const chainNeedsVideo = () => state.chain.steps.some(st => modelById(st.modelId)?.motionVideo);

let videoToken = null;
async function loadVideoFile(file, { quiet = false } = {}) {
  if (!currentModel()?.motionVideo && !chainNeedsVideo()) {
    const m = state.models.find(x => x.motionVideo);
    if (!m) return toast('🤔 None of your models takes a motion video.', true);
    selectModel(m.id);
    toast(`Switched to ${m.name}, which takes a motion video.`);
  }
  if (!isVideoFile(file)) return toast('🤔 That file isn\'t a video. Use MP4, WebM or MOV.', true);
  const type = (file.type && file.type !== 'application/octet-stream' ? file.type : VIDEO_EXT_MIME[(file.name.split('.').pop() || '').toLowerCase()]) || 'video/mp4';
  const token = {};
  videoToken = token;
  const url = URL.createObjectURL(file);
  const own = await openVideo(url).catch(() => null);
  const playable = Boolean(own?.videoWidth);
  if (!playable) URL.revokeObjectURL(url);
  setVideo({ url: playable ? url : null });
  try {
    const name = await uploadVideo(file, type);
    if (videoToken !== token) return;
    const prep = await api(`/api/videos/${encodeURIComponent(name)}/prepare`, { method: 'POST', body: { preview: !playable } });
    const view = playable ? own : prep.preview ? await openVideo(`/videos/${encodeURIComponent(prep.preview)}`).catch(() => null) : null;
    const seconds = view ? await videoDuration(view) : prep.info?.seconds || 0;
    const width = view?.videoWidth || prep.info?.width || null;
    const height = view?.videoHeight || prep.info?.height || null;
    const sheetUrl = view ? await contactSheet(view, seconds) : null;
    const sheet = sheetUrl ? (await api('/api/images', { method: 'POST', body: { image: sheetUrl } })).file : null;
    if (videoToken !== token) return; // replaced meanwhile
    setVideo({
      file: name, preview: prep.preview || null, sheet, seconds: Math.round(seconds * 100) / 100, frames: sheet ? SHEET_FRAMES : 0,
      width, height, ratio: width && height ? width / height : null, fps: prep.info?.fps || null, ffmpeg: prep.ffmpeg, url: playable ? url : null,
      bars: prep.info?.bars || null,
    });
    const aspect = shapeIcon() === '🕺' ? matchImageAspect() : null; // with a character, the clip takes its shape
    if (quiet) return;
    toast(`🕺 Motion video added${seconds ? ` · ${secsLabel(seconds)}` : ''}${aspect ? ` · aspect set to ${aspect} to match` : ''}${sheet ? '' : ' · no preview in this browser'}`, !sheet);
    announce(`Motion video added${seconds ? `, ${secsLabel(seconds)} long` : ''}.${aspect ? ` Aspect ratio set to ${aspect} to match it.` : ''}`);
  } catch (err) {
    if (videoToken === token) setVideo(null);
    toast(`Motion video failed: ${err.message}`, true);
  }
}

// Swaps the motion video for a copy made by ffmpeg: at 24 fps (so a fast phone video doesn't take 5× as long),
// without its black bars (crop), or a part of it (trim: { start, seconds }).
async function videoCopy(btn, kind, part = null, { quiet = false } = {}) {
  const v = state.video;
  if (!v?.file) return;
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = { crop: '⏳ Cropping…', trim: '⏳ Cutting…', retime: '⏳ Making a 24 fps copy…' }[kind];
  }
  try {
    const r = await api(`/api/videos/${encodeURIComponent(v.file)}/${kind}`, { method: 'POST', body: kind === 'retime' ? { fps: 24 } : part || {} });
    const blob = await (await fetch(`/videos/${encodeURIComponent(r.file)}`)).blob();
    closeTrim();
    await loadVideoFile(new File([blob], `${r.file}`, { type: 'video/mp4' }), { quiet: true });
    if (quiet) return r;
    toast(kind === 'crop' ? `✂️ Now using your motion video without its black bars · aspect ${$('#aspect').value}`
      : kind === 'trim' ? `✂️ Now using ${secsLabel(r.info?.seconds || part.seconds)} of your motion video, from ${secsLabel(part.start)}`
        : '🕺 Now using a 24 fps copy of your motion video');
    return r;
  } catch (err) {
    if (quiet) throw err;
    toast(`Couldn't make the copy: ${err.message}`, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

// ✂️ Trim: pick the stretch of a long motion video to animate, to the frame. A timeline of the video's frames with a
// playhead to drag, one-frame steps (← →, Shift for a second), start and end set at the frame you see (I, O), and
// ▶ to play just that part. It starts out as long as the picked workflow animates (81 frames for some), else all of it.
// Frames count at the video's frame rate: start = first frame kept, end = the frame after the last one.
const trimFps = () => state.video?.fps || 24;
const trimTotal = () => Math.max(1, Math.round((state.video?.seconds || 0) * trimFps()));
const clockLabel = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const frameAt = t => Math.min(trimTotal() - 1, Math.max(0, Math.floor(t * trimFps() + 1e-4)));
let trimRaf = 0;

function openTrim() {
  const v = state.video;
  if (!v?.file) return;
  const total = trimTotal();
  const flow = activeFlow();
  const clip = typeof flow?.motionFrames === 'number' ? flow.motionFrames : total;
  state.trim = { a: 0, b: Math.min(total, clip) };
  const scrub = $('#trimScrub');
  scrub.max = String(total - 1);
  scrub.value = '0';
  $('#trimBox').hidden = false;
  $('.mz-preview').classList.add('trimming');
  const pv = $('#motionPreview');
  pv.pause();
  showTrimFrame(0);
  syncTrim();
  trimThumbs();
  renderMotionHint();
  scrub.focus();
}

function closeTrim() {
  $('#trimBox').hidden = true;
  $('.mz-preview')?.classList.remove('trimming');
  state.trim = null;
  cancelAnimationFrame(trimRaf);
  const pv = $('#motionPreview');
  if (pv.getAttribute('src')) pv.play().catch(() => {});
}

// Shows a frame in the preview (seeking to the middle of it, so the browser lands on that one).
function showTrimFrame(frame) {
  const pv = $('#motionPreview');
  const f = Math.min(trimTotal() - 1, Math.max(0, frame));
  pv.pause();
  pv.currentTime = (f + 0.5) / trimFps();
  $('#trimScrub').value = String(f);
  trimClock(f);
}

function trimClock(f = frameAt($('#motionPreview').currentTime)) {
  $('#trimNow').textContent = `${clockLabel(f / trimFps())} · frame ${f + 1} of ${trimTotal()}`;
}

// The part picked: the lit-up stretch on the timeline, the Start and End boxes, and what it adds up to.
function syncTrim({ fields = true } = {}) {
  const t = state.trim;
  if (!t) return;
  const total = trimTotal();
  const fps = trimFps();
  t.a = Math.min(total - 1, Math.max(0, t.a));
  t.b = Math.min(total, Math.max(t.a + 1, t.b));
  $('.trim-sel').style.setProperty('--a', `${(t.a / total) * 100}%`);
  $('.trim-sel').style.setProperty('--w', `${((t.b - t.a) / total) * 100}%`);
  if (fields) {
    $('#trimStart').value = (t.a / fps).toFixed(2);
    $('#trimEnd').value = (t.b / fps).toFixed(2);
  }
  const flow = activeFlow();
  const n = t.b - t.a;
  $('#trimNote').textContent = `Frames ${t.a + 1}–${t.b} · ${n} frames · ${secsLabel(n / fps)} (${clockLabel(t.a / fps)} → ${clockLabel(t.b / fps)})${typeof flow?.motionFrames === 'number' && n > flow.motionFrames + 1 ? ` · “${flow.name}” animates the first ${flow.motionFrames} of them` : ''}`;
  $('#trimGo').disabled = n >= total && t.a === 0; // the whole video: nothing to cut
}

// Small frames along the timeline, taken in this page from a second copy of the video (never saved).
async function trimThumbs() {
  const box = $('.trim-thumbs');
  const src = $('#motionPreview').currentSrc || $('#motionPreview').getAttribute('src');
  if (!src || box.dataset.src === src) return;
  box.dataset.src = src;
  box.replaceChildren();
  const v = await openVideo(src).catch(() => null);
  if (!v || box.dataset.src !== src) return;
  const n = 12;
  const h = 56;
  const w = Math.max(1, Math.round((h * (v.videoWidth || 16)) / (v.videoHeight || 9)));
  for (let i = 0; i < n && box.dataset.src === src; i++) {
    await seekTo(v, ((i + 0.5) * (state.video?.seconds || v.duration || 1)) / n);
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    box.append(c);
  }
  v.removeAttribute('src');
  v.load();
}

function playTrim() {
  const t = state.trim;
  const pv = $('#motionPreview');
  if (!t) return;
  if (!pv.paused) { pv.pause(); return; }
  const f = frameAt(pv.currentTime);
  if (f < t.a || f >= t.b - 1) pv.currentTime = (t.a + 0.5) / trimFps();
  pv.play().catch(() => {});
  const follow = () => {
    if (!state.trim || pv.paused) { $('#trimPlay').textContent = '▶ Play part'; return; }
    const now = frameAt(pv.currentTime);
    if (now >= state.trim.b || now < state.trim.a) pv.currentTime = (state.trim.a + 0.5) / trimFps(); // loop the part
    $('#trimScrub').value = String(now);
    trimClock(now);
    trimRaf = requestAnimationFrame(follow);
  };
  $('#trimPlay').textContent = '⏸ Pause';
  cancelAnimationFrame(trimRaf);
  trimRaf = requestAnimationFrame(follow);
}

const trimStep = n => showTrimFrame(frameAt($('#motionPreview').currentTime) + n);
const trimMark = end => {
  const f = Number($('#trimScrub').value) || 0;
  if (end) { state.trim.b = f + 1; if (state.trim.a > f) state.trim.a = f; }
  else { state.trim.a = f; if (state.trim.b <= f) state.trim.b = Math.min(trimTotal(), f + 1); }
  syncTrim();
};
$('#trimScrub').addEventListener('input', e => showTrimFrame(Number(e.target.value)));
$('#trimBack').addEventListener('click', () => trimStep(-1));
$('#trimFwd').addEventListener('click', () => trimStep(1));
$('#trimPlay').addEventListener('click', playTrim);
$('#trimSetStart').addEventListener('click', () => trimMark(false));
$('#trimSetEnd').addEventListener('click', () => trimMark(true));
for (const [sel, key] of [['#trimStart', 'a'], ['#trimEnd', 'b']]) {
  $(sel).addEventListener('input', e => {
    if (!state.trim || e.target.value === '') return;
    state.trim[key] = Math.round(Math.max(0, Number(e.target.value) || 0) * trimFps());
    syncTrim({ fields: false });
    showTrimFrame(key === 'a' ? state.trim.a : state.trim.b - 1);
  });
  $(sel).addEventListener('change', () => syncTrim());
}
$('#trimGo').addEventListener('click', e => {
  const t = state.trim;
  videoCopy(e.currentTarget, 'trim', { start: t.a / trimFps(), seconds: (t.b - t.a) / trimFps() });
});
$('#trimCancel').addEventListener('click', () => { closeTrim(); renderMotionHint(); });
$('#trimBox').addEventListener('keydown', e => {
  const typing = e.target.matches('input[type="number"]');
  if (e.key === 'Enter') { e.preventDefault(); if (typing) syncTrim(); else $('#trimGo').click(); return; } // in the Create form: Enter must not generate
  if (e.key === 'Escape') { e.preventDefault(); closeTrim(); renderMotionHint(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); trimStep((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? Math.round(trimFps()) : 1)); }
  else if (e.key === ' ' && !e.target.matches('button')) { e.preventDefault(); playTrim(); }
  else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); trimMark(false); }
  else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); trimMark(true); }
});

function setVideo(v) {
  const old = state.video;
  if (old?.url?.startsWith('blob:') && old.url !== v?.url) URL.revokeObjectURL(old.url);
  state.video = v;
  const pv = $('#motionPreview');
  const src = !v ? null : v.url || (v.preview ? `/videos/${encodeURIComponent(v.preview)}` : v.file && v.sheet ? `/videos/${encodeURIComponent(v.file)}` : null);
  if (src) {
    if (pv.getAttribute('src') !== src) pv.src = src;
    pv.play().catch(() => {});
  } else {
    pv.removeAttribute('src');
    pv.load();
  }
  $('.mz-empty').hidden = Boolean(v);
  $('.mz-preview').hidden = !v;
  $('#motionZone').setAttribute('aria-label', v ? 'Motion video added' : 'Add a motion video: drop or browse');
  $('#mzInfo').textContent = !v ? '' : v.file
    ? `🕺 ${[v.seconds ? secsLabel(v.seconds) : '', v.width && v.height ? `${v.width}×${v.height}` : '', v.fps ? `${Math.round(v.fps)} fps` : ''].filter(Boolean).join(' · ') || 'Motion video'}`
    : '⏳ Reading the video…';
  renderMotionHint();
  saved.set('video', v?.file ? { file: v.file, preview: v.preview, sheet: v.sheet, seconds: v.seconds, frames: v.frames, width: v.width, height: v.height, ratio: v.ratio, fps: v.fps, ffmpeg: v.ffmpeg, bars: v.bars || null } : null);
  if (!v && old) {
    const m = currentModel();
    if (m?.motionVideo && !m.aspectRatios.includes($('#aspect').value)) { // the video's own ratio goes with it
      fillAspect(m, closestAspect(m, ratioOf($('#aspect').value)));
      syncResolution();
    }
  }
  renderRole();
  syncNewBtn();
  if (state.chain.steps.length) renderChainEditor(); // a character step needs it
}

// Under the motion video: how it's used, or what to know about this one (no preview here, a high frame rate).
function renderMotionHint() {
  const v = state.video;
  const hint = $('#motionHint');
  const parts = [];
  if (v?.file && !v.sheet) {
    parts.push(`🙈 This browser can't show this video (H.265 from a phone, probably), so the Brain can't see the moves: describe them in the theme. ComfyUI still uses it as it is.${v.ffmpeg === false ? ' With ffmpeg installed, Prompt Maker makes a preview.' : ''}`);
  }
  const img = state.image?.ratio;
  if (v?.ratio && img && ratioDist(v.ratio, img) > 0.2 && currentModel()?.motionVideo) {
    parts.push(`📐 Your character is ${img < v.ratio ? 'taller' : 'wider'} than the video. Wan Animate 2 makes the clip in your character's shape, so the video's ${img < v.ratio ? 'sides are' : 'top and bottom are'} cropped at the center: keep the moves near the middle, or use a character image in the video's shape.`);
  }
  if (v?.bars) {
    parts.push(`⬛ Black bars: the picture is ${v.bars.width}×${v.bars.height} inside a ${v.width}×${v.height} frame. Wan Animate 2 would take the bars as part of the video, and its shape too.`);
  }
  if (v?.fps > 32) {
    parts.push(`⚠️ ${Math.round(v.fps)} fps: Wan Animate 2 uses every frame, so this takes about ${Math.round(v.fps / 24)}× as long as at 24 fps.`);
  }
  hint.innerHTML = parts.length ? parts.map(esc).join(' ') : 'The clip is as long as this video. Its frames are used one for one, so a 16–24 fps video moves naturally.';
  if (v?.bars && v.ffmpeg) {
    hint.insertAdjacentHTML('beforeend', ' <button type="button" class="chip-btn" id="videoCrop">✂️ Crop the bars</button>');
    $('#videoCrop').addEventListener('click', e => videoCopy(e.currentTarget, 'crop'));
  }
  if (v?.fps > 32 && v.ffmpeg) {
    hint.insertAdjacentHTML('beforeend', ' <button type="button" class="chip-btn" id="videoRetime">Use a 24 fps copy</button>');
    $('#videoRetime').addEventListener('click', e => videoCopy(e.currentTarget, 'retime'));
  }
  if (v?.file && v.ffmpeg && v.seconds > 1 && $('#trimBox').hidden) {
    hint.insertAdjacentHTML('beforeend', ' <button type="button" class="chip-btn" id="videoTrim" title="Use only part of this video">✂️ Trim</button>');
    $('#videoTrim').addEventListener('click', openTrim);
  }
  if (!v?.file && !$('#trimBox').hidden) closeTrim();
}

// The motion video as the server stores it with a take (null while it's still uploading).
const videoForRequest = () => {
  const v = state.video;
  return v?.file ? { file: v.file, preview: v.preview || undefined, sheet: v.sheet, seconds: v.seconds, frames: v.frames, width: v.width, height: v.height, fps: v.fps || undefined } : null;
};

// A take's motion video put back on Create (from History).
function restoreVideo(v) {
  setVideo(v?.file ? { ...v, ratio: v.width && v.height ? v.width / v.height : null } : null);
}

const mz = $('#motionZone');
mz.addEventListener('click', e => { if (!state.video && !e.target.closest('button')) $('#videoInput').click(); });
mz.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === mz && !state.video) { e.preventDefault(); $('#videoInput').click(); }
});
$('#videoInput').addEventListener('change', e => { loadVideoFile(e.target.files[0]); e.target.value = ''; });
$('#videoReplace').addEventListener('click', () => $('#videoInput').click());
$('#videoClear').addEventListener('click', () => { setVideo(null); mz.focus(); });
$('#motionPreview').addEventListener('error', () => {
  if (state.video?.file && !state.video.url) { setVideo(null); toast('The motion video is gone from the data folder. Add it again.', true); }
});

// ---------- create: step 3, an image from the Gallery ----------
// Any image you've rendered can be the input image: it's linked back to its render, and ComfyUI gets the original.

// kind 'video' picks a motion video instead (any video you rendered).
const picker = { model: '', items: [], kind: 'image' };

async function openImagePicker(kind = 'image') {
  const all = await api('/api/history').catch(() => null);
  if (all) state.history = all;
  picker.kind = kind === 'video' ? 'video' : 'image';
  picker.items = galleryItems().filter(it => it.file.kind === picker.kind);
  $('#imgPickTitle').textContent = picker.kind === 'video' ? 'Pick a motion video from your Gallery' : 'Pick an image from your Gallery';
  renderImagePicker();
  $('#imgPick').showModal();
  ($('#imgPickGrid .ip-tile') || $('#imgPickClose')).focus();
}

function renderImagePicker() {
  const items = picker.items;
  const models = [...new Map(items.map(it => [it.entry.modelId, it.entry.modelName])).entries()];
  if (picker.model && !models.some(([id]) => id === picker.model)) picker.model = '';
  $('#imgPickModels').innerHTML = models.length > 1
    ? [['', 'All models'], ...models].map(([id, name]) => `<button type="button" class="chip-btn" data-id="${esc(id)}" aria-pressed="${picker.model === id}">${esc(name)}</button>`).join('')
    : '';
  const shown = items.filter(it => !picker.model || it.entry.modelId === picker.model);
  $('#imgPickGrid').innerHTML = shown.length
    ? shown.map(it => `<div class="ip-cell"><button type="button" class="ip-tile" data-n="${items.indexOf(it)}" style="--m:${modelColor(modelById(it.entry.modelId) || { id: it.entry.modelId })}" aria-label="Use ${esc(it.entry.theme || `this ${picker.kind}`)} (${esc(it.entry.modelName)}${it.render.seed != null ? `, seed ${it.render.seed}` : ''})">${picker.kind === 'video' ? `<video src="/renders/${encodeURIComponent(it.file.file)}#t=0.1" muted preload="metadata" playsinline></video>` : `<img src="/renders/${encodeURIComponent(it.file.file)}" alt="" loading="lazy">`}<span class="ip-cap">${esc(it.entry.theme || 'From an image')}</span></button>${picker.kind === 'video' ? '' : `<button type="button" class="ip-zoom" data-n="${items.indexOf(it)}" title="Look closer" aria-label="Look closer at ${esc(it.entry.theme || 'this image')}">🔍</button>`}</div>`).join('')
    : `<p class="muted">${items.length ? `No ${picker.kind}s from this model yet.` : `No ${picker.kind} renders yet. Render a take with ComfyUI and it shows up here.`}</p>`;
}

async function useRenderAsImage(it) {
  try {
    const blob = await (await fetch(`/renders/${encodeURIComponent(it.file.file)}`)).blob();
    const source = { entryId: it.entry.id, index: it.index, renderId: it.render.id, file: it.file.file, modelName: it.entry.modelName, seed: it.render.seed ?? null };
    await loadImageFile(new File([blob], it.file.name || it.file.file, { type: blob.type || 'image/png' }), { source });
  } catch (err) {
    toast(`Couldn't use that image: ${err.message}`, true);
  }
}

for (const id of ['#dzGallery', '#imageGallery']) $(id).addEventListener('click', () => openImagePicker('image'));
for (const id of ['#mzGallery', '#videoGallery']) $(id).addEventListener('click', () => openImagePicker('video'));

// A rendered video as the motion video (stored as its own copy, so deleting the render doesn't take it away).
async function useRenderAsVideo(it) {
  try {
    const blob = await (await fetch(`/renders/${encodeURIComponent(it.file.file)}`)).blob();
    await loadVideoFile(new File([blob], it.file.name || it.file.file, { type: blob.type || 'video/mp4' }));
  } catch (err) {
    toast(`Couldn't use that video: ${err.message}`, true);
  }
}
$('#imgPickClose').addEventListener('click', () => $('#imgPick').close());
$('#imgPickModels').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  picker.model = b.dataset.id;
  renderImagePicker();
});
$('#imgPickGrid').addEventListener('click', e => {
  const z = e.target.closest('.ip-zoom');
  if (z) {
    const it = picker.items[Number(z.dataset.n)];
    return openImageView(`/renders/${encodeURIComponent(it.file.file)}`, () => { $('#imgPick').close(); useRenderAsImage(it); });
  }
  const b = e.target.closest('.ip-tile');
  if (!b) return;
  $('#imgPick').close();
  const it = picker.items[Number(b.dataset.n)];
  if (picker.kind === 'video') useRenderAsVideo(it); else useRenderAsImage(it);
});

// Thumbnail size in the picker: drag the 🔍 slider; it's remembered.
const setPickSize = px => $('#imgPick').style.setProperty('--ip-size', `${px}px`);
try { const v = Number(localStorage.getItem('imgPickSize')); if (v) { $('#imgPickSize').value = v; setPickSize(v); } } catch {}
$('#imgPickSize').addEventListener('input', e => {
  setPickSize(e.target.value);
  try { localStorage.setItem('imgPickSize', e.target.value); } catch {}
});

// A plain full-screen viewer for one image (step 3's image, a picker tile). Click the image for actual size.
let ivUse = null;
function openImageView(src, onUse = null) {
  ivUse = onUse;
  $('#ivImg').src = src;
  $('#ivStage').classList.remove('actual');
  $('#ivUse').hidden = !onUse;
  $('#imgView').showModal();
  $('#ivClose').focus();
}
$('#ivStage').addEventListener('click', e => {
  if (e.target.id !== 'ivImg') return $('#imgView').close();
  const st = $('#ivStage'), img = e.target;
  const r = img.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  st.classList.toggle('actual');
  if (st.classList.contains('actual')) { // keep the spot you clicked under the pointer
    st.scrollLeft = fx * img.offsetWidth - st.clientWidth / 2;
    st.scrollTop = fy * img.offsetHeight - st.clientHeight / 2;
  }
});
$('#ivClose').addEventListener('click', () => $('#imgView').close());
$('#ivUse').addEventListener('click', () => { $('#imgView').close(); ivUse?.(); });
$('#imageZoom').addEventListener('click', () => { if ($('#imagePreview').src) openImageView($('#imagePreview').src); });

// ---------- create: takes (results) ----------

const REFINE_CHIPS = {
  common: [['✂️', 'Shorter'], ['🔍', 'More detailed'], ['🎞️', 'More cinematic'], ['📸', 'More natural & candid'], ['💡', 'Different lighting'], ['📐', 'Different camera angle']],
  video: [['⚡', 'More dynamic motion'], ['🐢', 'Calmer, slower motion'], ['🚁', 'Add camera movement']],
  // Character animation: the motion video sets the moves, so the changes are about the place and the look.
  character: [['🏙️', 'A different setting'], ['👗', 'A different outfit'], ['🎨', 'A different style']],
};

function errorTitle(msg) {
  if (/reach ComfyUI/i.test(msg)) return ['🔌', 'Can\'t reach ComfyUI'];
  if (/ComfyUI failed|ComfyUI reported|ComfyUI finished/i.test(msg)) return ['🎨', 'ComfyUI hit a problem'];
  if (/needs an input image/i.test(msg)) return ['🖼️', 'This workflow needs an image'];
  if (/reach LM Studio|not reachable/i.test(msg)) return ['🔌', 'Can\'t reach LM Studio'];
  if (/stopped responding/i.test(msg)) return ['🔌', 'LM Studio dropped out mid-answer'];
  if (/Prompt Maker server/i.test(msg)) return ['🔌', 'Lost the app server'];
  if (/can't see images|text-only/i.test(msg)) return ['🙈', 'This brain can\'t see images'];
  if (/token limit|thinking/i.test(msg)) return ['🧠', 'The brain ran out of room'];
  if (/No LLM selected/i.test(msg)) return ['🧠', 'No brain selected'];
  return ['⚠️', 'That didn\'t work'];
}

function showError(msg) {
  const card = $('#stageError');
  if (!msg) { card.hidden = true; card.innerHTML = ''; return; }
  const [ico, title] = errorTitle(msg);
  const canStart = /reach LM Studio|stopped responding/i.test(msg);
  card.innerHTML = `<span class="e-ico" aria-hidden="true">${ico}</span><div><b>${esc(title)}</b><p>${esc(msg)}</p>${canStart ? '<button type="button" class="btn small primary e-start">▶ Start LM Studio server</button>' : ''}</div><button type="button" class="icon-btn x" aria-label="Dismiss error">✕</button>`;
  card.hidden = false;
  $('.x', card).addEventListener('click', () => showError(''));
  $('.e-start', card)?.addEventListener('click', e => startLmStudio(e.currentTarget));
  announce(`${title}. ${msg}`);
  if (!isView('create')) { toast(`${ico} ${title}`, true); return; }
  const r = card.getBoundingClientRect();
  if (r.top < 160 || r.bottom > innerHeight) card.scrollIntoView({ block: 'start', behavior: scrollMode() });
}

function renderStageHead(entry, { running = false, totalSecs } = {}) {
  const head = $('#stageHead');
  if (!entry) { head.hidden = true; return; }
  const m = modelById(entry.modelId);
  const tags = [entry.aspectRatio, entry.resolution, entry.duration, `${entry.length} length`, `🌡 ${Number(entry.temperature).toFixed(2)}`]
    .filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const via = entry.llmName || state.llms.find(l => l.id === entry.llmModel)?.name || entry.llmModel;
  const takes = entry.variations?.length || 0;
  head.style.setProperty('--m', m ? modelColor(m) : 'var(--hot)');
  head.innerHTML = `<span class="tag model">${kindIcon(entry.modelKind)} ${esc(entry.modelName)}</span>${entry.batch ? `<span class="tag batch" title="From the batch “${esc(entry.batch)}”">🎞 ${esc(entry.batch)}</span>` : ''}${entry.source ? `<button type="button" class="tag src-link" id="srcLink" title="Open the take this came from">⬑ from ${esc(takeLabel(entry.source))}</button>` : ''}${tags}
    ${via ? `<span class="via">${running ? 'rolling on' : 'written by'} ${esc(via)}${totalSecs ? ` in ${totalSecs.toFixed(1)}s` : ''}</span>` : ''}
    ${!running && takes > 1 && entry.id && workflowsFor(entry.modelId).length ? `<button type="button" class="btn small" id="renderAllBtn">🎨 Render all ${takes}</button>` : ''}
    ${!running && takes > 1 ? `<button type="button" class="btn small" id="copyAllBtn">📋 Copy all ${takes} takes</button>` : ''}`;
  head.hidden = false;
  $('#srcLink')?.addEventListener('click', () => openSource(entry.source));
  $('#renderAllBtn')?.addEventListener('click', () => state.cards.forEach(c => { if (c.rb && !c.interrupted) startRender(c); }));
  $('#copyAllBtn')?.addEventListener('click', e => copyText(takesText(state.cards.filter(c => !c.interrupted).map(c => $('.prompt-text', c.el).value.trim())), e.currentTarget));
}

// ---------- rendering now (top bar) ----------
// Every render still going, from any take (also ones that left the stage, another tab, or before a reload): its
// progress, Open to bring its take back with live tiles, and ✕ Cancel. The pill shows only while something renders.

let rendersNow = [];

async function pollRenders() {
  clearTimeout(pollRenders.timer);
  const open = !$('#rendersPanel').hidden;
  rendersNow = await api(`/api/renders${open ? '?previews' : ''}`).catch(() => rendersNow);
  drawRenders();
  pollRenders.timer = setTimeout(pollRenders, rendersNow.length ? (open ? 1000 : 2000) : 5000);
}

function rendersLeft() {
  return rendersNow.reduce((n, j) => n + Math.max(0, j.count - j.finished), 0);
}

function drawRenders() {
  const btn = $('#rendersBtn');
  btn.hidden = !rendersNow.length;
  if (!rendersNow.length) showRendersPanel(false);
  $('#rendersCount').textContent = rendersLeft();
  btn.setAttribute('aria-label', `${rendersLeft()} rendering: show them`);
  const list = $('#rendersList');
  // Rows are kept (and only their numbers updated), so a click never lands on a row being redrawn.
  const keep = new Set(rendersNow.map(j => j.runId));
  $$('.rp-row', list).forEach(li => { if (!keep.has(li.dataset.run)) li.remove(); });
  for (const j of rendersNow) {
    let li = $(`.rp-row[data-run="${CSS.escape(j.runId)}"]`, list);
    if (!li) {
      li = document.createElement('li');
      li.className = 'rp-row';
      li.dataset.run = j.runId;
      li.style.setProperty('--m', modelColor(modelById(j.modelId) || { id: j.modelId }));
      li.innerHTML = `<div class="rp-thumb" style="--ar:${ASPECT_CSS(j.aspectRatio)}"><span aria-hidden="true">🎨</span></div>
        <div class="rp-main"><b class="rp-theme"></b><span class="rp-what"></span><span class="rp-stage"></span><div class="rp-bar"><i></i></div></div>
        <div class="rp-acts"><button type="button" class="btn small" data-rp="open">Open</button><button type="button" class="btn small danger" data-rp="cancel">✕ Cancel</button></div>`;
      list.append(li);
    }
    $('.rp-theme', li).textContent = j.theme || 'From an image';
    $('.rp-what', li).textContent = `${j.modelName} · ${j.workflowName}`;
    $('.rp-stage', li).textContent = [j.count > 1 ? `Render ${Math.min(j.count, j.finished + 1)} of ${j.count}` : '', j.pct != null ? `${j.pct}%` : '', j.stage].filter(Boolean).join(' · ');
    $('.rp-bar i', li).style.width = `${j.pct ?? 0}%`;
    if (j.preview) {
      const thumb = $('.rp-thumb', li);
      let img = $('img', thumb);
      if (!img) { thumb.textContent = ''; img = Object.assign(document.createElement('img'), { alt: '' }); thumb.append(img); }
      if (img.getAttribute('src') !== j.preview) img.src = j.preview;
    }
    if (li.classList.contains('cancelling')) $('.rp-stage', li).textContent = 'Cancelling…';
  }
}

function showRendersPanel(show) {
  const panel = $('#rendersPanel');
  if (panel.hidden === !show) return;
  panel.hidden = !show;
  $('#rendersBtn').setAttribute('aria-expanded', String(show));
  if (show) pollRenders(); // with previews
}

$('#rendersBtn').addEventListener('click', () => showRendersPanel($('#rendersPanel').hidden));
document.addEventListener('click', e => { if (!e.target.closest('.rp-wrap')) showRendersPanel(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#rendersPanel').hidden) { e.stopPropagation(); showRendersPanel(false); $('#rendersBtn').focus(); }
}, true);
$('#rendersList').addEventListener('click', async e => {
  const b = e.target.closest('[data-rp]');
  if (!b) return;
  const li = b.closest('.rp-row');
  const job = rendersNow.find(j => j.runId === li.dataset.run);
  if (!job) return;
  if (b.dataset.rp === 'cancel') {
    li.classList.add('cancelling');
    b.disabled = true;
    $('.rp-stage', li).textContent = 'Cancelling…';
    await api(`/api/runs/${job.runId}/cancel`, { method: 'POST' }).catch(err => toast(err.message, true));
    return pollRenders();
  }
  showRendersPanel(false);
  if (state.entry?.id === job.historyId) return showView('create');
  if (state.busy || state.chainActive) return toast('Hold on, something is still cooking. Stop it or wait.', true);
  const entry = await api(`/api/history/${job.historyId}`).catch(() => null);
  if (!entry) return toast('That take is no longer in History.', true);
  await openEntry(entry);
});
$('#rendersCancelAll').addEventListener('click', e => confirmClick(e.currentTarget, 'Sure?', async () => {
  await Promise.all(rendersNow.map(j => api(`/api/runs/${j.runId}/cancel`, { method: 'POST' }).catch(() => {})));
  toast('■ Cancelling every render');
  pollRenders();
}));

// ---------- create: previous runs ----------

// A new Generate replaces the stage, so the run it replaces (with its renders) stays above it to compare.
function keepPrevious(entry) {
  if (!entry?.id) return;
  setPrev([entry, ...state.prev.filter(e => e.id !== entry.id)].slice(0, 3));
}

// Earlier runs are remembered (by entry) so a page reload keeps them; their renders come from History.
function setPrev(list) {
  state.prev = list;
  saved.set('prev', list.map(e => e.id));
  renderPrevStrip();
}

function restorePrev(history) {
  if (state.prev.length) return;
  state.prev = saved.get('prev', []).map(id => history.find(e => e.id === id)).filter(Boolean);
  renderPrevStrip();
}

// Render tiles still running, per entry, so a run that left the stage keeps showing its progress.
const liveTiles = new WeakMap();

function renderPrevStrip() {
  const box = $('#prevStrip');
  const shown = state.prev.filter(e => e.id !== state.entry?.id && (liveTiles.get(e)?.size || e.variations?.some(v => v.renders?.length)));
  box.hidden = !shown.length;
  box.innerHTML = shown.length ? '<div class="prev-title">Earlier runs, to compare</div>' : '';
  for (const entry of shown) {
    const items = entry.variations.flatMap((v, index) => (v.renders || []).slice().reverse().flatMap(r => r.files.map(f => ({ entry, index, render: r, file: f }))));
    const row = document.createElement('div');
    row.className = 'prev-row';
    const tags = [entry.modelName, `🌡 ${Number(entry.temperature).toFixed(2)}`, entry.duration, entry.batch && `🎞 ${entry.batch}`].filter(Boolean);
    row.innerHTML = `<div class="prev-head">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}<span class="spacer"></span><button type="button" class="btn small prev-open">Open</button><button type="button" class="icon-btn prev-x" aria-label="Stop showing this run">✕</button></div><div class="prev-tiles"></div>`;
    const ar = ASPECT_CSS(entry.aspectRatio);
    liveTiles.get(entry)?.forEach(t => { t.style.setProperty('--ar', ar); $('.prev-tiles', row).append(t); });
    items.slice(0, 8).forEach((it, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `rtile${it.file.kind === 'audio' ? ' audio' : ''}`;
      b.style.setProperty('--ar', ar);
      b.setAttribute('aria-label', `Open earlier render ${n + 1}`);
      b.innerHTML = `${mediaTag(it.file, { hover: true })}<span class="rt-meta">Take ${it.index + 1}${it.render.seed != null ? ` · seed ${it.render.seed}` : ''}</span>`;
      b.addEventListener('click', () => openLightbox(items, n));
      $('.prev-tiles', row).append(b);
    });
    $('.prev-open', row).addEventListener('click', () => { if (state.busy) return showEntry(entry); keepPrevious(state.entry); showEntry(entry); });
    $('.prev-x', row).addEventListener('click', () => setPrev(state.prev.filter(e => e !== entry)));
    box.append(row);
  }
}

// Opens the take a chained entry came from.
async function openSource(src) {
  const parent = await api('/api/history').then(h => { state.history = h; return h.find(e => e.id === src.entryId); }).catch(() => null);
  if (!parent) return toast('That take is no longer in History.', true);
  openEntry(parent);
}

function createTake(index, count, model) {
  const chips = [...REFINE_CHIPS.common, ...(model?.motionVideo ? REFINE_CHIPS.character : model?.kind === 'video' ? REFINE_CHIPS.video : [])];
  const name = count > 1 ? `Take ${index + 1}` : 'Your prompt';
  const el = document.createElement('article');
  el.className = 'take';
  el.setAttribute('aria-label', name);
  el.style.setProperty('--m', model ? modelColor(model) : 'var(--hot)');
  el.innerHTML = `
    <div class="take-head">
      <span class="take-title">${count > 1 ? `Take <em>${index + 1}</em>` : 'Your <em>prompt</em>'}</span>
      <span class="status live">Waiting…</span>
      <span class="versions" hidden><button type="button" class="prev" aria-label="Previous version of ${esc(name)}">‹</button><span class="vlabel"></span><button type="button" class="next" aria-label="Next version of ${esc(name)}">›</button></span>
      <div class="take-actions">
        <button type="button" class="btn small save-edit" hidden>💾 Save edit</button>
        <button type="button" class="btn small primary copy" aria-label="Copy ${esc(name)}" disabled>Copy</button>
      </div>
    </div>
    <div class="prompt-well">
      <div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="prompt-view" hidden></div>
      <textarea class="prompt-text" spellcheck="false" aria-label="${esc(name)} text (editable)" hidden></textarea>
    </div>
    <div class="take-meta"><span class="meter" hidden></span><span class="time"></span><span class="change"></span></div>
    <div class="render-zone" hidden></div>
    <form class="refine" hidden>
      <input placeholder="Tweak it… e.g. make it golden hour, add a dog" aria-label="What should change in ${esc(name)}?">
      <button type="submit" title="Refine (Enter)" aria-label="Refine ${esc(name)}">➜</button>
    </form>
    <div class="chips" hidden>${chips.map(([e, c]) => `<button type="button" class="chip-btn" data-instr="${esc(c)}">${e} ${esc(c)}</button>`).join('')}</div>`;
  el.dataset.panel = 'take';
  decoratePanel(el);
  const card = { el, index, view: 0, model, running: new Map(), rb: null };
  const ta = $('.prompt-text', el);

  ta.addEventListener('input', () => {
    autosize(ta);
    updateMeter(card, ta.value);
    $('.save-edit', el).hidden = !cardDirty(card);
  });
  $('.copy', el).addEventListener('click', e => copyText(ta.value.trim(), e.currentTarget));
  $('.save-edit', el).addEventListener('click', () => saveEdit(card));
  $('.prev', el).addEventListener('click', () => pageVersion(card, -1));
  $('.next', el).addEventListener('click', () => pageVersion(card, 1));
  $('.refine', el).addEventListener('submit', e => {
    e.preventDefault();
    const input = $('input', e.currentTarget);
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    refineCard(card, text).then(ok => { if (ok) input.value = ''; });
  });
  $('.chips', el).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) refineCard(card, b.dataset.instr);
  });
  return card;
}

const versionsOf = card => state.entry?.variations?.[card.index]?.versions || [];

// True when the textarea holds a non-empty edit that isn't saved as a version yet.
function cardDirty(card) {
  if (card.interrupted) return false;
  const v = versionsOf(card)[card.view];
  const text = $('.prompt-text', card.el).value.trim();
  return Boolean(v && text && text !== v.text);
}

async function flushEdits() {
  for (const c of state.cards) if (cardDirty(c)) await saveEdit(c, { quiet: true });
}

async function pageVersion(card, delta) {
  if (cardDirty(card)) {
    await saveEdit(card, { quiet: true });
    toast('💾 Your edit was saved as a new version');
  }
  showVersion(card, card.view + delta);
}

function updateMeter(card, text) {
  const meter = $('.meter', card.el);
  const n = countWords(text);
  meter.hidden = !text;
  if (!text) return;
  const target = lengthTarget(card.model, state.entry?.length || state.length);
  if (!target) { meter.textContent = `${n} words`; meter.className = 'meter'; return; }
  const [lo, hi] = target;
  const ok = n >= lo * 0.85 && n <= hi * 1.15;
  meter.textContent = `${n} words · target ${lo}–${hi}${ok ? ' ✓' : ''}`;
  meter.className = `meter ${ok ? 'ok' : 'off'}`;
}

function setStatus(card, text, live = true) {
  const s = $('.status', card.el);
  s.hidden = !text;
  s.textContent = text || '';
  s.className = `status${live ? ' live' : ''}`;
}

function showStreaming(card, text, thinking, reasoningChars) {
  const view = $('.prompt-view', card.el);
  card.partial = text || card.partial;
  if (!text) {
    if (thinking) setStatus(card, `🧠 Thinking…${reasoningChars ? ` ${reasoningChars >= 1000 ? `${(reasoningChars / 1000).toFixed(1)}k` : reasoningChars} chars` : ''}`);
    return;
  }
  setStatus(card, '✍️ Writing…');
  $('.skeleton', card.el).hidden = true;
  $('.prompt-text', card.el).hidden = true;
  view.hidden = false;
  view.textContent = text;
  view.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
  updateMeter(card, text);
}

// A take that was cut off by an error: keep what arrived so nothing is lost.
function markInterrupted(card, text) {
  card.interrupted = true;
  card.el.classList.add('interrupted');
  const ta = $('.prompt-text', card.el);
  $('.skeleton', card.el).hidden = true;
  $('.prompt-view', card.el).hidden = true;
  ta.hidden = false;
  ta.value = text;
  ta.readOnly = true;
  requestAnimationFrame(() => autosize(ta));
  setStatus(card, '⚠️ Cut off, not saved', false);
  $('.copy', card.el).disabled = false;
  $('.refine', card.el).hidden = true;
  $('.chips', card.el).hidden = true;
  $('.versions', card.el).hidden = true;
  $('.render-zone', card.el).hidden = true;
}

function showVersion(card, i) {
  const versions = versionsOf(card);
  if (!versions.length) return;
  card.view = Math.max(0, Math.min(versions.length - 1, i));
  const v = versions[card.view];
  const ta = $('.prompt-text', card.el);
  $('.skeleton', card.el).hidden = true;
  $('.prompt-view', card.el).hidden = true;
  ta.hidden = false;
  ta.readOnly = false;
  ta.value = v.text;
  requestAnimationFrame(() => autosize(ta));
  updateMeter(card, v.text);
  setStatus(card, '');
  const canRefine = Boolean(card.model);
  $('.copy', card.el).disabled = false;
  $('.save-edit', card.el).hidden = true;
  $('.refine', card.el).hidden = !canRefine;
  $('.chips', card.el).hidden = !canRefine;
  $('.versions', card.el).hidden = versions.length < 2;
  $('.vlabel', card.el).textContent = `v${card.view + 1}/${versions.length}`;
  $('.prev', card.el).disabled = card.view === 0;
  $('.next', card.el).disabled = card.view === versions.length - 1;
  $('.change', card.el).textContent = !canRefine ? 'Model deleted, so refining is off' : v.instruction ? `↳ “${v.instruction}”` : '';
  const secs = card.view === versions.length - 1 ? state.timings[card.index] : null;
  $('.time', card.el).textContent = secs ? `⏱ ${secs.toFixed(1)}s` : '';
  renderZone(card);
}

function renderResults(entry, { totalSecs } = {}) {
  state.entry = entry;
  renderPrevStrip();
  const list = $('#resultsList');
  list.innerHTML = '';
  state.cards = [];
  $('#resultsEmpty').hidden = Boolean(entry);
  renderStageHead(entry, { totalSecs });
  syncNewBtn();
  if (!entry) return;
  const model = modelById(entry.modelId);
  entry.variations.forEach((v, i) => {
    const card = createTake(i, entry.variations.length, model);
    state.cards.push(card);
    list.append(card.el);
    showVersion(card, v.versions.length - 1);
  });
  setBusy(state.busy);
  if (entry.id) resumeRenders(entry);
}

// Swap the streaming placeholders for the saved takes, keeping the same card elements.
function adoptEntry(entry, totalSecs) {
  state.entry = entry;
  state.cards = state.cards.filter(c => {
    if (entry.variations[c.index]) return true;
    if (c.partial && !state.stopping) { markInterrupted(c, c.partial); return true; }
    c.el.remove(); // stopped before it finished
    return false;
  });
  state.cards.forEach(c => { if (!c.interrupted) showVersion(c, entry.variations[c.index].versions.length - 1); });
  renderStageHead(entry, { totalSecs });
  setBusy(state.busy);
}

function setBusy(busy) {
  state.busy = busy;
  $('#generateBtn').disabled = busy || state.chainActive || Boolean(state.batchRun);
  updateGenerateLabel();
  $('#stopBtn').hidden = !busy && !state.chainActive && !state.batchRun;
  syncNewBtn();
  drawLine();
  if (!running() && line.orders.length && !line.held && !line.pumping) setTimeout(pumpLine, 0); // queued during a refine or a chain
  $$('.take .refine button, .take .refine input, .take .chips button, .take .save-edit, .take .versions button').forEach(el => { el.disabled = busy; });
  if (!busy) state.cards.forEach(c => { if (!c.interrupted && versionsOf(c).length) { $('.prev', c.el).disabled = c.view === 0; $('.next', c.el).disabled = c.view === versionsOf(c).length - 1; } });
  $('#draftBtn').disabled = busy;
}

// Stop asks the server to cancel, so takes that already finished still arrive and are kept. Orders still in line
// carry on (✕ takes one out).
function stop() {
  if (line.running) line.running.stopped = true;
  const run = state.chainActive ? state.run : null;
  if (run && !run.stopped) {
    // Stopping a chain: no further steps, and its renders still in ComfyUI are cancelled.
    run.stopped = true;
    for (const r of state.renderRuns) {
      if (r.runId) api(`/api/runs/${r.runId}/cancel`, { method: 'POST' }).catch(() => r.controller.abort());
      else r.controller.abort();
    }
    $('#genLabel').textContent = 'Stopping…';
    toast('■ Chain stopped. Finished steps are kept');
  }
  const batch = state.batchRun;
  if (batch && !batch.stopped) {
    // Stopping a batch: nothing new starts, and its renders still in ComfyUI are cancelled. Finished ones stay.
    batch.stopped = true;
    for (const r of state.renderRuns) {
      if (r.runId) api(`/api/runs/${r.runId}/cancel`, { method: 'POST' }).catch(() => r.controller.abort());
      else r.controller.abort();
    }
    $('#genLabel').textContent = 'Stopping…';
  }
  if (!state.busy || state.stopping) return;
  state.stopping = true;
  $('#genLabel').textContent = 'Stopping…';
  if (state.runId) {
    api(`/api/runs/${state.runId}/cancel`, { method: 'POST' }).catch(() => state.controller?.abort());
    setTimeout(() => { if (state.stopping) state.controller?.abort(); }, 4000);
  } else {
    state.controller?.abort();
  }
}

// ---------- create: new session ----------

// New swaps places with Stop while a prompt is cooking, and has nothing to do on a blank slate.
function syncNewBtn() {
  const b = $('#newBtn');
  b.hidden = running() || line.pumping;
  b.disabled = !($('#theme').value.trim() || state.image || state.video || state.entry);
}

function setThemeQuietly(text) {
  const t = $('#theme');
  t.value = text;
  saved.set('theme', text);
  themeUndo = null;
  $('#themeUndo').hidden = true;
  sizeTheme();
}

// A clean slate: theme, image and takes go; the model, dials and workflow stay. The takes are already in History.
async function newSession() {
  if (state.busy) return;
  await flushEdits();
  const before = { theme: $('#theme').value, image: state.image, video: state.video?.file ? state.video : null, entry: state.entry?.id ? state.entry : null, timings: state.timings };
  showError('');
  setThemeQuietly('');
  setImage(null);
  setVideo(null);
  state.timings = {};
  closeRun();
  renderResults(null);
  setTitle('');
  window.scrollTo({ top: 0, behavior: scrollMode() });
  $('#theme').focus({ preventScroll: true });
  announce('New session. The theme, image and takes are cleared.');
  const rendering = state.renderRuns.size ? ' Renders still running will land in the Gallery.' : '';
  toast(`✨ Fresh start.${before.entry ? ' Your takes are in History.' : ''}${rendering}`, false, {
    label: '↶ Undo',
    run: () => {
      if (state.busy || state.entry) return toast('Too late to undo here. It\'s all in History.', true);
      setThemeQuietly(before.theme);
      setImage(before.image);
      if (before.video) restoreVideo(before.video);
      if (before.entry) {
        state.timings = before.timings;
        renderResults(before.entry);
      }
      toast('↶ Back where you were');
    },
  });
}
$('#newBtn').addEventListener('click', newSession);

// Generate takes the form as it is right now, and runs it, or puts it in line if something is still going.
async function generate() {
  if (state.chain.steps.length) {
    if (lineBusy()) return toast('A chain can\'t wait in line: it may stop and ask you to pick. Run it once this is done.', true);
    return runChain();
  }
  const order = await takeOrder();
  if (order) return enqueue(order);
}

// ---------- create: the line ----------
// Every Generate is an order: the form as it was at the click (model, dials, theme, image, batch) and its render
// setup (workflow, LoRAs, sampler settings), so changing the form afterwards only changes the next one. Orders run
// one after another; a take's renders go on in ComfyUI while the next prompt is written. A failure puts the line on
// hold. ■ Stop stops only the one running.

const line = { orders: [], running: null, pumping: false, held: false, seq: 0 };
const running = () => state.busy || state.chainActive || Boolean(state.batchRun);
const lineBusy = () => running() || line.pumping || (line.orders.length > 0 && !line.held);
const lineNote = () => (line.orders.length ? ` · ${line.orders.length} more in line` : '');

async function takeOrder() {
  const batchList = pickedBatches();
  const body = await formRequest();
  if (!body) return null;
  const m = currentModel();
  const flow = state.workflows.find(f => f.id === activeWorkflowId(m.id));
  const renders = flow && (batchList.length > 0 || saved.get(autoRenderKey(m.id), false));
  let finish;
  const done = new Promise(r => { finish = r; });
  return {
    id: ++line.seq,
    at: Date.now(),
    body,
    model: m,
    batches: structuredClone(batchList),
    render: renders ? structuredClone({ workflowId: flow.id, flowName: flow.name, loras: { tweaks: flow.loras?.tweaks || {}, added: flow.loras?.added || [] }, overrides: flow.overrides || {} }) : null,
    done,
    finish,
  };
}

const orderKey = o => JSON.stringify([o.body, o.batches, o.render]);

// Resolves once this order has run (or left the line).
function enqueue(order) {
  const last = line.orders.at(-1) || line.running;
  // A double click or a second Ctrl+Enter on the same form isn't a second order.
  if (last && order.at - last.at < 1000 && orderKey(last) === orderKey(order)) return last.done;
  line.orders.push(order);
  const waits = running() || line.pumping || line.orders.length > 1;
  line.held = false;
  drawLine();
  if (waits) {
    toast(`⏳ In line (${line.orders.length} waiting). Changing the form now won't change it`, false, { label: '✕ Take it out', run: () => dropOrder(order.id) });
  }
  pumpLine();
  return order.done;
}

async function pumpLine() {
  if (line.pumping) return;
  line.pumping = true;
  try {
    while (line.orders.length && !line.held && !running()) {
      const order = line.orders.shift();
      line.running = order;
      drawLine();
      const ok = await runOrder(order);
      line.running = null;
      order.finish();
      if (!ok && !order.stopped && line.orders.length) {
        line.held = true;
        toast(`⏸ The line is on hold: that one failed. ${line.orders.length} still waiting`, true);
      }
      // Whoever waited for this order (the assistant) reads the stage before the next order takes it.
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    line.pumping = false;
    line.running = null;
    drawLine();
    syncNewBtn();
  }
}

// Returns false if it failed (the reason is on the stage).
async function runOrder(order) {
  closeRun();
  if (order.batches.length) return runBatches(order);
  const entry = await runGeneration(order.body, order.model);
  if (!entry) return false;
  if (!order.render) return true;
  if (!state.comfy?.ok) await loadComfyStatus();
  if (!state.comfy?.ok) {
    showError(state.comfy?.error || 'ComfyUI is not reachable.');
    return false;
  }
  if (state.entry !== entry) return true; // you opened something else meanwhile; its render bar is still there
  state.cards.forEach(c => {
    if (!c.rb || c.interrupted) return;
    c.rb.workflowId = order.render.workflowId;
    const sel = $('.rb-wf', c.el);
    if (sel) sel.value = c.rb.workflowId;
    startRender(c, { setup: order.render });
  });
  return true;
}

// Takes an order out of line, with a toast to put it back where it was.
function dropOrder(id) {
  const i = line.orders.findIndex(o => o.id === id);
  if (i < 0) return toast('Too late: that one already started.', true);
  const [order] = line.orders.splice(i, 1);
  order.finish();
  if (!line.orders.length) line.held = false;
  drawLine();
  toast(`✕ Took “${cut(order.body.theme || 'From an image', 30)}” out of line`, false, {
    label: '↶ Undo',
    run: () => { line.orders.splice(Math.min(i, line.orders.length), 0, order); drawLine(); pumpLine(); },
  });
}

function orderLine(o) {
  const what = o.batches.length ? `🎞 ${o.batches.map(b => b.name).join(', ')}` : `${o.body.variations} take${o.body.variations > 1 ? 's' : ''}`;
  return [o.model.name, o.body.aspectRatio, what, o.render ? `🎨 ${o.render.flowName}` : 'no render', o.body.imageFile || o.body.image ? '🖼 image' : ''].filter(Boolean).join(' · ');
}

function drawLine() {
  const n = line.orders.length;
  $('#queueBtn').hidden = (!running() && !line.pumping) || state.chain.steps.length > 0;
  $('#queueCount').hidden = !n;
  $('#queueCount').textContent = n;
  $('#queueBtn').setAttribute('aria-label', n ? `Queue (${n} waiting)` : 'Queue');
  $('#lineBox').hidden = !n;
  $('#lineBox').classList.toggle('held', line.held);
  if (!n) return;
  $('#lineHead').textContent = line.held ? `⏸ On hold · ${n} waiting` : `⏳ Up next · ${n}`;
  $('#lineGo').hidden = !line.held;
  $('#lineList').innerHTML = line.orders.map((o, i) => `<li data-id="${o.id}" style="--m:${modelColor(o.model)}">
    <span class="ln-n">${i + 1}</span>
    <span class="ln-main"><b>${esc(o.body.theme || 'From an image')}</b><small>${esc(orderLine(o))}</small></span>
    <button type="button" class="icon-btn ln-del" title="Take it out of line" aria-label="Take “${esc(cut(o.body.theme || 'From an image', 40))}” out of line">✕</button>
  </li>`).join('');
}

$('#queueBtn').addEventListener('click', generate);
$('#lineList').addEventListener('click', e => {
  const li = e.target.closest('.ln-del') && e.target.closest('li');
  if (li) dropOrder(Number(li.dataset.id));
});
$('#lineGo').addEventListener('click', () => {
  line.held = false;
  showError('');
  drawLine();
  pumpLine();
});
$('#lineClear').addEventListener('click', e => confirmClick(e.currentTarget, 'Sure?', () => {
  const gone = line.orders.splice(0);
  gone.forEach(o => o.finish());
  line.held = false;
  drawLine();
  toast(`✕ Cleared the line (${gone.length})`, false, { label: '↶ Undo', run: () => { line.orders.unshift(...gone); drawLine(); pumpLine(); } });
}));

// Checks the Create form and turns it into a generate request (null, with the reason shown, if it can't run).
async function formRequest() {
  const m = currentModel();
  const theme = $('#theme').value.trim();
  showError('');
  if (!m) return showError('Pick a target model first. No models? Add one in the Models tab.');
  const motion = m.motionVideo ? videoForRequest() : null;
  if (m.motionVideo && state.video && !motion) return showError('Hold on, the motion video is still loading.');
  if (!theme && !state.image && !motion) {
    $('#theme').focus();
    return showError(m.motionVideo ? 'Give me something to work with: add your character and a motion video in step 3, type a theme, or both.' : 'Give me something to work with: type a theme, add an image, or both.');
  }
  if (state.llmOk === false) await loadLlms();
  if (state.llmOk === false) return showError(`Can't reach LM Studio at ${state.settings.lmStudioUrl}. Its local server is off (quitting the LM Studio app turns it off too).`);
  const llm = selectedLlm();
  if (state.image && llm?.vision === false) return showError(`${llm.name} is text-only and can't see images. Pick a vision model (👁) in the top bar.`);
  await flushEdits();

  const body = {
    modelId: m.id,
    theme,
    imageRole: effectiveRole(),
    aspectRatio: $('#aspect').value,
    resolution: $('#resolution').value,
    duration: m.kind === 'video' ? $('#duration').value : '',
    length: state.length,
    temperature: Number($('#temperature').value),
    variations: state.variations,
    ...(state.image?.file ? { imageFile: state.image.file } : state.image?.dataUrl ? { image: state.image.dataUrl } : {}),
    ...(state.image?.source ? { source: state.image.source } : {}),
    ...(motion ? { video: motion } : {}),
  };
  if (state.image?.source && m.kind === 'video' && !m.motionVideo) saved.set('animateModel', m.id);
  return body;
}

// Writes the takes for a request into the stage, streaming. Returns the saved history entry, or null.
async function runGeneration(body, m) {
  keepPrevious(state.entry);
  // Placeholder entry so the stage header and meters work while streaming.
  state.entry = { ...body, modelName: m.name, modelKind: m.kind, variations: [] };
  state.timings = {};
  state.runId = null;
  state.stopping = false;
  $('#resultsEmpty').hidden = true;
  const list = $('#resultsList');
  list.innerHTML = '';
  const count = body.variations;
  state.cards = Array.from({ length: count }, (_, i) => createTake(i, count, m));
  state.cards.forEach(c => list.append(c.el));
  state.cards.forEach((c, i) => setStatus(c, i === 0 ? 'Warming up…' : 'Queued', i === 0));
  renderStageHead(state.entry, { running: true });
  state.controller = new AbortController();
  setBusy(true);
  setTitle(count > 1 ? `✍️ Take 1/${count}` : '✍️ Writing');
  announce(`Generating ${count > 1 ? `${count} takes` : 'a prompt'} for ${m.name}`);
  const stageTop = $('.stage').getBoundingClientRect().top;
  if (stageTop < 70 || stageTop > innerHeight * 0.6) $('.stage').scrollIntoView({ behavior: scrollMode(), block: 'start' });

  const t0 = performance.now();
  let takeStart = t0;
  let current = 0;
  let savedEntry = null;
  let failed = null;
  try {
    await streamApi('/api/generate', body, ev => {
      const card = state.cards[ev.index ?? current];
      if (ev.type === 'start') {
        state.runId = ev.runId;
        state.entry.llmName = ev.llmName;
        renderStageHead(state.entry, { running: true });
      } else if (ev.type === 'status' && state.cards[current]) {
        setStatus(state.cards[current], `⏳ ${ev.text}`);
      } else if (ev.type === 'delta' && card) {
        showStreaming(card, ev.text, ev.thinking, ev.reasoningChars);
      } else if (ev.type === 'done' && card) {
        state.timings[ev.index] = (performance.now() - takeStart) / 1000;
        takeStart = performance.now();
        showStreaming(card, ev.text, false);
        $('.caret', card.el)?.remove();
        setStatus(card, '✓ Done', false);
        announce(`${count > 1 ? `Take ${ev.index + 1}` : 'Prompt'} done`);
        current = ev.index + 1;
        if (state.cards[current]) {
          setStatus(state.cards[current], 'Up next…');
          setTitle(`✍️ Take ${current + 1}/${count}`);
        }
      } else if (ev.type === 'error') {
        failed = ev.message;
        if (card && ev.partial) card.partial = ev.partial;
      } else if (ev.type === 'saved') {
        savedEntry = ev.entry;
      }
    }, state.controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') failed = friendly(err);
  }
  const stopped = state.stopping;
  state.controller = null;
  state.runId = null;
  setBusy(false);
  if (savedEntry) {
    savedEntry.llmName = state.entry.llmName;
    adoptEntry(savedEntry, (performance.now() - t0) / 1000);
    bumpHistoryBadge(1);
  } else {
    const keep = stopped ? [] : state.cards.filter(c => c.partial);
    state.cards.filter(c => !keep.includes(c)).forEach(c => c.el.remove());
    state.cards = keep;
    keep.forEach(c => markInterrupted(c, c.partial));
    if (keep.length) renderStageHead(state.entry); else renderResults(null);
  }
  state.stopping = false;
  if (failed) showError(failed);
  else if (stopped) toast(`${savedEntry ? `■ Stopped. Kept ${savedEntry.variations.length} finished take${savedEntry.variations.length > 1 ? 's' : ''}` : '■ Stopped'}${lineNote()}`);
  setTitle(failed ? '⚠️ Failed' : document.hidden && savedEntry ? '✓ Done' : '');
  loadLlms(); // a run can load a model or reveal that LM Studio went away
  return savedEntry;
}

async function refineCard(card, instruction) {
  if (state.busy || !state.entry?.id || !card.model) return false;
  showError('');
  const llm = selectedLlm();
  if (state.entry.imageFile && llm?.vision === false) {
    showError(`${llm.name} is text-only and can't see this take's image. Pick a vision model (👁) in the top bar.`);
    return false;
  }
  const trigger = document.activeElement;
  const ta = $('.prompt-text', card.el);
  const before = ta.value;
  state.controller = new AbortController();
  state.runId = null;
  state.stopping = false;
  setBusy(true);
  setStatus(card, `🔁 ${instruction}`);
  setTitle('🔁 Refining');
  const t0 = performance.now();
  let savedEntry = null;
  let failed = null;
  try {
    await streamApi('/api/refine', {
      historyId: state.entry.id,
      index: card.index,
      baseIndex: card.view,
      instruction,
      currentText: ta.value,
      temperature: Number(state.entry.temperature),
    }, ev => {
      if (ev.type === 'start') state.runId = ev.runId;
      else if (ev.type === 'status') setStatus(card, `⏳ ${ev.text}`);
      else if (ev.type === 'delta') showStreaming(card, ev.text, ev.thinking, ev.reasoningChars);
      else if (ev.type === 'error') failed = ev.message;
      else if (ev.type === 'saved') savedEntry = ev.entry;
    }, state.controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') failed = friendly(err);
  }
  const stopped = state.stopping;
  state.controller = null;
  state.runId = null;
  state.stopping = false;
  setBusy(false);
  if (savedEntry) {
    savedEntry.llmName = state.entry.llmName;
    state.entry = savedEntry;
    syncRunEntry(savedEntry);
    state.timings[card.index] = (performance.now() - t0) / 1000;
    showVersion(card, savedEntry.variations[card.index].versions.length - 1);
    announce(`Refined: ${instruction}`);
    autoRender([card]);
  } else {
    showVersion(card, card.view);
    ta.value = before;
    autosize(ta);
    updateMeter(card, before);
    $('.save-edit', card.el).hidden = !cardDirty(card);
  }
  if (failed) showError(failed);
  else if (stopped) toast('■ Stopped');
  setTitle('');
  if (trigger?.isConnected && !trigger.disabled) trigger.focus();
  loadLlms();
  return Boolean(savedEntry);
}

async function saveEdit(card, { quiet = false } = {}) {
  const text = $('.prompt-text', card.el).value.trim();
  if (!text) return toast('An empty prompt can\'t be saved.', true);
  try {
    const entry = await api(`/api/history/${state.entry.id}`, { method: 'PATCH', body: { index: card.index, text } });
    entry.llmName = state.entry.llmName;
    state.entry = entry;
    syncRunEntry(entry);
    showVersion(card, entry.variations[card.index].versions.length - 1);
    if (!quiet) toast('💾 Saved as a new version');
  } catch (err) {
    toast(err.message, true);
  }
}

$('#createForm').addEventListener('submit', e => { e.preventDefault(); generate(); });
$('#stopBtn').addEventListener('click', stop);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && isView('create') && !e.target.closest?.('.take, #assistant')) {
    e.preventDefault();
    generate();
  }
  if (!$('#lightbox').hidden) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    return;
  }
  if ($('#wfDialog').open) return;
  if (e.key === 'Escape' && (state.busy || state.chainActive || state.batchRun)) stop();
});

// ---------- history ----------

function bumpHistoryBadge(delta) {
  const badge = $('#historyBadge');
  const n = Math.max(0, (Number(badge.textContent) || 0) + delta);
  badge.textContent = n;
  badge.hidden = !n;
}

// Deletes an entry for good (History's Delete, and the assistant after you confirm). Returns a note if ComfyUI's
// copies may be out of reach.
async function deleteEntryNow(entry) {
  const { left } = await api(`/api/history/${entry.id}`, { method: 'DELETE' });
  historyDeletes++;
  state.history = state.history.filter(x => x.id !== entry.id);
  forgetEntry(entry);
  forgetSeenImages();
  bumpHistoryBadge(-1);
  renderHistoryFilters();
  if (isView('history')) renderHistory();
  toast(left ? `🗑️ Deleted. ${left}` : '🗑️ Deleted for good', Boolean(left));
  return left || null;
}

// Counts deletes, so a list fetched before one can't bring the deleted card back.
let historyDeletes = 0;

// Opening History shows the card that is open on Create (further down the list, it's revealed and scrolled to).
function revealCurrentCard() {
  const i = state.history.findIndex(e => e.id === state.entry?.id);
  if (i >= state.historyLimit) state.historyLimit = Math.ceil((i + 1) / 48) * 48;
}

async function loadHistory() {
  try {
    const deletes = historyDeletes;
    const list = await api('/api/history');
    if (deletes === historyDeletes) state.history = list;
  } catch (err) {
    toast(err.message, true);
  }
  $('#historyBadge').textContent = state.history.length;
  $('#historyBadge').hidden = !state.history.length;
  renderHistoryFilters();
  revealCurrentCard();
  renderHistory();
  $('#historyList .hcard.current')?.scrollIntoView({ block: 'nearest' });
}

function renderHistoryFilters() {
  const names = [...new Map(state.history.map(e => [e.modelId, e.modelName])).entries()];
  if (state.historyFilter && !names.some(([id]) => id === state.historyFilter)) state.historyFilter = '';
  const box = $('#historyFilters');
  const key = JSON.stringify(names);
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = [['', 'All models'], ...names].map(([id, name]) => {
      const m = modelById(id);
      return `<button type="button" class="chip-btn" data-id="${esc(id)}" style="--m:${id ? modelColor(m || { id }) : 'var(--text-2)'}">${id ? `${kindIcon(m?.kind)} ` : ''}${esc(name)}</button>`;
    }).join('');
  }
  $$('button', box).forEach(b => b.setAttribute('aria-pressed', b.dataset.id === state.historyFilter));
}

function renderHistory() {
  const q = $('#historySearch').value.trim().toLowerCase();
  const items = state.history.filter(e =>
    (!state.historyFilter || e.modelId === state.historyFilter) &&
    (!state.historyFav || e.favorite) &&
    (!q || [e.theme, e.modelName, e.batch, ...e.variations.flatMap(v => v.versions.map(x => x.text))].join('\n').toLowerCase().includes(q)));
  $('#historyCount').textContent = state.history.length ? (items.length === state.history.length ? state.history.length : `${items.length} of ${state.history.length}`) : '';
  const list = $('#historyList');
  // Remember keyboard focus across the re-render.
  const focused = document.activeElement?.closest?.('.hcard') && document.activeElement.dataset.act
    ? { id: document.activeElement.closest('.hcard').dataset.id, act: document.activeElement.dataset.act } : null;
  if (!items.length) {
    const none = !state.history.length;
    list.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>${none ? 'Nothing here yet' : 'No matches'}</h3>
      <p>${none ? 'Every prompt you generate lands here automatically.' : 'Try a different search, model or the favorites filter.'}</p>
      ${none ? '<div class="try"><button type="button" class="btn primary" data-go="create">✦ Make your first prompt</button></div>' : ''}</div>`;
    $('[data-go]', list)?.addEventListener('click', () => showView('create'));
    return;
  }
  let group = '';
  const shown = items.slice(0, state.historyLimit);
  list.innerHTML = shown.map(e => {
    const g = dayGroup(e.createdAt);
    const heading = g !== group ? `<h2 class="hgroup">${g}</h2>` : '';
    group = g;
    const m = modelById(e.modelId);
    const color = modelColor(m || { id: e.modelId });
    const first = e.variations[0].versions.at(-1).text;
    const takes = e.variations.length;
    const edits = e.variations.reduce((n, v) => n + v.versions.length - 1, 0);
    const bits = [e.aspectRatio, e.duration, takes > 1 ? `${takes} takes` : '', edits ? `${edits} tweak${edits > 1 ? 's' : ''}` : ''].filter(Boolean);
    const title = e.theme || 'No theme: built from the image';
    const allRenders = e.variations.flatMap(v => v.renders || []);
    const renderCount = allRenders.length;
    const cover = allRenders.length ? allRenders.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).files[0] : null;
    return `${heading}
      <article class="hcard${e.id === state.entry?.id ? ' current' : ''}" data-id="${esc(e.id)}" style="--m:${color}"${e.id === state.entry?.id ? ' aria-current="true" title="Open on Create"' : ''}>
        <div class="hthumb hopen${cover || e.imageFile ? '' : ' textonly'}" data-act="open" aria-hidden="true">
          ${cover ? mediaTag(cover, { hover: true }) : e.imageFile ? `<img src="/images/${esc(e.imageFile)}" alt="" loading="lazy">` : kindIcon(e.modelKind)}
          ${cover ? `<span class="tag kind">🎨 ${renderCount} render${renderCount > 1 ? 's' : ''}</span>` : e.imageFile ? `<span class="tag kind">${{ reference: '🎯 reference', recreate: '🪞 recreate', animate: '🎬 animate', character: e.video ? '🧍 character · 🕺 motion' : '🧍 character' }[e.imageRole] || ''}</span>` : ''}
        </div>
        <button type="button" class="hstar${e.favorite ? ' on' : ''}" data-act="fav" aria-pressed="${Boolean(e.favorite)}" aria-label="Favorite: ${esc(title)}" title="${e.favorite ? 'Unfavorite' : 'Favorite'}">${e.favorite ? '★' : '☆'}</button>
        <div class="hbody">
          <div class="hmeta"><span class="tag model">${kindIcon(e.modelKind)} ${esc(e.modelName)}</span>${e.chain ? `<span class="tag chain" title="Part of a chain run. Open it to see every step">⛓ step ${e.chain.step + 1}</span>` : ''}${e.batch ? `<span class="tag batch" title="From the batch “${esc(e.batch)}”">🎞 ${esc(e.batch)}</span>` : ''}${e.source ? `<span class="hsrc" title="${esc(takeLabel(e.source))}">⬑ from ${esc(e.source.modelName)}</span>` : ''}<span>${esc(bits.join(' · '))}</span><span>· ${esc(timeAgo(e.createdAt))}</span></div>
          <div class="htheme hopen${e.theme ? '' : ' none'}" data-act="open">${esc(title)}</div>
          <p class="hprompt">${esc(first)}</p>
          <div class="hactions">
            <button type="button" class="btn small" data-act="copy" aria-label="Copy ${takes > 1 ? `all ${takes} takes` : 'prompt'}: ${esc(title)}">${takes > 1 ? `Copy all ${takes}` : 'Copy'}</button>
            <button type="button" class="btn small danger" data-act="delete" aria-label="Delete: ${esc(title)}" title="Deletes it for good: its prompts, input image and renders, here and in ComfyUI">Delete</button>
            <button type="button" class="btn small primary open" data-act="open" aria-label="Open: ${esc(title)}">Open ➜</button>
          </div>
        </div>
      </article>`;
  }).join('') + (items.length > shown.length ? `<button type="button" class="btn more" data-act="more">Show ${Math.min(48, items.length - shown.length)} more (${items.length - shown.length} left)</button>` : '');
  if (focused) $(`.hcard[data-id="${CSS.escape(focused.id)}"] button[data-act="${focused.act}"]`, list)?.focus();
}

$('#historySearch').addEventListener('input', () => { state.historyLimit = 48; renderHistory(); });
$('#historyFilters').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  state.historyFilter = b.dataset.id;
  state.historyLimit = 48;
  renderHistoryFilters();
  renderHistory();
});
$('#historyFav').addEventListener('click', e => {
  state.historyFav = !state.historyFav;
  e.currentTarget.setAttribute('aria-pressed', state.historyFav);
  e.currentTarget.textContent = state.historyFav ? '★ Favorites' : '☆ Favorites';
  renderHistory();
});
$('#historyList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'more') {
    state.historyLimit += 48;
    renderHistory();
    return;
  }
  const id = btn.closest('.hcard').dataset.id;
  const entry = state.history.find(x => x.id === id);
  if (!entry) return;
  try {
    if (btn.dataset.act === 'copy') {
      copyText(takesText(entry.variations.map(v => v.versions.at(-1).text)), btn);
    } else if (btn.dataset.act === 'fav') {
      Object.assign(entry, await api(`/api/history/${id}`, { method: 'PATCH', body: { favorite: !entry.favorite } }));
      if (state.entry?.id === id) state.entry.favorite = entry.favorite;
      renderHistory();
    } else if (btn.dataset.act === 'delete') {
      confirmClick(btn, 'Sure?', () => deleteEntryNow(entry));
    } else if (btn.dataset.act === 'open') {
      await openEntry(entry);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// Every copy of an entry the page holds: the stage, History, earlier runs and the chain run each may have their own.
const copiesOf = id => new Set([state.entry, ...state.history, ...state.prev, ...(state.run?.entries || [])].filter(e => e?.id === id));

// A deleted (or re-starred) render changes every view at once, so no stale thumbnail stays on screen.
function forgetRender(updated) {
  for (const e of copiesOf(updated.id)) e.variations.forEach((v, i) => { v.renders = (updated.variations[i]?.renders || []).slice(); });
  if (state.entry?.id === updated.id) state.cards.forEach(renderTiles);
  renderPrevStrip();
  if (state.run) renderRunStrip();
  if (isView('gallery')) renderGallery();
  if (isView('history')) renderHistory();
}

// A deleted entry leaves no trace on this page either: not on the stage, among earlier runs or in a chain run, as a
// link from the takes made from it, or in the Create form (its theme and image) when it's still what the form holds.
function forgetEntry(entry) {
  if (state.entry?.id === entry.id) renderResults(null);
  setPrev(state.prev.filter(e => e.id !== entry.id));
  if (state.run?.entries.some(e => e.id === entry.id)) {
    state.run.entries = state.run.entries.filter(e => e.id !== entry.id);
    for (const [k, it] of state.run.picks) if (it.entry.id === entry.id) state.run.picks.delete(k);
    if (state.run.entries.length) renderRunStrip(); else closeRun();
  }
  for (const e of state.history) if (e.source?.entryId === entry.id) delete e.source;
  const img = state.image;
  const onlyItsImage = entry.imageFile && img?.file === entry.imageFile && !state.history.some(e => e.imageFile === img.file);
  if (img && (onlyItsImage || img.source?.entryId === entry.id)) {
    setImage(null);
    // A copy made for the form (of one of its renders) that nothing else uses goes too.
    if (img.file && !state.history.some(e => e.imageFile === img.file) && !line.orders.some(o => o.body.imageFile === img.file)) api(`/api/images/${encodeURIComponent(img.file)}`, { method: 'DELETE' }).catch(() => {});
  }
  if (entry.theme && $('#theme').value.trim() === entry.theme.trim()) {
    $('#theme').value = ''; // not replaceTheme: its undo would bring the deleted words back
    $('#theme').dispatchEvent(new Event('input'));
  }
}

// The rest of what an entry was made with: its batch, and how its newest render was made (workflow,
// renders per take, seed, LoRAs, sampler settings), so the next Generate or Render works the same way.
async function restoreSetup(entry) {
  const b = entry.batch && batches().find(x => x.name === entry.batch);
  setBatchPick(b ? b.id : '');
  const renders = entry.variations.flatMap(v => v.renders || []);
  const r = renders.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const flow = r && state.workflows.find(f => f.id === r.workflowId && f.modelId === entry.modelId);
  if (!flow) return;
  pickWorkflow(entry.modelId, flow.id);
  // Renders per take: as recorded, else how many each take got with that workflow (older entries).
  const count = clampInt(r.count ?? Math.max(...entry.variations.map(v => (v.renders || []).filter(x => x.workflowId === flow.id && x.versionIndex === r.versionIndex).length)), 1, BATCH_MAX);
  state.cards.forEach(c => { if (c.rb) { c.rb.count = count; c.rb.workflowId = flow.id; renderZone(c); } });
  // The seed the run started at (a ×N run gets one seed after another).
  const take = entry.variations.find(v => (v.renders || []).includes(r)).renders;
  const first = take.slice(-count).find(x => x.workflowId === flow.id) || r;
  if (first.seed != null && flow.seed?.inputs) await setSeed(flow, { mode: r.seedMode || flow.seed.mode, value: first.seed });
  if (flow.loras) {
    const used = new Map((r.loras || []).map(l => [l.name, l.strength]));
    const l = flow.loras;
    for (const n of l.nodes) {
      const on = used.has(n.name);
      const next = { on, strength: on ? used.get(n.name) : n.strength };
      if (next.on === n.on && next.strength === n.strength) delete l.tweaks[n.key]; else l.tweaks[n.key] = next;
      used.delete(n.name);
    }
    for (const a of l.added) { a.on = used.has(a.name); if (a.on) { a.strength = used.get(a.name); used.delete(a.name); } }
    for (const [name, strength] of used) l.added.push({ name, strength, on: true });
    saveLoras(flow, { now: true });
    renderLoraPanel();
  }
  if (r.overrides && JSON.stringify(r.overrides) !== JSON.stringify(flow.overrides || {})) {
    const patch = { ...Object.fromEntries(Object.keys(flow.overrides || {}).map(k => [k, null])), ...r.overrides };
    await api(`/api/workflows/${flow.id}`, { method: 'PUT', body: { overridePatch: patch } }).catch(() => {});
    await loadWorkflows();
  }
  renderWorkflowPicker();
  state.cards.forEach(c => c.rb && renderZone(c));
}

// Puts an entry's setup back into the Create form: model, dials, theme, image and takes.
async function loadForm(entry) {
  await flushEdits();
  if (modelById(entry.modelId)) {
    selectModel(entry.modelId, { values: entry });
  } else {
    toast(`Model "${entry.modelName}" no longer exists, so refining is off.`, true);
  }
  if (($('#theme').value || '') !== (entry.theme || '')) replaceTheme(entry.theme || '', { focus: false });
  if (entry.imageRole) state.imageRole = entry.imageRole;
  const src = entry.source;
  setImage(entry.imageFile ? { file: entry.imageFile, ...(src ? { source: { entryId: src.entryId, index: src.index, renderId: src.renderId, file: src.file, modelName: src.modelName, seed: src.seed } } : {}) } : null);
  if (modelById(entry.modelId)?.motionVideo) restoreVideo(entry.video);
  setVariations(entry.variations.length, { persist: false });
  showError('');
}

async function openEntry(entry) {
  if (state.busy || state.chainActive) return toast('Hold on, something is still cooking. Stop it or wait.', true);
  if (entry.chain) return openRun(entry);
  await loadForm(entry);
  closeRun();
  state.timings = {};
  showView('create');
  renderResults(entry);
  await restoreSetup(entry);
  requestAnimationFrame(() => {
    const stage = $('.stage');
    if (stage.getBoundingClientRect().left < 40) stage.scrollIntoView({ block: 'start' }); // single-column layout
    else window.scrollTo({ top: 0 });
  });
}

// ---------- models editor ----------

const NEW_MODEL = {
  name: '',
  kind: 'image',
  description: '',
  instructions: `## What this model is
-

## Prompt structure
-

## Vocabulary that works
-

## Avoid
-

## Using an attached image
- Reference:
- Recreate:

## Aspect ratio & length
- `,
  examples: [],
  aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  resolutions: [],
  durations: [],
  defaults: { aspectRatio: '1:1', resolution: '', duration: '', temperature: 0.8, length: 'medium' },
  lengthGuide: { short: '≈40–70 words', medium: '≈80–130 words', long: '≈150–220 words' },
  sources: [],
};

// ---------- Brains (Models → Brains) ----------

let modelsPane = saved.get('modelsPane', 'models');
let brainSort = saved.get('brainSort', 'fit');
const brainFilter = loadBrainFilter('brainFilters');
function showModelsPane(pane, { push = true } = {}) {
  modelsPane = pane === 'brains' ? 'brains' : 'models';
  saved.set('modelsPane', modelsPane);
  $$('.models-switch button').forEach(b => {
    const on = b.dataset.pane === modelsPane;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('#modelsPane').hidden = modelsPane !== 'models';
  $('#modelsIntro').hidden = modelsPane !== 'models';
  $('#brainsPane').hidden = modelsPane !== 'brains';
  $('#brainsIntro').hidden = modelsPane !== 'brains';
  const hash = modelsPane === 'brains' ? '#models/brains' : '#models';
  if (push && location.hash !== hash) history.pushState(null, '', hash);
  renderBrains();
}
$$('.models-switch button').forEach(b => b.addEventListener('click', () => showModelsPane(b.dataset.pane)));

// One card per Brain, the best for the "Best for" model first. Brains you haven't used or checked go in a fold.
function renderBrains() {
  $('#brainCount').textContent = state.llms.length || '';
  if ($('#brainsPane').hidden) return;
  const pick = $('#brainTarget');
  const target = modelById(pick.value) ? pick.value : state.modelId;
  pick.innerHTML = state.models.map(m => `<option value="${esc(m.id)}">${m.kind === 'video' ? '🎬' : '📷'} ${esc(m.name)}</option>`).join('');
  pick.value = target || '';
  const model = modelById(pick.value);
  const inUse = selectedLlm()?.id;
  const q = $('#brainSearch').value.trim();
  $$('.brain-sort button').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === brainSort);
    b.setAttribute('aria-checked', String(b.dataset.sort === brainSort));
  });
  const order = {
    fit: (a, b) => (b.m.id === inUse) - (a.m.id === inUse) || b.fit.score - a.fit.score || (b.m.stats?.runs || 0) - (a.m.stats?.runs || 0) || byName(a.m, b.m),
    recent: (a, b) => byRecent(a.m, b.m),
    name: (a, b) => byName(a.m, b.m),
  }[brainSort] || (() => 0);
  $('#brainFilters').innerHTML = brainFilterControls(brainFilter);
  const ranked = state.llms
    .filter(brainFilterTest(brainFilter))
    .filter(m => brainMatch(m, q))
    .map(m => ({ m, fit: brainFit(m, model) }))
    .sort(order);
  // Ranked by fit, Brains with no record yet wait in a fold; searching or sorting another way shows them all.
  const fresh = brainSort === 'fit' && !q && !isFiltered(brainFilter) ? ranked.filter(x => isNewBrain(x.m) && x.m.id !== inUse) : [];
  $('#brainList').innerHTML = ranked.filter(x => !fresh.includes(x)).map(x => brainCard(x.m, x.fit, model, inUse, q)).join('');
  $('#brainListNew').innerHTML = fresh.map(x => brainCard(x.m, x.fit, model, inUse)).join('');
  $('#brainsNew').hidden = !fresh.length;
  $('#brainsNew > summary').textContent = `${fresh.length} Brain${fresh.length > 1 ? 's' : ''} you haven't used or checked yet`;
  const empty = $('#brainsEmpty');
  empty.hidden = ranked.length > 0;
  empty.textContent = (q || isFiltered(brainFilter)) && state.llms.length ? `No Brain matches${q ? ` "${q}"` : ''}${isFiltered(brainFilter) ? ` ${brainFilterLabel(brainFilter)}` : ''}.`
    : state.llmOk === false ? 'LM Studio is not reachable, so there are no Brains to show. Start its server (see the banner at the top).'
    : 'No models in LM Studio yet. Download one there and it shows up here.';
}

$('#brainSearch').addEventListener('input', renderBrains);
wireBrainFilter($('#brainFilters'), brainFilter, 'brainFilters', renderBrains);
$$('.brain-sort button').forEach(b => b.addEventListener('click', () => {
  brainSort = b.dataset.sort;
  saved.set('brainSort', brainSort);
  renderBrains();
}));

function brainCard(m, fit, model, inUse, q = '') {
  const s = m.stats || {};
  const speed = brainSpeed(m);
  const fails = [s.room && `ran out of room ${s.room}×`, s.empty && `empty ${s.empty}×`, s.refused && `refused ${s.refused}×`].filter(Boolean).join(' · ');
  const size = [m.params, m.quant, m.sizeBytes && `${(m.sizeBytes / 1e9).toFixed(1)} GB`].filter(Boolean).join(' · ');
  const record = kind => {
    const r = m.record?.[kind];
    return r?.takes ? `${r.takes} take${r.takes > 1 ? 's' : ''} · ${r.rendered} rendered${r.fav ? ` · ⭐ ${r.fav}` : ''}` : '<span class="muted">none yet</span>';
  };
  const checking = state.brainCheck?.id === m.id;
  const note = thinkNote(m);
  return `<li class="brain${m.id === inUse ? ' current' : ''}" data-id="${esc(m.id)}">
    <div class="brain-head">
      <span class="brain-name">${highlight(m.name, q)}</span>
      ${m.id === inUse ? '<span class="tag ok">in use</span>' : ''}
      ${m.cloud ? `<span class="tag cloud" title="Your prompts go to ${esc(m.cloud)}">☁️ ${esc(m.cloud)}</span>` : m.loaded ? '<span class="tag">loaded</span>' : ''}
      <span class="tag">${m.vision ? '👁 sees images' : m.vision === false ? 'text-only' : 'vision unknown'}</span>
      ${m.tools ? '<span class="tag" title="Trained for tool calling, which ✦ Ask uses">🛠 tools</span>' : ''}
      ${size ? `<span class="muted small">${esc(size)}</span>` : ''}
      ${lastUsedAt(m) ? `<span class="muted small">· used ${timeAgo(lastUsedAt(m))}</span>` : ''}
      <span class="brain-actions">
        ${m.id === inUse ? '' : '<button type="button" class="btn small" data-act="use">▶ Use</button>'}
        ${checking ? '<button type="button" class="btn small" data-act="stop">■ Stop</button>'
          : `<button type="button" class="btn small" data-act="check" title="Loads it in LM Studio (unloading the model there now), writes an image and a video prompt${m.vision !== false ? ' and looks at a test image' : ''}"${state.brainCheck ? ' disabled' : ''}>⚡ Quick check</button>`}
      </span>
    </div>
    ${fit.why ? `<p class="brain-fit${fit.proven ? '' : ' muted'}">${fit.proven ? `✓ Good for ${esc(model.name)}: ` : `For ${esc(model.name)}: `}${esc(fit.why)}</p>` : ''}
    <div class="brain-facts">
      <div><span class="k">Thinking</span>
        <select data-act="thinking" aria-label="Thinking for ${esc(m.name)}">
          <option value="">Settings default (${THINKING_LABELS[state.settings?.thinking || 'off']})</option>
          ${Object.entries(THINKING_LABELS).map(([v, l]) => `<option value="${v}"${v === m.thinking ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        ${note ? `<span class="muted small">It ${esc(note)}.</span>` : ''}
      </div>
      <div><span class="k">Speed</span>
        <span>${speed ? `about ${fmtSecs(speed.seconds)} per prompt <span class="muted">(${speed.from})</span>` : '<span class="muted">not measured yet</span>'}</span>
        ${fails ? `<span class="small warn-text">${esc(fails)}</span>` : ''}
      </div>
      <div><span class="k">📷 Image prompts</span><span>${record('image')}</span></div>
      <div><span class="k">🎬 Video prompts</span><span>${record('video')}</span></div>
      <div class="brain-check"><span class="k">Quick check</span>${checking ? `<span class="brain-status">⏳ ${esc(state.brainCheck.status)}</span>` : checkSummary(m.check)}</div>
    </div>
  </li>`;
}

function checkSummary(c) {
  if (!c) return '<span class="muted">not checked yet</span>';
  const part = (x, label) => {
    if (!x) return '';
    if (!x.ok) {
      const why = x.refused ? 'refused' : x.error ? 'failed' : x.answer ? `said "${x.answer.slice(0, 30)}"` : 'failed';
      return `<span class="warn-text" title="${esc(x.error || x.sample || x.answer || '')}">✗ ${label} (${esc(why)})</span>`;
    }
    const words = x.words ? `, ${x.words} words${x.inRange === false ? ` (asked ${x.target})` : ''}` : '';
    return `<span title="${esc(x.sample || x.answer || '')}">✓ ${label} ${fmtSecs(x.seconds)}${esc(words)}${x.tidy === false ? ', needed tidying' : ''}</span>`;
  };
  const parts = [part(c.image, 'image'), part(c.video, 'video'), part(c.vision, 'sees images')].filter(Boolean).join(' · ');
  return `<span>${parts}</span><span class="muted small">${timeAgo(c.at)}${c.loadSeconds ? ` · loaded in ${fmtSecs(c.loadSeconds)}` : ''}</span>`;
}

$('#brainsPane').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  const id = b?.closest('.brain')?.dataset.id;
  if (!id) return;
  if (b.dataset.act === 'use') setBrain(id);
  else if (b.dataset.act === 'check') quickCheck(id);
  else if (b.dataset.act === 'stop') stopQuickCheck();
});
$('#brainsPane').addEventListener('change', async e => {
  if (e.target.id === 'brainTarget') return renderBrains();
  const sel = e.target.closest('select[data-act="thinking"]');
  const m = llmById(sel?.closest('.brain')?.dataset.id);
  if (!m) return;
  try {
    Object.assign(m, await api('/api/brains', { method: 'PUT', body: { id: m.id, thinking: sel.value } }));
    renderBrains();
    updateLlmDot();
    toast(`🧠 ${m.name}: Thinking ${sel.value ? THINKING_LABELS[sel.value] : `follows Settings (${THINKING_LABELS[state.settings?.thinking || 'off']})`}`);
  } catch (err) {
    toast(err.message, true);
  }
});

// Quick check: a short test of one Brain (see /api/brains/check). One at a time, never during a run.
async function quickCheck(id) {
  const m = llmById(id);
  if (!m || state.brainCheck) return;
  if (state.busy || state.chainActive) return toast('Wait for the current run to finish, then check.', true);
  state.brainCheck = { id, status: m.loaded ? 'Starting…' : `Loading ${m.name}…`, runId: null, stopped: false };
  renderBrains();
  let done = null;
  let failed = null;
  try {
    await streamApi('/api/brains/check', { id }, ev => {
      if (ev.type === 'start') state.brainCheck.runId = ev.runId;
      else if (ev.type === 'status') {
        state.brainCheck.status = ev.text;
        const el = $(`.brain[data-id="${CSS.escape(id)}"] .brain-status`);
        if (el) el.textContent = `⏳ ${ev.text}`;
      } else if (ev.type === 'done') done = ev.check;
      else if (ev.type === 'error') failed = ev.message;
    });
  } catch (err) {
    failed = err.message;
  }
  const { stopped } = state.brainCheck;
  state.brainCheck = null;
  await loadLlms(); // the saved check, and LM Studio's new loaded model
  if (failed) toast(failed, true);
  else if (done) {
    const parts = [done.image, done.video, done.vision].filter(Boolean);
    toast(parts.every(x => x.ok) ? `⚡ ${m.name} passed the Quick check` : `⚡ ${m.name}: ${parts.filter(x => !x.ok).length} of ${parts.length} checks failed. See its card.`, !parts.every(x => x.ok));
  } else if (stopped) toast('Quick check stopped');
}

function stopQuickCheck() {
  if (!state.brainCheck?.runId) return;
  state.brainCheck.stopped = true;
  api(`/api/runs/${state.brainCheck.runId}/cancel`, { method: 'POST' }).catch(() => {});
}

function renderModelList() {
  $('#modelList').innerHTML = state.models.map(m => `
    <li><button type="button" data-id="${esc(m.id)}" class="${m.id === state.editId ? 'active' : ''}" style="--m:${modelColor(m)}" aria-current="${m.id === state.editId}">
      <span class="mdot" aria-hidden="true"></span><span class="mname">${esc(m.name)}</span>${workflowsFor(m.id).length ? `<span class="wf-count" title="ComfyUI workflows">🎨 ${workflowsFor(m.id).length}</span>` : ''}<span title="${esc(m.kind)}" aria-label="${esc(m.kind)}">${kindIcon(m.kind)}</span>
    </button></li>`).join('');
}

const listFromInput = v => v.split(',').map(s => s.trim()).filter(Boolean);

function refreshDefaultSelects(defaults) {
  const d = defaults || { aspectRatio: $('#dAspect').value, resolution: $('#dRes').value, duration: $('#dDur').value };
  fillSelect($('#dAspect'), listFromInput($('#mAspects').value), d.aspectRatio);
  fillSelect($('#dRes'), listFromInput($('#mRes').value), d.resolution);
  fillSelect($('#dDur'), listFromInput($('#mDur').value), d.duration);
}

function addExample(text = '', list = '#examplesList') {
  const row = document.createElement('div');
  row.className = 'example';
  row.innerHTML = '<textarea rows="3" aria-label="Example prompt" placeholder="A complete example prompt in this model\'s ideal style"></textarea><button type="button" class="icon-btn" title="Remove example" aria-label="Remove example">✕</button>';
  const ta = $('textarea', row);
  ta.value = text;
  $('button', row).addEventListener('click', () => { row.remove(); markDirty(); });
  ta.addEventListener('input', () => autosize(ta));
  $(list).append(row);
  requestAnimationFrame(() => autosize(ta));
}

function setFormColor(color) {
  $('#modelForm').style.setProperty('--m', color);
}

function fillModelForm(m, isNew) {
  $('#modelFormTitle').textContent = isNew ? (m.name || 'New model') : m.name;
  $('#mName').value = m.name;
  $('#mId').textContent = m.id || slug(m.name) || '(set a name)';
  $('#mKind').value = m.kind;
  const color = modelColor(m.id || m.name ? m : { id: String(Math.random()) });
  $('#mColor').value = color;
  setFormColor(color);
  $('#mDesc').value = m.description;
  $('#mInstr').value = m.instructions;
  $('#examplesList').innerHTML = '';
  m.examples.forEach(x => addExample(x));
  $('#adultExamplesList').innerHTML = '';
  (m.adultExamples || []).forEach(x => addExample(x, '#adultExamplesList'));
  $('#adultExamplesCount').textContent = m.adultExamples?.length || 'none yet';
  $('#mAspects').value = m.aspectRatios.join(', ');
  $('#mRes').value = m.resolutions.join(', ');
  $('#mDur').value = m.durations.join(', ');
  $('#mMotion').checked = Boolean(m.motionVideo);
  modelExtras = { imageRoles: m.imageRoles, comfyTemplates: m.comfyTemplates };
  refreshDefaultSelects(m.defaults);
  $('#dLen').value = m.defaults.length;
  $('#dTemp').value = m.defaults.temperature;
  $('#lShort').value = m.lengthGuide.short;
  $('#lMed').value = m.lengthGuide.medium;
  $('#lLong').value = m.lengthGuide.long;
  $('#mSources').value = m.sources.join('\n');
  $('#mUpdated').textContent = m.updatedAt ? `Last updated ${m.updatedAt}` : '';
  $('#modelForm').classList.toggle('is-video', m.kind === 'video');
  for (const id of ['#deleteModelBtn', '#exportModelBtn', '#useModelBtn', '#dupModelBtn']) $(id).hidden = isNew;
  $('#resetModelBtn').hidden = isNew || !m.edited;
  $('#mOrigin').textContent = !isNew && m.builtin
    ? (m.edited ? '· your edited copy of a built-in playbook, saved in your data folder' : '· built-in playbook. Saving makes your own copy in your data folder')
    : '· saved in your data folder, never in the app\'s folder';
  $('#draftResultWrap').hidden = true;
  $('#draftStatus').textContent = '';
  formMessage('');
  setDirty(isNew && Boolean(m.name));
  refreshPanelSummaries();
}

// What the form doesn't show but a playbook keeps: its image roles and its ComfyUI templates.
let modelExtras = {};

function readModelForm() {
  const motionVideo = $('#mKind').value === 'video' && $('#mMotion').checked;
  // A character-animation model uses its image as the character; others keep whatever roles they had.
  const roles = modelExtras.imageRoles?.length ? modelExtras.imageRoles : null;
  return {
    ...(motionVideo ? { motionVideo, imageRoles: roles?.includes('character') ? roles : ['character'] } : roles && !roles.includes('character') ? { imageRoles: roles } : {}),
    ...(modelExtras.comfyTemplates?.length ? { comfyTemplates: modelExtras.comfyTemplates } : {}),
    id: state.editId || undefined,
    name: $('#mName').value.trim(),
    kind: $('#mKind').value,
    color: $('#mColor').value,
    description: $('#mDesc').value.trim(),
    instructions: $('#mInstr').value,
    examples: $$('#examplesList textarea').map(t => t.value.trim()).filter(Boolean),
    adultExamples: $$('#adultExamplesList textarea').map(t => t.value.trim()).filter(Boolean),
    aspectRatios: listFromInput($('#mAspects').value),
    resolutions: listFromInput($('#mRes').value),
    durations: listFromInput($('#mDur').value),
    defaults: {
      aspectRatio: $('#dAspect').value,
      resolution: $('#dRes').value,
      duration: $('#dDur').value,
      length: $('#dLen').value,
      temperature: Number($('#dTemp').value),
    },
    lengthGuide: { short: $('#lShort').value, medium: $('#lMed').value, long: $('#lLong').value },
    sources: $('#mSources').value.split('\n').map(s => s.trim()).filter(Boolean),
  };
}

function setDirty(d) {
  state.dirty = d;
  $('#dirtyFlag').hidden = !d;
}
function markDirty() { setDirty(true); }

function formMessage(msg) {
  const el = $('#modelFormMsg');
  el.textContent = msg || '';
  el.hidden = !msg;
}

let pendingSwitch = null;
function guardDirty(target, go) {
  if (state.dirty && pendingSwitch !== target) {
    pendingSwitch = target;
    formMessage('✋ You have unsaved changes. Click Save, or click again to throw them away.');
    return;
  }
  pendingSwitch = null;
  go();
}

function editModel(id) {
  const m = modelById(id);
  if (!m) return newModel();
  state.editId = m.id;
  renderModelList();
  fillModelForm(m, false);
  renderWorkflowList();
}

function newModel(template = NEW_MODEL) {
  state.editId = null;
  renderModelList();
  fillModelForm({ ...structuredClone(template), id: '' }, true);
  renderWorkflowList();
  $('#mName').focus();
}

$('#modelList').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]');
  if (b && b.dataset.id !== state.editId) guardDirty(b.dataset.id, () => { editModel(b.dataset.id); $(`#modelList button[data-id="${CSS.escape(b.dataset.id)}"]`)?.focus(); });
});
$('#newModelBtn').addEventListener('click', () => guardDirty('__new', () => newModel()));
$('#modelForm').addEventListener('input', e => {
  if (e.target.closest('#draftDocs, #draftResult')) return;
  markDirty();
  pendingSwitch = null;
  if (e.target.id === 'mName') {
    if (!state.editId) $('#mId').textContent = slug(e.target.value) || '(set a name)';
    $('#modelFormTitle').textContent = e.target.value || 'New model';
  }
  if (e.target.id === 'mColor') setFormColor(e.target.value);
  if (['mAspects', 'mRes', 'mDur'].includes(e.target.id)) refreshDefaultSelects();
});
$('#mKind').addEventListener('change', e => $('#modelForm').classList.toggle('is-video', e.target.value === 'video'));
$('#addExampleBtn').addEventListener('click', () => { addExample(); markDirty(); $$('#examplesList textarea').at(-1).focus(); });
// Settings → Adult content: straight to the current model's adult examples.
$('#sAdultExamples').addEventListener('click', () => {
  showView('models/models');
  if (!state.dirty && state.modelId) editModel(state.modelId);
  const box = $('.adult-examples');
  setPanel($('#modelForm'), false);
  setPanel(box, false);
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
$('#addAdultExampleBtn').addEventListener('click', () => { addExample('', '#adultExamplesList'); markDirty(); $$('#adultExamplesList textarea').at(-1).focus(); });

$('#modelForm').addEventListener('submit', async e => {
  e.preventDefault();
  const data = readModelForm();
  if (!data.name) { formMessage('Give the model a name first.'); $('#mName').focus(); return; }
  try {
    const savedModel = state.editId
      ? await api(`/api/models/${state.editId}`, { method: 'PUT', body: data })
      : await api('/api/models', { method: 'POST', body: data });
    await loadModels();
    state.editId = savedModel.id;
    renderModelList();
    fillModelForm(savedModel, false);
    renderWorkflowList();
    toast(`💾 Saved “${savedModel.name}”`);
  } catch (err) {
    formMessage(err.status === 409 ? `${err.message} Choose a different name.` : err.message);
  }
});

$('#deleteModelBtn').addEventListener('click', e => confirmClick(e.currentTarget, 'Click to delete', async () => {
  try {
    const name = $('#mName').value;
    await api(`/api/models/${state.editId}`, { method: 'DELETE' });
    setDirty(false);
    state.editId = null;
    await loadWorkflows();
    await loadModels();
    if (state.models.length) editModel(state.models[0].id); else newModel();
    toast(`🗑️ Deleted “${name}”`);
  } catch (err) {
    toast(err.message, true);
  }
}));

$('#resetModelBtn').addEventListener('click', e => confirmClick(e.currentTarget, 'Sure? Your edits go', async () => {
  try {
    const m = await api(`/api/models/${state.editId}/reset`, { method: 'POST' });
    setDirty(false);
    await loadModels();
    editModel(m.id);
    toast(`↺ “${m.name}” is back to the built-in playbook`);
  } catch (err) {
    toast(err.message, true);
  }
}));

// Built-in playbooks you deleted can come back.
async function refreshHiddenBuiltins() {
  const hidden = await api('/api/models/hidden').catch(() => []);
  const b = $('#restoreBuiltinsBtn');
  b.hidden = !hidden.length;
  b.textContent = hidden.length === 1 ? `↺ Bring back ${hidden[0].name}` : `↺ Bring back ${hidden.length} built-in models`;
  b.title = hidden.map(h => h.name).join(', ');
  b.dataset.ids = hidden.map(h => h.id).join(',');
}
$('#restoreBuiltinsBtn').addEventListener('click', async e => {
  const ids = e.currentTarget.dataset.ids.split(',').filter(Boolean);
  try {
    for (const id of ids) await api(`/api/models/${id}/reset`, { method: 'POST' });
    await loadModels();
    if (!state.dirty) editModel(ids[0]);
    toast(`↺ Brought back ${ids.length === 1 ? modelById(ids[0])?.name || 'the model' : `${ids.length} models`}`);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#dupModelBtn').addEventListener('click', () => {
  const copy = readModelForm();
  copy.name = `${copy.name} copy`;
  delete copy.id;
  newModel(copy);
});

// Exports carry the playbook only, not where it came from.
const portable = ({ builtin, edited, ...m }) => m;
$('#exportModelBtn').addEventListener('click', () => {
  const m = modelById(state.editId);
  if (m) { download(`${m.id}.json`, portable(m)); toast(`⤒ Exported ${m.id}.json`); }
});
$('#exportAllBtn').addEventListener('click', () => {
  download(`prompt-maker-models-${new Date().toISOString().slice(0, 10)}.json`, state.models.map(portable));
  toast(`⤒ Exported ${state.models.length} models`);
});
$('#useModelBtn').addEventListener('click', () => {
  if (state.dirty) return formMessage('Save your changes first so Create uses the latest instructions.');
  selectModel(state.editId);
  showView('create');
});

$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  let added = 0;
  let updated = 0;
  try {
    for (const f of files) {
      const parsed = JSON.parse(await f.text());
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        const exists = Boolean(modelById(slug(m.id || m.name)));
        await api('/api/models?overwrite=1', { method: 'POST', body: m });
        if (exists) updated++; else added++;
      }
    }
    toast(`⤓ Imported: ${added} new, ${updated} updated`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, true);
  }
  await loadModels();
  if (!state.dirty) editModel(state.editId || state.models[0]?.id);
});

// AI-assisted instructions from pasted documentation.
let draftController = null;
$('#draftBtn').addEventListener('click', async () => {
  const docs = $('#draftDocs').value.trim();
  if (!docs) { $('#draftDocs').focus(); return toast('Paste some documentation first.', true); }
  if (state.llmOk === false) return toast('🔌 LM Studio is not reachable.', true);
  const status = $('#draftStatus');
  const out = $('#draftResult');
  $('#draftResultWrap').hidden = false;
  out.value = '';
  draftController = new AbortController();
  $('#draftBtn').disabled = true;
  $('#draftUse').disabled = true;
  $('#draftAppend').disabled = true;
  $('#draftStop').hidden = false;
  status.textContent = 'Warming up…';
  let failed = null;
  try {
    await streamApi('/api/models/draft', { name: $('#mName').value || 'this model', kind: $('#mKind').value, docs }, ev => {
      if (ev.type === 'status') status.textContent = `⏳ ${ev.text}`;
      else if (ev.type === 'delta' || ev.type === 'done') {
        if (ev.text) {
          out.value = ev.text;
          out.scrollTop = out.scrollHeight;
        }
        status.textContent = ev.type === 'done' ? '✓ Done. Review it, then use it.' : ev.thinking && !ev.text ? '🧠 Thinking…' : '✍️ Writing…';
      } else if (ev.type === 'error') failed = ev.message;
    }, draftController.signal);
  } catch (err) {
    if (err.name !== 'AbortError') failed = friendly(err);
    else status.textContent = '■ Stopped.';
  }
  if (failed) status.textContent = `⚠️ ${failed}`;
  $('#draftBtn').disabled = false;
  $('#draftUse').disabled = !out.value.trim();
  $('#draftAppend').disabled = !out.value.trim();
  $('#draftStop').hidden = true;
  draftController = null;
});
$('#draftStop').addEventListener('click', () => draftController?.abort());
$('#draftUse').addEventListener('click', () => { $('#mInstr').value = $('#draftResult').value; markDirty(); toast('✨ Draft placed in Instructions. Remember to Save.'); });
$('#draftAppend').addEventListener('click', () => { $('#mInstr').value = `${$('#mInstr').value.trim()}\n\n${$('#draftResult').value}`; markDirty(); toast('✨ Draft appended. Remember to Save.'); });

window.addEventListener('beforeunload', e => {
  // (A render isn't a reason: it keeps going in the server, and the page picks it up again.)
  if (state.dirty || state.settingsDirty || state.busy || line.orders.length || state.cards.some(cardDirty)) e.preventDefault();
});

// ---------- settings ----------

function setSettingsDirty(d) {
  state.settingsDirty = d;
  $('#settingsDirty').hidden = !d;
}

// ---------- settings: cloud Brains ----------
// Providers you add with your own key. None ship with the app: it runs 100% offline until you add one.

async function loadProviders() {
  const res = await api('/api/providers').catch(() => null);
  if (res) {
    state.catalog = res.catalog;
    state.providers = res.providers;
    renderProviders();
  }
  return res;
}

function renderProviders() {
  const list = state.providers || [];
  $('#providerList').innerHTML = list.map(p => `<li class="svc" data-id="${esc(p.id)}">
      <span class="dot ${p.error ? 'bad' : 'ok'}"></span>
      <span class="svc-text"><b>☁️ ${esc(p.name)}</b><span class="svc-state">${p.error ? esc(p.error) : `${p.models ?? '…'} models`} · key ${esc(p.keyHint)}${p.trusted ? ' · doesn\'t ask before use' : ''}</span></span>
      <span class="svc-acts"><button type="button" class="btn small danger" data-act="remove">Remove</button></span>
    </li>`).join('');
  $('#cpReset').hidden = !list.some(p => p.trusted);
  const sel = $('#cpPreset');
  if (!sel.options.length && state.catalog) {
    sel.innerHTML = state.catalog.map(c => `<option value="${esc(c.preset)}">${esc(c.name)}</option>`).join('');
    showPreset();
  }
}

function showPreset() {
  const c = state.catalog?.find(x => x.preset === $('#cpPreset').value);
  const custom = c?.preset === 'custom';
  $('#cpUrlField').hidden = !custom;
  $('#cpNameField').hidden = !custom;
  $('#cpKeyLink').hidden = !c?.keyUrl;
  if (c?.keyUrl) $('#cpKeyLink').href = c.keyUrl;
}
$('#cpPreset').addEventListener('change', showPreset);

$('#cpAdd').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const added = await api('/api/providers', { method: 'POST', body: { preset: $('#cpPreset').value, baseUrl: $('#cpUrl').value, name: $('#cpName').value, key: $('#cpKey').value } });
    $('#cpKey').value = '';
    toast(`☁️ Added ${added.name}: ${added.models} models in the Brain menu`);
    await Promise.all([loadProviders(), loadLlms()]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '＋ Add';
  }
});

$('#providerList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act="remove"]');
  const id = btn?.closest('.svc')?.dataset.id;
  if (!id) return;
  confirmClick(btn, 'Click again to remove', async () => {
    await api(`/api/providers/${id}`, { method: 'DELETE' }).catch(err => toast(err.message, true));
    toast('☁️ Provider removed, and its key deleted');
    await Promise.all([loadProviders(), loadLlms()]);
  });
});

$('#cpReset').addEventListener('click', async () => {
  const res = await api('/api/providers/trust', { method: 'PUT', body: { id: null, trusted: false } }).catch(err => toast(err.message, true));
  if (!res) return;
  state.providers = res.providers;
  renderProviders();
  toast('☁️ Prompt Maker asks again before you switch to a cloud Brain');
});

// "Are you sure? This sends your prompts to …": before switching to a cloud Brain, unless you said don't ask again.
async function cloudConsent(m) {
  if (!state.providers) await loadProviders();
  const provider = state.providers?.find(p => p.id === m.providerId);
  if (provider?.trusted) return true;
  const dlg = $('#cloudDialog');
  for (const id of ['#cdProvider', '#cdProvider2', '#cdProvider3']) $(id).textContent = m.cloud;
  $('#cdModel').textContent = m.name;
  $('#cdTrust').checked = false;
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise(resolve => dlg.addEventListener('close', resolve, { once: true }));
  if (dlg.returnValue !== 'ok') return false;
  if ($('#cdTrust').checked && provider) {
    const res = await api('/api/providers/trust', { method: 'PUT', body: { id: provider.id, trusted: true } }).catch(() => null);
    if (res) state.providers = res.providers;
  }
  return true;
}

// ---------- settings: services ----------
// What's running (Prompt Maker, LM Studio, ComfyUI), with Start and Stop buttons, and starting with the computer.

// Starting with the computer, where the app can set that up (Linux for now). Also remembers whether the
// promptmaker:// link works here, for the offline banner's Start button.
async function loadAutostart() {
  const st = await api('/api/autostart').catch(() => null);
  if (!st) return;
  saved.set('launcher', Boolean(st.supported && st.launcher));
  renderAutostart(st);
}

function renderAutostart(st) {
  $('#startupOpts').hidden = !st.supported;
  $('#sAutostart').checked = st.autostart;
  $('#sAutostartHint').textContent = st.autostart
    ? 'It starts when you log in, turns on LM Studio\'s server, and comes back on its own if it ever stops. It\'s also in your app menu.'
    : 'Off: start it from your app menu when you need it. If the page ever says the server isn\'t running, its Start button brings it back.';
}

$('#sAutostart').addEventListener('change', async e => {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    const st = await api('/api/autostart', { method: 'PUT', body: { enabled: on } });
    saved.set('launcher', Boolean(st.launcher));
    renderAutostart(st);
    toast(st.autostart ? '🚀 Prompt Maker starts with your computer' : "🚀 Prompt Maker won't start with your computer");
  } catch (err) {
    e.target.checked = !on;
    toast(err.message, true);
  } finally {
    e.target.disabled = false;
  }
});

$('#sComfyAutostart').addEventListener('change', async e => {
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: { comfyAutostart: e.target.checked } });
    toast(e.target.checked ? '🎨 ComfyUI starts along with Prompt Maker' : "🎨 ComfyUI won't start on its own");
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});

let servicesPoll = null;
async function loadServices() {
  const st = await api('/api/services').catch(() => null);
  if (st) renderServices(st);
  return st;
}

function renderServices(st) {
  state.services = st;
  const row = (name, { dot, text, start, stop }) => {
    const el = $(`.svc[data-svc="${name}"]`);
    $('.dot', el).className = `dot ${dot}`;
    $('.svc-state', el).textContent = text;
    if (start !== undefined) $(`[data-act="${name}-start"]`, el).hidden = !start;
    if (stop !== undefined) $(`[data-act="${name}-stop"]`, el).hidden = !stop;
  };
  row('app', { dot: 'ok', text: st.app.service ? 'Running in the background' : 'Running' });
  const { lms, comfy } = st;
  row('lms', lms.running
    ? { dot: 'ok', text: `Running · ${lms.loaded ? `${lms.loaded} model${lms.loaded > 1 ? 's' : ''} loaded` : 'no model loaded'}`, start: false, stop: lms.local }
    : { dot: 'bad', text: lms.local ? 'Off' : 'Off (it runs on another computer)', start: lms.local, stop: false });
  const busy = $('.svc[data-svc="comfy"]').dataset.busy;
  row('comfy', comfy.running
    ? { dot: 'ok', text: `Running${comfy.gpu ? ` · ${comfy.gpu}` : ''}`, start: false, stop: comfy.local && !busy }
    : comfy.starting || busy === 'start'
      ? { dot: 'warn', text: 'Starting… (up to a minute)', start: false, stop: false }
      : { dot: 'bad', text: !comfy.local ? 'Off (it runs on another computer)' : comfy.launch ? 'Off' : "Off · not found on this computer: enter its folder under ComfyUI below", start: comfy.local && Boolean(comfy.launch), stop: false });
  const how = comfy.local && comfy.launch;
  $('#svcComfyHow').hidden = !how;
  if (how) {
    const from = { learned: 'the way you last ran it', found: 'with live previews on', set: 'with your settings below' }[comfy.launch.from] || '';
    $('#svcComfyHow').innerHTML = `ComfyUI starts from <code>${esc(comfy.launch.dir)}</code>${from ? `, ${from}` : ''}. <span class="muted" title="${esc(comfy.launch.command)}">ⓘ command</span>`;
  }
  $('#sComfyAutostart').checked = comfy.autostart;
  $('#sComfyAutostart').closest('label').hidden = !comfy.local || !comfy.launch;
  $('#sComfyFolder').placeholder = comfy.launch?.from && comfy.launch.from !== 'set' ? `found: ${comfy.launch.dir}` : 'found automatically';
  // Keep watching while ComfyUI is on its way up.
  clearTimeout(servicesPoll);
  if ((comfy.starting || busy === 'start') && isView('settings')) servicesPoll = setTimeout(loadServices, 2000);
}

// Starts ComfyUI, then watches until it answers (or gives up after three minutes).
async function startComfyUi() {
  const row = $('.svc[data-svc="comfy"]');
  row.dataset.busy = 'start';
  if (state.services) renderServices(state.services);
  try {
    await api('/api/services/comfy/start', { method: 'POST' });
    toast('🎨 Starting ComfyUI… (up to a minute)');
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await loadComfyStatus();
      if (st?.ok) {
        toast('🎨 ComfyUI is running');
        break;
      }
      if (i === 89) toast("ComfyUI didn't answer within three minutes. Check its window or log.", true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    delete row.dataset.busy;
    await loadServices();
  }
}

async function serviceAction(btn) {
  const act = btn.dataset.act;
  if (act === 'comfy-start') return startComfyUi();
  if (act === 'app-stop' || btn.id === 'stopAllBtn') {
    const all = btn.id === 'stopAllBtn';
    return confirmClick(btn, all ? 'Click again to stop everything' : 'Click again to stop', async () => {
      btn.disabled = true;
      await api(`/api/services/${all ? 'all' : 'app'}/stop`, { method: 'POST' }).catch(() => {});
      toast(all ? '■ Stopped everything. Start Prompt Maker again from your app menu.' : '■ Prompt Maker stopped. Start it again from your app menu, or the button above.');
      setTimeout(loadLlms, 1500); // shows the "isn't running" banner, with its Start button
      btn.disabled = false;
    });
  }
  const [what, action] = act.split('-');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = action === 'start' ? 'Starting…' : 'Stopping…';
  try {
    await api(`/api/services/${what}/${action}`, { method: 'POST' });
    toast({ 'lms-start': '🔌 LM Studio is on', 'lms-stop': '■ LM Studio is off, and its models are unloaded', 'comfy-stop': '■ ComfyUI is off' }[act]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    await Promise.all([loadServices(), loadLlms(), loadComfyStatus()]);
  }
}

$('#servicesCard').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act], #stopAllBtn');
  if (btn && !btn.disabled) serviceAction(btn);
});
// Create's "ComfyUI offline" has a Start link too.
$('#comfyState').addEventListener('click', e => {
  if (e.target.closest('.comfy-start')) startComfyUi();
});

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('#sUrl').value = s.lmStudioUrl;
  $('#sTopP').value = s.topP;
  $('#sMax').value = s.maxTokens;
  $('#sComfyUrl').value = s.comfyUrl || '';
  $('#sComfyResult').hidden = true;
  $('#sComfyCleanup').checked = Boolean(s.comfyCleanup);
  $('#sComfyDir').value = s.comfyOutputDir || '';
  $('#sComfyFolder').value = s.comfyDir || '';
  $('#sComfyArgs').value = s.comfyArgs || '';
  showOutputDir();
  $('#sThinking').value = s.thinking;
  $('#sMaster').value = s.masterPrompt;
  $('#sAdult').checked = Boolean(s.adultContent);
  $('#sAdultPrompt').value = s.adultPrompt || '';
  $('#sDataDir').textContent = s.dataDir ? `📁 Your data lives in ${s.dataDir}` : '';
  $('#sVersion').textContent = s.version ? `Prompt Maker ${s.version}` : '';
  $('#sTestResult').hidden = true;
  setSettingsDirty(false);
}

// The Start-up switch saves on its own, so it never makes the form unsaved.
const marksSettingsDirty = e => { if (!['sAutostart', 'sComfyAutostart'].includes(e.target.id) && !e.target.closest('#cloudCard')) setSettingsDirty(true); };
$('#settingsForm').addEventListener('input', marksSettingsDirty);
// Where ComfyUI's output folder is, as a hint in the field (it's usually found on its own).
function showOutputDir() {
  api('/api/comfy/output-dir').then(r => { $('#sComfyDir').placeholder = r.detected ? `found: ${r.detected}` : 'not found: enter it, or start ComfyUI on this computer'; }).catch(() => {});
}
$('#settingsForm').addEventListener('change', marksSettingsDirty);
$('#sTest').addEventListener('click', async () => {
  const out = $('#sTestResult');
  out.hidden = false;
  out.className = 'test-result';
  out.textContent = 'Testing…';
  const res = await api(`/api/llms?url=${encodeURIComponent($('#sUrl').value.trim())}`).catch(err => ({ ok: false, error: err.message }));
  out.className = `test-result ${res.ok ? 'ok' : 'bad'}`;
  out.textContent = res.ok
    ? `✓ Connected. ${res.models.length} models, ${res.models.filter(m => m.vision).length} with vision, ${res.models.filter(m => m.loaded).length} loaded right now.`
    : `✗ ${res.error}`;
});
$('#sResetMaster').addEventListener('click', () => {
  $('#sMaster').value = state.settings.defaultMasterPrompt;
  setSettingsDirty(true);
  toast('↺ Default restored. Click Save to keep it.');
});
$('#sResetAdult').addEventListener('click', () => {
  $('#sAdultPrompt').value = state.settings.defaultAdultPrompt;
  setSettingsDirty(true);
  toast('↺ Default restored. Click Save to keep it.');
});
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: { lmStudioUrl: $('#sUrl').value, comfyUrl: $('#sComfyUrl').value, comfyCleanup: $('#sComfyCleanup').checked, comfyOutputDir: $('#sComfyDir').value, comfyDir: $('#sComfyFolder').value, comfyArgs: $('#sComfyArgs').value, topP: $('#sTopP').value, maxTokens: $('#sMax').value, thinking: $('#sThinking').value, masterPrompt: $('#sMaster').value, adultPrompt: $('#sAdultPrompt').value, adultContent: $('#sAdult').checked },
    });
    renderSettings();
    toast('💾 Settings saved');
    loadLlms();
    loadComfyStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- ComfyUI: status & workflows ----------

const workflowsFor = modelId => state.workflows.filter(w => w.modelId === modelId);

// The workflow ▶ Render uses for a model: the one picked last, else the first. One choice per model,
// shared by the Create panel and every take's render bar.
function activeWorkflowId(modelId) {
  const flows = workflowsFor(modelId);
  const remembered = saved.get(`wf.${modelId}`, null);
  return flows.some(f => f.id === remembered) ? remembered : flows[0]?.id || null;
}

function pickWorkflow(modelId, id) {
  saved.set(`wf.${modelId}`, id);
  state.cards.forEach(c => {
    if (c.model?.id !== modelId || !c.rb) return;
    c.rb.workflowId = id;
    const sel = $('.rb-wf', c.el);
    if (sel) sel.value = id;
    updateSettingsLine(c);
  });
  if (modelId === state.modelId) renderWorkflowPicker();
}

async function loadWorkflows() {
  state.workflows = await api('/api/workflows').catch(() => []);
  state.workflowsLoaded = true;
  renderModelList();
  renderWorkflowPicker();
  renderChainEditor();
  if (isView('models')) renderWorkflowList();
  state.cards.forEach(c => { if (!c.interrupted && state.entry?.id) renderZone(c); });
  checkWorkflowUpdates();
}

// Prompt Maker renders from its own copy of each workflow. This notices when the ComfyUI original has been
// saved since, so you can pull the changes in (↻ Update) instead of rendering an old version.
let staleCheck = null;
function checkWorkflowUpdates() {
  const fromComfy = state.workflows.filter(w => w.source?.startsWith('comfyui:'));
  if (!fromComfy.length || !state.comfy?.ok) return Promise.resolve();
  staleCheck ??= api('/api/comfy/workflows').then(list => {
    const modified = new Map(list.map(f => [f.path, Number(f.modified) || 0]));
    const stale = new Set(fromComfy.filter(w => {
      const now = modified.get(w.source.slice('comfyui:'.length));
      return now && now > (w.sourceModified ?? Date.parse(w.createdAt)) + 1000;
    }).map(w => w.id));
    const changed = stale.size !== state.wfStale.size || [...stale].some(id => !state.wfStale.has(id));
    state.wfStale = stale;
    if (changed) {
      renderWorkflowPicker();
      state.cards.forEach(updateSettingsLine);
      if (isView('models')) renderWorkflowList();
    }
  }).catch(() => {}).finally(() => { staleCheck = null; });
  return staleCheck;
}
let lastStaleCheck = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastStaleCheck < 3000) return;
  lastStaleCheck = Date.now();
  checkWorkflowUpdates();
});

// Pulls in the new version (from ComfyUI, or from a file for uploaded workflows), keeping your setup.
async function updateWorkflow(id, { json = null, review = false } = {}) {
  let data;
  try {
    data = await api(`/api/workflows/${id}/refresh`, { method: 'POST', body: json ? { json } : {} });
  } catch (err) {
    if ($('#wfDialog').open) wfToast(err.message); else toast(err.message, true);
    return;
  }
  state.wfStale.delete(id);
  await loadWorkflows();
  const c = data.changes;
  const what = [c.changed && `${c.changed} node${c.changed > 1 ? 's' : ''} changed`, c.added && `${c.added} added`, c.removed && `${c.removed} removed`].filter(Boolean).join(', ');
  const needsCheck = data.lost.length > 0 || c.droppedTweaks > 0;
  if (needsCheck || review) {
    // Something you set up no longer fits (or you're in the dialog anyway): show the setup.
    openWorkflowDialog({ edit: data });
    const notes = [
      data.lost.length && `Couldn't keep where the ${data.lost.join(', ')} went (those inputs are gone), so new spots were picked. Check them below.`,
      c.droppedTweaks && `${c.droppedTweaks} sampler tweak${c.droppedTweaks > 1 ? 's were' : ' was'} dropped because ${c.droppedTweaks > 1 ? 'their inputs are' : 'its input is'} gone.`,
    ].filter(Boolean);
    const note = what ? `↻ Updated: ${what}. ${notes.join(' ') || 'Your setup was kept.'}` : `✓ Already up to date with ${data.source?.startsWith('comfyui:') ? 'ComfyUI' : 'that file'}.`;
    $('#wfWarnings').insertAdjacentHTML('afterbegin', `<p class="wf-warn wf-note${needsCheck ? '' : ' ok'}">${esc(note)}</p>`);
    toast(needsCheck ? `↻ “${data.name}” updated. Check its setup` : what ? `↻ “${data.name}” updated, your setup kept` : `✓ “${data.name}” is already up to date`);
  } else {
    toast(what ? `↻ “${data.name}” updated: ${what}. Your setup was kept` : `✓ “${data.name}” is already up to date`);
  }
}

async function editWorkflow(id, { focusSampler = false } = {}) {
  try {
    openWorkflowDialog({ edit: await api(`/api/workflows/${id}`), focusSampler });
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- create: step 5, seed ----------
// Like ComfyUI's "control after generate": 🎲 random, 🔒 fixed, ＋1 or −1 after each render. Saved on the
// workflow; the server hands seeds out, so renders started together never share one.

const SEED_MODES = [['random', '🎲 Random', 'A new random seed every render'], ['fixed', '🔒 Fixed', 'The same seed every render'], ['increment', '＋1', 'This seed, then one higher each render'], ['decrement', '−1', 'This seed, then one lower each render']];

function renderSeedRow() {
  const box = $('#wfpSeed');
  const flow = activeFlow();
  const s = flow?.seed;
  box.hidden = !s?.inputs;
  if (box.hidden) { box.innerHTML = ''; return; }
  const focus = document.activeElement?.closest?.('#wfpSeed') ? (document.activeElement.dataset.value ? `[data-value="${document.activeElement.dataset.value}"]` : document.activeElement.dataset.act ? `[data-act="${document.activeElement.dataset.act}"]` : '.seed-val') : null;
  const v = s.value;
  const hint = s.mode === 'random' ? (s.last != null ? 'Each render gets a new seed. Like one? Keep it.' : 'Each render gets a new random seed.')
    : s.mode === 'fixed' ? `Every render uses ${v}. (×2 renders use ${v} and ${v + 1}.)`
      : s.mode === 'increment' ? `Next render: ${v}, then ${v + 1}, ${v + 2}…`
        : `Next render: ${v}, then ${Math.max(0, v - 1)}, ${Math.max(0, v - 2)}…`;
  box.innerHTML = `
    <div class="seed-head">
      <span class="dn-label">🎲 Seed</span>
      <div class="seg seed-mode" role="radiogroup" aria-label="Seed for each render">${SEED_MODES.map(([m, label, title]) => `<button type="button" role="radio" data-value="${m}" title="${title}">${label}</button>`).join('')}</div>
    </div>
    ${s.mode === 'random'
      ? (s.last != null ? `<div class="seed-ctl"><span class="seed-last">Last seed: <b>${s.last}</b></span><button type="button" class="btn small" data-act="keep" title="Use ${s.last} for every render from now on">🔒 Keep it</button></div>` : '')
      : `<div class="seed-ctl"><input type="number" class="seed-val" min="0" step="1" value="${v}" aria-label="Seed"><button type="button" class="icon-btn" data-act="last" title="Use the last render's seed${s.last != null ? ` (${s.last})` : ''}" aria-label="Use the last render's seed"${s.last == null ? ' disabled' : ''}>↶</button><button type="button" class="icon-btn" data-act="roll" title="Roll a new random seed" aria-label="Roll a new random seed">🎲</button></div>`}
    <small class="dn-hint">${esc(hint)}</small>`;
  setActive($('.seed-mode', box), s.mode);
  if (focus) $(focus, box)?.focus();
}

// Changes a workflow's seed mode and/or next seed (shown at once, saved right after).
async function setSeed(flow, change) {
  const s = flow.seed;
  if (change.mode && change.mode !== 'random' && change.value == null && s.mode === 'random' && s.last != null) change.value = s.last;
  flow.seed = { ...s, ...change };
  renderSeedRow();
  state.cards.forEach(updateSeedChip);
  try {
    const updated = await api(`/api/workflows/${flow.id}`, { method: 'PUT', body: { seedPatch: change } });
    const i = state.workflows.findIndex(f => f.id === flow.id);
    if (i >= 0) state.workflows[i] = { ...state.workflows[i], ...updated };
    renderSeedRow();
    state.cards.forEach(updateSeedChip);
  } catch (err) {
    toast(`Couldn't save the seed: ${err.message}`, true);
  }
}

// After renders, the workflows' last / next seeds have moved on.
async function refreshSeeds() {
  const list = await api('/api/workflows').catch(() => null);
  if (!list) return;
  const box = document.activeElement?.classList?.contains('seed-val') ? document.activeElement : null;
  const typing = box && Number(box.value) !== activeFlow()?.seed?.value; // don't overwrite a number being typed
  const before = JSON.stringify(activeFlow()?.seed);
  for (const w of list) {
    const i = state.workflows.findIndex(f => f.id === w.id);
    if (i >= 0) state.workflows[i] = { ...state.workflows[i], seed: w.seed };
  }
  if (!typing && JSON.stringify(activeFlow()?.seed) !== before) renderSeedRow(); // only when it changed: no needless layout shifts
  state.cards.forEach(updateSeedChip);
}

$('#wfpSeed').addEventListener('click', e => {
  const b = e.target.closest('button');
  const flow = activeFlow();
  if (!b || !flow) return;
  if (b.dataset.value) setSeed(flow, { mode: b.dataset.value });
  else if (b.dataset.act === 'keep') setSeed(flow, { mode: 'fixed', value: flow.seed.last });
  else if (b.dataset.act === 'last' && flow.seed.last != null) setSeed(flow, { value: flow.seed.last });
  else if (b.dataset.act === 'roll') setSeed(flow, { value: Math.floor(Math.random() * 2 ** 32) });
});
$('#wfpSeed').addEventListener('change', e => {
  const flow = activeFlow();
  if (!flow || !e.target.classList.contains('seed-val')) return;
  const v = Math.max(0, Math.floor(Number(e.target.value)));
  if (Number.isSafeInteger(v)) setSeed(flow, { value: v });
});
$('#wfpSeed').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('seed-val')) { e.preventDefault(); e.target.dispatchEvent(new Event('change', { bubbles: true })); } // inside the Create form: not Generate
});

// ---------- create: step 5, denoise (image-to-image) ----------
// How much the render may change the input image: 0 keeps it, 1 ignores it. Shown when the picked workflow
// takes an image and has a denoise setting; saved on the workflow like its other sampler settings.

function renderDenoise() {
  const box = $('#wfpDenoise');
  const flow = activeFlow();
  const params = flow?.maps.image ? flow.denoise || [] : [];
  box.hidden = !params.length;
  if (!params.length) { box.innerHTML = ''; return; }
  const focus = document.activeElement?.closest?.('#wfpDenoise [data-key]')?.dataset.key;
  box.innerHTML = params.map(p => `
    <div class="dn-row" data-key="${esc(p.key)}">
      <span class="dn-label">🎚️ Denoise${params.length > 1 ? ` <small>${esc(p.title)}</small>` : ''}</span>
      <input type="range" class="dn-range" min="0" max="1" step="0.01" value="${Number(p.value)}" aria-label="Denoise${params.length > 1 ? `, ${esc(p.title)}` : ''}: how much the render may change your image">
      <output class="dn-val">${Number(p.value).toFixed(2)}</output>
      ${Number(p.value) !== Number(p.original) ? `<button type="button" class="icon-btn dn-reset" title="Back to the workflow's ${Number(p.original).toFixed(2)}" aria-label="Reset denoise">↺</button>` : '<span></span>'}
      <small class="dn-hint">${Number(p.value) < 0.35 ? 'stays close to your image' : Number(p.value) < 0.7 ? 'keeps the layout, changes the details' : 'changes a lot'}</small>
    </div>`).join('');
  if (focus) $(`[data-key="${CSS.escape(focus)}"] .dn-range`, box)?.focus();
}

let denoiseTimer;
function saveDenoise(flow, key, value) {
  const p = flow.denoise.find(x => x.key === key);
  p.value = value;
  clearTimeout(denoiseTimer);
  denoiseTimer = setTimeout(async () => {
    try {
      const updated = await api(`/api/workflows/${flow.id}`, { method: 'PUT', body: { overridePatch: { [key]: value === p.original ? null : value } } });
      const i = state.workflows.findIndex(f => f.id === flow.id);
      if (i >= 0) state.workflows[i] = { ...state.workflows[i], ...updated };
      $('#wfpSettings').innerHTML = settingsHtml(activeFlow());
      state.cards.forEach(updateSettingsLine);
    } catch (err) {
      toast(`Couldn't save denoise: ${err.message}`, true);
    }
  }, 300);
}

$('#wfpDenoise').addEventListener('input', e => {
  if (!e.target.classList.contains('dn-range')) return;
  const row = e.target.closest('[data-key]');
  const flow = activeFlow();
  const v = Math.round(Number(e.target.value) * 100) / 100;
  $('.dn-val', row).textContent = v.toFixed(2);
  if (flow) saveDenoise(flow, row.dataset.key, v);
});
$('#wfpDenoise').addEventListener('change', e => { if (e.target.classList.contains('dn-range')) renderDenoise(); });
$('#wfpDenoise').addEventListener('click', e => {
  const b = e.target.closest('.dn-reset');
  const flow = activeFlow();
  if (!b || !flow) return;
  const key = b.closest('[data-key]').dataset.key;
  saveDenoise(flow, key, flow.denoise.find(x => x.key === key).original);
  renderDenoise();
});

// ---------- create: step 5, LoRAs ----------
// A workflow's LoRAs: its own (switch off or re-weight them) plus ones you add from the model's LoRA folder.
// Saved on the workflow in your data folder; renders record what they used.

const loraShort = name => String(name).split('/').pop().replace(/\.(safetensors|pt|pth|ckpt|bin)$/i, '');
const loraFolderOf = name => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const activeFlow = () => state.workflows.find(f => f.id === $('#wfpSelect').value && f.modelId === state.modelId) || null;

function flowLoras(flow) {
  const l = flow?.loras || { nodes: [], tweaks: {}, added: [] };
  const own = l.nodes.map(n => ({ ...n, ...(l.tweaks[n.key] || {}), own: true, edited: Boolean(l.tweaks[n.key]), original: n }));
  return { own, added: l.added };
}
const loraCount = flow => { const { own, added } = flowLoras(flow); return own.filter(x => x.on).length + added.filter(x => x.on).length; };

// The model's LoRA folder: the one you chose, else the folder whose name matches the model ("krea2" for
// Krea 2 RAW, "LTX_2.3" for LTX 2.3), else all of them ("").
function loraFolderFor(m) {
  const folders = [...new Set((state.loraList || []).map(loraFolderOf).filter(Boolean))];
  const chosen = state.settings?.loraFolders?.[m.id];
  if (chosen !== undefined && (chosen === '' || folders.includes(chosen))) return { folder: chosen, folders, auto: false };
  const keys = [squash(m.id), squash(m.name)];
  const hit = folders.find(f => { const n = squash(f.split('/').pop()); return n.length > 1 && keys.some(k => k === n || k.startsWith(n) || n.startsWith(k)); });
  return { folder: hit ?? '', folders, auto: true };
}

async function loadLoraList() {
  const res = await api('/api/comfy/loras').catch(err => ({ loras: [], error: err.message }));
  state.loraList = res.loras;
  state.loraError = res.loras.length ? '' : res.error || '';
  if (state.loraPicker.open) renderLoraPicker();
}

function renderLoraPanel() {
  const box = $('#wfpLoras');
  const flow = activeFlow();
  if (!flow) { box.innerHTML = ''; return; }
  const { own, added } = flowLoras(flow);
  const focus = document.activeElement?.closest?.('#wfpLoras') ? { key: document.activeElement.closest('[data-key]')?.dataset.key, cls: [...document.activeElement.classList].find(c => c.startsWith('lr-')) || document.activeElement.dataset.act } : null;
  const row = (l, key) => `
    <li class="lora-row${l.on ? '' : ' off'}" data-key="${esc(key)}">
      <label class="switch mini" title="${l.on ? 'On' : 'Off'}"><input type="checkbox" class="lr-on"${l.on ? ' checked' : ''} aria-label="Use ${esc(loraShort(l.name))}"><span class="track" aria-hidden="true"></span></label>
      <span class="lr-name" title="${esc(l.name)}${l.pieces > 1 ? ` · loaded by each of the workflow's ${l.pieces} pieces: this sets them all` : ''}">${esc(loraShort(l.name))}${l.own ? `<small>in workflow${l.pieces > 1 ? ` · ×${l.pieces} pieces` : ''}</small>` : ''}</span>
      ${l.own ? (l.edited ? `<button type="button" class="icon-btn lr-reset" data-act="lora-reset" title="Back to the workflow's ${l.original.on ? Number(l.original.strength).toFixed(2) : 'off'}" aria-label="Reset ${esc(loraShort(l.name))}">↺</button>` : '<span></span>') : `<button type="button" class="icon-btn" data-act="lora-remove" aria-label="Remove ${esc(loraShort(l.name))}" title="Remove">✕</button>`}
      <input type="range" class="lr-range" min="-2" max="2" step="0.05" value="${Math.max(-2, Math.min(2, l.strength))}" aria-label="Strength of ${esc(loraShort(l.name))}"${l.on ? '' : ' disabled'}>
      <input type="number" class="lr-num" min="-5" max="5" step="0.05" value="${Number(l.strength).toFixed(2)}" aria-label="Strength of ${esc(loraShort(l.name))}, exact"${l.on ? '' : ' disabled'}>
    </li>`;
  box.innerHTML = `
    <div class="lora-head">
      <span class="lora-label">🧬 LoRAs</span>
      <span class="muted small">${own.length || added.length ? `${loraCount(flow)} on` : 'none yet'}</span>
      <button type="button" class="chip-btn" data-act="lora-add" aria-expanded="${state.loraPicker.open}">＋ Add LoRA</button>
    </div>
    ${own.length || added.length ? `<ul class="lora-list">${own.map(l => row(l, l.key)).join('')}${added.map((l, i) => row(l, `+${i}`)).join('')}</ul>` : ''}
    <div class="lora-pick"${state.loraPicker.open ? '' : ' hidden'}></div>`;
  if (state.loraPicker.open) renderLoraPicker();
  if (focus?.key) $(`[data-key="${CSS.escape(focus.key)}"] .${focus.cls}, [data-key="${CSS.escape(focus.key)}"] [data-act="${focus.cls}"]`, box)?.focus();
  else if (focus?.cls === 'lora-add') $('[data-act="lora-add"]', box)?.focus();
}

function renderLoraPicker() {
  const pick = $('#wfpLoras .lora-pick');
  const flow = activeFlow();
  const m = currentModel();
  if (!pick || !flow || !m) return;
  if (!state.loraList) {
    pick.innerHTML = '<p class="muted small">Asking ComfyUI for your LoRAs…</p>';
    return;
  }
  const { folder, folders, auto } = loraFolderFor(m);
  const { own, added } = flowLoras(flow);
  const taken = new Set([...own, ...added].map(l => l.name));
  const q = state.loraPicker.q.trim().toLowerCase();
  const items = state.loraList.filter(n => (!folder || loraFolderOf(n) === folder) && !taken.has(n) && (!q || n.toLowerCase().includes(q)));
  const hadFocus = document.activeElement?.classList.contains('lp-search');
  pick.innerHTML = `
    <div class="lp-head">
      <input type="search" class="lp-search" placeholder="Search ${folder ? `${esc(folder)}/` : 'all LoRAs'}…" aria-label="Search LoRAs" value="${esc(state.loraPicker.q)}">
      <select class="lp-folder" aria-label="LoRA folder for ${esc(m.name)}" title="Which folder holds ${esc(m.name)}'s LoRAs">
        <option value="">All folders</option>
        ${folders.map(f => `<option value="${esc(f)}"${f === folder ? ' selected' : ''}>📁 ${esc(f)}</option>`).join('')}
      </select>
    </div>
    ${!folder && auto && folders.length ? `<p class="muted small">No folder matched ${esc(m.name)}, so these are all your LoRAs. Pick its folder above.</p>` : ''}
    <ul class="lp-list">${items.length
      ? items.map(n => `<li><button type="button" data-lora="${esc(n)}" title="${esc(n)}"><span>${esc(loraShort(n))}</span>${folder ? '' : `<small>${esc(loraFolderOf(n))}</small>`}</button></li>`).join('')
      : `<li class="lp-empty">${state.loraError ? `🔌 ${esc(state.loraError)}` : q ? 'No matches.' : `No more LoRAs in ${folder ? `${esc(folder)}/` : 'ComfyUI'}.`}</li>`}</ul>`;
  if (hadFocus) { const s = $('.lp-search', pick); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// Saves the active workflow's LoRA choices (debounced for slider drags, one save at a time).
let loraSaveTimer;
let loraSaving = Promise.resolve();
function saveLoras(flow, { now = false } = {}) {
  clearTimeout(loraSaveTimer);
  const save = async () => {
    try {
      const updated = await api(`/api/workflows/${flow.id}`, { method: 'PUT', body: { loras: { tweaks: flow.loras.tweaks, added: flow.loras.added } } });
      const i = state.workflows.findIndex(f => f.id === flow.id);
      if (i >= 0) state.workflows[i] = { ...state.workflows[i], ...updated };
      $('#wfpSettings').innerHTML = settingsHtml(activeFlow());
      state.cards.forEach(updateSettingsLine);
    } catch (err) {
      toast(`Couldn't save the LoRAs: ${err.message}`, true);
    }
  };
  const run = () => { loraSaving = loraSaving.then(save); };
  if (now) run(); else loraSaveTimer = setTimeout(run, 350);
}

function setLora(key, change) {
  const flow = activeFlow();
  if (!flow) return;
  const l = flow.loras;
  if (key.startsWith('+')) Object.assign(l.added[Number(key.slice(1))], change);
  else {
    const node = l.nodes.find(n => n.key === key);
    const next = { on: node.on, strength: node.strength, ...l.tweaks[key], ...change };
    if (next.on === node.on && next.strength === node.strength) delete l.tweaks[key]; else l.tweaks[key] = next;
  }
  return flow;
}

const strengthOf = v => Math.round(Math.min(5, Math.max(-5, Number(v) || 0)) * 100) / 100;
$('#wfpLoras').addEventListener('input', e => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (e.target.classList.contains('lp-search')) { state.loraPicker.q = e.target.value; return renderLoraPicker(); }
  if (!key || !e.target.classList.contains('lr-range')) return;
  e.target.closest('li').querySelector('.lr-num').value = Number(e.target.value).toFixed(2);
  saveLoras(setLora(key, { strength: strengthOf(e.target.value) }));
});
$('#wfpLoras').addEventListener('change', async e => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (e.target.classList.contains('lp-folder')) {
    const m = currentModel();
    state.settings.loraFolders = { ...state.settings.loraFolders, [m.id]: e.target.value };
    api('/api/settings', { method: 'PUT', body: { loraFolders: { [m.id]: e.target.value } } }).catch(err => toast(err.message, true));
    return renderLoraPicker();
  }
  if (!key) return;
  if (e.target.classList.contains('lr-on')) {
    saveLoras(setLora(key, { on: e.target.checked }), { now: true });
    renderLoraPanel();
  } else if (e.target.classList.contains('lr-num')) {
    const v = strengthOf(e.target.value);
    saveLoras(setLora(key, { strength: v }), { now: true });
    renderLoraPanel();
  } else if (e.target.classList.contains('lr-range')) {
    renderLoraPanel(); // shows ↺ once a workflow LoRA differs from the workflow
  }
});
$('#wfpLoras').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const flow = activeFlow();
  if (!flow) return;
  const key = b.closest('[data-key]')?.dataset.key;
  if (b.dataset.act === 'lora-add') {
    state.loraPicker.open = !state.loraPicker.open;
    renderLoraPanel();
    if (state.loraPicker.open) {
      if (!state.loraList || state.loraError) loadLoraList();
      $('#wfpLoras .lp-search')?.focus();
    }
  } else if (b.dataset.lora) {
    flow.loras.added.push({ name: b.dataset.lora, strength: 1, on: true });
    state.loraPicker = { open: false, q: '' };
    saveLoras(flow, { now: true });
    renderLoraPanel();
    $(`#wfpLoras [data-key="+${flow.loras.added.length - 1}"] .lr-range`)?.focus();
    announce(`Added ${loraShort(b.dataset.lora)} at strength 1`);
  } else if (b.dataset.act === 'lora-remove' && key) {
    flow.loras.added.splice(Number(key.slice(1)), 1);
    saveLoras(flow, { now: true });
    renderLoraPanel();
  } else if (b.dataset.act === 'lora-reset' && key) {
    delete flow.loras.tweaks[key];
    saveLoras(flow, { now: true });
    renderLoraPanel();
  }
});
$('#wfpLoras').addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.loraPicker.open) { e.preventDefault(); state.loraPicker = { open: false, q: '' }; renderLoraPanel(); $('#wfpLoras [data-act="lora-add"]')?.focus(); }
  if (e.key === 'Enter' && e.target.matches('.lp-search, .lr-num')) {
    e.preventDefault(); // inside the Create form: Enter must not generate
    if (e.target.matches('.lp-search')) $('#wfpLoras .lp-list button')?.click();
    else e.target.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

// ---------- create: step 5, the workflow picker ----------

const autoRenderKey = modelId => `autoRender.${modelId}`;

function renderWorkflowPicker() {
  const m = currentModel();
  const flows = m ? workflowsFor(m.id) : [];
  $('#wfpEmpty').hidden = !m || !state.workflowsLoaded || flows.length > 0;
  $('#wfpBox').hidden = !flows.length;
  $('#wfpKind').textContent = m?.kind === 'video' ? 'videos' : 'images';
  if (flows.length) {
    const id = activeWorkflowId(m.id);
    const sel = $('#wfpSelect');
    sel.innerHTML = flows.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    sel.value = id;
    sel.title = flows.find(f => f.id === id)?.name || '';
    $('#wfpSettings').innerHTML = settingsHtml(flows.find(f => f.id === id));
    renderSeedRow();
    renderDenoise();
    renderLoraPanel();
    $('#wfpAuto').checked = saved.get(autoRenderKey(m.id), false);
  }
  renderBatch();
  renderWorkflowWarning();
  renderStaleNotice();
  renderModelNotice();
  if (flows.length) checkWorkflowModels(activeWorkflowId(m.id));
  renderComfyState();
}

// The picked workflow and the image have to fit: a first frame needs an image input, and vice versa.
function renderWorkflowWarning() {
  const warn = $('#wfpWarn');
  const flow = state.workflows.find(f => f.id === $('#wfpSelect').value && f.modelId === state.modelId);
  const msg = !flow || $('#wfpBox').hidden ? ''
    : animating() && !flow.maps.image ? `“${flow.name}” has no image input, so it would ignore your first frame. Pick or add an image-to-video workflow.`
      : !state.image && flow.maps.image ? `“${flow.name}” needs ${currentModel()?.motionVideo ? 'your character image' : 'an input image'}. Add one in step 3, or pick another workflow.`
        : !state.video && flow.maps.video ? `“${flow.name}” needs a motion video. Add one in step 3.`
          : state.video && currentModel()?.motionVideo && !flow.maps.video ? `“${flow.name}” has no Load Video node, so it would ignore your motion video. Pick or add a Wan Animate 2 workflow.`
            : clipNote(flow);
  warn.hidden = !msg;
  warn.textContent = msg ? `⚠️ ${msg}` : '';
}

// A motion video longer than what the picked workflow animates: say how much of it the clip will be.
function clipNote(flow) {
  const v = state.video;
  const f = flow.motionFrames;
  if (!currentModel()?.motionVideo || !v?.seconds || !v.fps || typeof f !== 'number' || f >= Math.round(v.seconds * v.fps) - 1) return '';
  const all = workflowsFor(state.modelId).find(w => w.motionFrames === 'all');
  return `“${flow.name}” animates ${f} frames: the first ${secsLabel(f / v.fps)} of your ${secsLabel(v.seconds)} motion video. ${all ? `For all of it, pick “${all.name}”. To pick which part, use` : 'To pick which part, use'} ✂️ Trim in step ③.`;
}

function renderStaleNotice() {
  const box = $('#wfpStale');
  const flow = state.workflows.find(f => f.id === $('#wfpSelect').value && f.modelId === state.modelId);
  box.hidden = !flow || $('#wfpBox').hidden || !state.wfStale.has(flow.id);
  if (!box.hidden) $('span', box).textContent = `“${flow.name}” was changed in ComfyUI. This copy is older.`;
}
$('#wfpStale button').addEventListener('click', () => updateWorkflow($('#wfpSelect').value));

// ---------- create: step 5, model files the workflow needs ----------
// A workflow can load a model file ComfyUI doesn't have (a CLIP vision model, say): ComfyUI then refuses it. Step 5
// says which, and downloads it into ComfyUI's models folder (from the link the workflow carries) with one click.

const checkedModels = new Map(); // workflow id → when ComfyUI was last asked
function checkWorkflowModels(id, { fresh = false } = {}) {
  if (!id || !state.comfy?.ok || (!fresh && Date.now() - (checkedModels.get(id) || 0) < 60_000)) return;
  checkedModels.set(id, Date.now());
  api(`/api/workflows/${encodeURIComponent(id)}/models${fresh ? '?fresh=1' : ''}`)
    .then(r => { if (r.checked) noteMissingModels(id, r.missing); })
    .catch(() => checkedModels.delete(id));
}

function noteMissingModels(id, missing) {
  state.wfMissing.set(id, missing || []);
  renderModelNotice();
}

const sizeLabel = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const downloadFor = m => state.downloads.find(d => d.file === m.file && d.folder === m.folder);

function renderModelNotice() {
  const box = $('#wfpModels');
  const flow = state.workflows.find(f => f.id === $('#wfpSelect').value && f.modelId === state.modelId);
  const missing = flow && !$('#wfpBox').hidden ? state.wfMissing.get(flow.id) || [] : [];
  box.hidden = !missing.length;
  if (!missing.length) return box.replaceChildren();
  const row = m => {
    const d = downloadFor(m);
    const where = `<span class="mm-where">→ ComfyUI/models/${esc(m.folder || '…')}</span>`;
    let act;
    if (d?.state === 'running') act = `<span class="mm-prog"><span class="mm-bar" style="width:${d.total ? Math.round((d.received / d.total) * 100) : 0}%"></span></span><span class="mm-pct">${d.total ? `${Math.round((d.received / d.total) * 100)}% of ${sizeLabel(d.total)}` : 'Starting…'}</span><button type="button" class="icon-btn" data-act="mm-cancel" data-id="${esc(d.id)}" aria-label="Stop downloading ${esc(m.file)}">✕</button>`;
    else if (d?.state === 'done') act = '<span class="mm-ok">✓ Downloaded</span>';
    else if (m.download) act = `${d?.state === 'error' ? `<span class="mm-err">${esc(d.error)}</span>` : ''}<button type="button" class="btn small primary" data-act="mm-get" data-file="${esc(m.file)}">${d?.state === 'error' ? '↻ Try again' : '⬇ Download'}</button>`;
    else if (/^https?:\/\//.test(m.url || '')) act = `<span class="mm-none">Get it from <a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(m.url).hostname)}</a> (the workflow's link) and put it in that folder.</span>`;
    else act = '<span class="mm-none">No download link in the workflow: get it where the workflow came from.</span>';
    return `<li><code title="${esc(m.name)}">${esc(m.file)}</code>${where}<span class="mm-act">${act}</span></li>`;
  };
  const many = missing.filter(m => m.download && downloadFor(m)?.state !== 'running' && downloadFor(m)?.state !== 'done').length > 1;
  box.innerHTML = `<p>⚠️ Your ComfyUI doesn't have ${missing.length === 1 ? 'a model file' : `${missing.length} model files`} “${esc(flow.name)}” needs, so ComfyUI would refuse it:</p>
    <ul>${missing.map(row).join('')}</ul>
    ${missing.some(m => m.download) ? `<p class="hint">Downloads come from Hugging Face (the link in the workflow) and go straight into ComfyUI's models folder.${many ? ' <button type="button" class="btn small" data-act="mm-all">⬇ Download all</button>' : ''}</p>` : ''}`;
}

async function downloadModels(list) {
  for (const m of list) {
    try {
      const d = await api('/api/comfy/downloads', { method: 'POST', body: { name: m.name, folder: m.folder, url: m.url } });
      state.downloads = [...state.downloads.filter(x => x.id !== d.id), d];
    } catch (err) {
      toast(`Couldn't download ${m.file}: ${err.message}`, true);
    }
  }
  renderModelNotice();
  pollDownloads();
}

$('#wfpModels').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const missing = state.wfMissing.get($('#wfpSelect').value) || [];
  if (b.dataset.act === 'mm-get') downloadModels(missing.filter(m => m.file === b.dataset.file));
  else if (b.dataset.act === 'mm-all') downloadModels(missing.filter(m => m.download && !['running', 'done'].includes(downloadFor(m)?.state)));
  else if (b.dataset.act === 'mm-cancel') api(`/api/comfy/downloads/${b.dataset.id}/cancel`, { method: 'POST' }).then(pollDownloads, () => {});
});

// Follows the downloads (they run in Prompt Maker's server, so they go on through a reload) until they're done.
let downloadTimer = 0;
async function pollDownloads() {
  clearTimeout(downloadTimer);
  const list = await api('/api/comfy/downloads').catch(() => null);
  if (!list) return;
  const wasRunning = d => state.downloads.some(o => o.id === d.id && o.state === 'running');
  const finished = list.filter(d => d.state === 'done' && wasRunning(d));
  const failed = list.filter(d => d.state === 'error' && wasRunning(d) && d.error !== 'Cancelled');
  state.downloads = list;
  if (finished.length) {
    toast(`✓ ${finished.map(d => d.file).join(', ')} ${finished.length > 1 ? 'are' : 'is'} in ComfyUI now`);
    announce(`Downloaded ${finished.map(d => d.file).join(', ')}.`);
    for (const id of state.wfMissing.keys()) checkWorkflowModels(id, { fresh: true });
  }
  for (const d of failed) toast(`Download of ${d.file} failed: ${d.error}`, true);
  renderModelNotice();
  if (list.some(d => d.state === 'running')) downloadTimer = setTimeout(pollDownloads, 1000);
}

function renderComfyState() {
  const el = $('#comfyState');
  const c = state.comfy;
  el.hidden = !c || !workflowsFor(state.modelId).length;
  if (el.hidden) return;
  const startable = !c.ok && state.services?.comfy?.local !== false;
  el.innerHTML = `<span class="dot ${c.ok ? 'ok' : 'bad'}"></span>${c.ok ? 'ComfyUI ready' : 'ComfyUI offline'}${startable ? '<button type="button" class="comfy-start">▶ Start it</button>' : ''}`;
  el.title = c.ok ? `ComfyUI ${c.version || ''}${c.gpu ? ` on ${c.gpu}` : ''}`.trim() : c.error || '';
}

$('#wfpSelect').addEventListener('change', e => pickWorkflow(state.modelId, e.target.value));
$('#wfpEdit').addEventListener('click', () => editWorkflow($('#wfpSelect').value));
$('#wfpSettings').addEventListener('click', () => editWorkflow($('#wfpSelect').value, { focusSampler: true }));
for (const id of ['#wfpAdd', '#wfpAddFirst']) $(id).addEventListener('click', () => openWorkflowDialog({ modelId: state.modelId }));
$('#wfpAuto').addEventListener('change', e => {
  saved.set(autoRenderKey(state.modelId), e.target.checked);
  const flow = state.workflows.find(f => f.id === $('#wfpSelect').value);
  toast(e.target.checked ? `⚡ Auto-render on: new prompts go straight to “${flow?.name}”` : 'Auto-render off: hit ▶ Render when you\'re ready');
});

// Renders freshly written takes right away when the model's auto-render switch is on.
function autoRender(cards) {
  const m = modelById(state.entry?.modelId);
  if (!m || !saved.get(autoRenderKey(m.id), false) || !workflowsFor(m.id).length) return;
  cards.forEach(c => { if (c.rb && !c.interrupted) startRender(c); });
}

// ---------- batch (step ⑤) ----------
// Your saved batches. Each stands on its own: a name, how many images or videos, and whether they all come from one
// prompt (a new seed each) or each from its own prompt. Generate runs no batch, one of them, or all of them in order.
// Batches render, so they need a workflow; a chain has its own takes and renders, so they're off while one is set up.

const BATCH_MAX = 50; // the server allows as many
const batches = () => state.settings?.batches || [];
const batchAvailable = () => workflowsFor(state.modelId).length > 0 && !state.chain.steps.length;
const outputWord = (n, kind = currentModel()?.kind) => `${kind === 'video' ? 'video' : 'image'}${n === 1 ? '' : 's'}`;
const batchLine = b => `${b.count} ${outputWord(b.count)}, ${b.mode === 'same' ? 'one prompt' : 'a different prompt each'}`;
const cut = (str, n) => (str.length > n ? `${str.slice(0, n - 1)}…` : str);

// The batches the next Generate runs, in order ([] = none).
function pickedBatches() {
  if (!batchAvailable()) return [];
  if (state.batchPick === '*') return batches();
  const b = batches().find(x => x.id === state.batchPick);
  return b ? [b] : [];
}
function batchOn() {
  return pickedBatches().length > 0;
}

function renderBatch() {
  const list = batches();
  if (state.batchPick === '*' && list.length < 2) state.batchPick = list[0]?.id || '';
  if (state.batchPick && state.batchPick !== '*' && !list.some(b => b.id === state.batchPick)) state.batchPick = '';
  const picked = pickedBatches();
  const on = picked.length > 0;
  $('#batchBox').hidden = !batchAvailable();
  $('#wfpAutoRow').hidden = state.chain.steps.length > 0 || on; // a batch always renders
  const pick = $('#batchPick');
  pick.innerHTML = '<option value="">No batch: just the takes from step 4</option>'
    + list.map(b => `<option value="${esc(b.id)}">🎞 ${esc(b.name)} · ${esc(batchLine(b))}</option>`).join('')
    + (list.length > 1 ? `<option value="*">🎞 All ${list.length} batches, one after another</option>` : '');
  pick.value = state.batchPick;
  pick.disabled = !list.length;
  renderBatchRows(new Set(picked.map(b => b.id)));
  const total = picked.reduce((n, b) => n + b.count, 0);
  $('#batchHint').textContent = !list.length ? 'Make a batch: name it, say how many images or videos, and whether they share one prompt or each get their own.'
    : picked.length > 1 ? `Generate runs all ${picked.length} batches, one after another: ${total} ${outputWord(total)} in all.`
      : on ? `Generate runs “${picked[0].name}”: ${picked[0].mode === 'same' ? `1 prompt, rendered ${total} times with a new seed each` : `${total} different prompts, each rendered once`}.`
        : 'Pick a batch above and Generate runs it.';
  // Takes (step ④): a batch decides how many prompts get written.
  $('#varSeg').classList.toggle('locked', on);
  $$('#varSeg button').forEach(b => { b.disabled = on; });
  $('#varSeg').title = on ? 'Set by the batch in step 5' : '';
  updateGenerateLabel();
}

// One row per batch. Not redrawn while you type in one (that would lose the cursor); a redraw keeps button focus.
function renderBatchRows(picked) {
  const box = $('#batchList');
  const active = document.activeElement;
  if (box.contains(active) && active.matches('input')) {
    $$('li', box).forEach(li => li.classList.toggle('on', picked.has(li.dataset.id)));
    return;
  }
  const keep = box.contains(active) ? { id: active.closest('li')?.dataset.id, sel: active.dataset.mode ? `[data-mode="${active.dataset.mode}"]` : '.b-del' } : null;
  box.innerHTML = batches().map(b => `
    <li data-id="${esc(b.id)}" class="${picked.has(b.id) ? 'on' : ''}">
      <input type="text" class="b-name" value="${esc(b.name)}" maxlength="60" spellcheck="false" aria-label="Batch name">
      <label class="b-count"><input type="number" min="1" max="${BATCH_MAX}" step="1" inputmode="numeric" value="${b.count}" aria-label="How many ${outputWord(2)} in ${esc(b.name)}"> <span>${outputWord(b.count)}</span></label>
      <div class="seg b-mode" role="radiogroup" aria-label="Prompts in ${esc(b.name)}">${[['same', '🔁 One prompt'], ['different', '🔀 A different prompt each']].map(([v, label]) =>
        `<button type="button" role="radio" data-mode="${v}" aria-checked="${b.mode === v}" class="${b.mode === v ? 'active' : ''}">${label}</button>`).join('')}</div>
      <button type="button" class="icon-btn b-del" aria-label="Delete the batch ${esc(b.name)}" title="Delete this batch">✕</button>
    </li>`).join('');
  if (keep?.id) $(`li[data-id="${CSS.escape(keep.id)}"] ${keep.sel}`, box)?.focus();
}

let batchSaving = Promise.resolve();
function saveBatches(list) {
  state.settings.batches = list;
  renderBatch();
  batchSaving = batchSaving
    .then(() => api('/api/settings', { method: 'PUT', body: { batches: list } }))
    .then(s => { if (state.settings.batches === list) { state.settings.batches = s.batches; renderBatch(); } })
    .catch(err => toast(`Couldn't save your batches: ${err.message}`, true));
  return batchSaving;
}
const updateBatch = (id, change) => saveBatches(batches().map(b => (b.id === id ? { ...b, ...change } : b)));
const batchOf = el => batches().find(b => b.id === el.closest('li')?.dataset.id);

function setBatchPick(value) {
  state.batchPick = value;
  saved.set('batchPick', value);
  renderBatch();
}
$('#batchPick').addEventListener('change', e => setBatchPick(e.target.value));
$('#batchAdd').addEventListener('click', () => {
  const list = batches();
  let n = list.length + 1;
  while (list.some(b => b.name === `Batch ${n}`)) n++;
  const b = { id: `b${Date.now().toString(36)}`, name: `Batch ${n}`, count: 4, mode: 'same' };
  state.batchPick = b.id; // a new batch is the one you're about to run
  saved.set('batchPick', b.id);
  saveBatches([...list, b]);
  const name = $(`#batchList li[data-id="${b.id}"] .b-name`);
  name?.focus();
  name?.select();
});
$('#batchList').addEventListener('input', e => {
  if (e.target.matches('.b-count input')) $('span', e.target.closest('.b-count')).textContent = outputWord(Number(e.target.value) || 0);
});
$('#batchList').addEventListener('change', e => {
  const b = batchOf(e.target);
  if (!b) return;
  if (e.target.matches('.b-name')) {
    const name = e.target.value.trim() || b.name;
    e.target.value = name;
    if (name !== b.name) updateBatch(b.id, { name });
  } else if (e.target.matches('.b-count input')) {
    const count = clampInt(e.target.value, 1, BATCH_MAX);
    e.target.value = count;
    if (count !== b.count) updateBatch(b.id, { count });
  }
});
// Enter in a batch's name or count keeps it, instead of submitting the form (= Generate).
$('#batchList').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); e.target.blur(); }
});
$('#batchList').addEventListener('click', e => {
  const b = batchOf(e.target);
  if (!b) return;
  const mode = e.target.closest('[data-mode]');
  if (mode && mode.dataset.mode !== b.mode) return updateBatch(b.id, { mode: mode.dataset.mode });
  if (!e.target.closest('.b-del')) return;
  const before = batches();
  const pickBefore = state.batchPick;
  saveBatches(before.filter(x => x.id !== b.id));
  toast(`🗑 Deleted the batch “${b.name}”`, false, { label: '↶ Undo', run: () => { saveBatches(before); setBatchPick(pickBefore); toast('↶ The batch is back'); } });
});

// Runs an order's batches one after another. Each is its own Generate: its own takes and History entry, named after it.
async function runBatches(order) {
  const { batches: list, model: m } = order;
  const run = { list, index: 0, name: '', total: 0, done: 0, allDone: 0, stopped: false };
  state.batchRun = run;
  let ok = true;
  for (const [i, b] of list.entries()) {
    if (run.stopped) break;
    Object.assign(run, { index: i, name: b.name, total: b.count, done: 0 });
    const body = { ...order.body, variations: b.mode === 'different' ? b.count : 1, batch: b.name };
    closeRun();
    const entry = await runGeneration(body, m);
    if (!entry || run.stopped) { ok = Boolean(entry); break; }
    await renderBatchTakes(b, run, order.render);
    if (!state.comfy?.ok) { ok = false; break; } // ComfyUI went away: the error is on screen, the rest would fail the same way
  }
  state.batchRun = null;
  setBusy(false);
  setTitle(document.hidden && run.allDone ? '✓ Rendered' : '');
  const made = `${run.allDone} ${outputWord(run.allDone, m?.kind)}`;
  if (run.stopped) toast(`■ Batch stopped. ${made} finished, and they're kept${lineNote()}`);
  else if (run.allDone) toast(`🎞 ${list.length > 1 ? `All ${list.length} batches` : `“${list[0].name}”`} done: ${made}`);
  return ok;
}

// One prompt: its take renders that many times. A prompt each: one take at a time (each render keeps a stream
// open, and the browser only allows a few per server, so 20 at once would stall the page).
async function renderBatchTakes(b, run, setup) {
  const cards = state.cards.filter(c => c.rb && !c.interrupted);
  if (!cards.length) return;
  setBusy(false); // ■ Stop stays, for the batch
  if (b.mode === 'same') {
    cards[0].rb.count = b.count;
    await startRender(cards[0], { quiet: true, setup });
    return;
  }
  for (const c of cards) {
    if (run.stopped) break;
    c.rb.count = 1;
    await startRender(c, { quiet: true, setup });
    if (!state.comfy?.ok) break;
  }
}

let comfyLoading = null;
function loadComfyStatus() {
  comfyLoading ??= api('/api/comfy/status')
    .catch(err => ({ ok: false, error: err.message }))
    .then(st => {
      const cameBack = state.comfy && !state.comfy.ok && st.ok;
      state.comfy = st;
      comfyLoading = null;
      state.cards.forEach(updateRenderStatus);
      renderComfyState();
      if (cameBack) toast('🎨 ComfyUI is connected');
      if (st.ok) {
        checkWorkflowUpdates();
        const m = currentModel();
        if (m && workflowsFor(m.id).length) checkWorkflowModels(activeWorkflowId(m.id));
      }
      return st;
    });
  return comfyLoading;
}
// While ComfyUI is down and there's something to render with, keep checking so it reconnects on its own.
setInterval(() => { if (state.workflows.length && state.comfy && !state.comfy.ok && !document.hidden) loadComfyStatus(); }, 6000);

// ---------- renders on a take ----------

const ASPECT_CSS = ratio => {
  const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(String(ratio || ''));
  return m ? `${m[1]} / ${m[2]}` : '1';
};

function mediaTag(file, { hover = false, controls = false } = {}) {
  const src = `/renders/${encodeURIComponent(file.file)}`;
  if (file.kind === 'video' && hover) {
    const still = posterCache.get(file.file);
    return `<video src="${src}" muted loop playsinline preload="none" data-hover${still ? ` poster="${still}"` : ''}></video>`;
  }
  if (file.kind === 'video') return `<video src="${src}" muted loop playsinline preload="metadata"${controls ? ' controls autoplay' : ''}></video>`;
  if (file.kind === 'audio') return controls ? `<audio src="${src}" controls autoplay></audio>` : '<span aria-hidden="true">🔊</span>';
  return `<img src="${src}" alt="" loading="lazy">`;
}

// Video thumbnails show a still of their first frame and play only while hovered. A page of paused videos goes
// blank at random: the browser suspends idle video players, and a suspended one drops its picture. The stills
// are made once per file, in this page only (never saved), two at a time, as tiles scroll into view.
const posterCache = new Map(); // file → data URL
const posterJobs = new Map(); // file → Promise
let posterRunning = 0;
const posterQueue = [];

function capturePoster(file) {
  if (!posterJobs.has(file)) {
    posterJobs.set(file, new Promise(resolve => { posterQueue.push({ file, resolve }); pumpPosters(); }));
  }
  return posterJobs.get(file);
}

function pumpPosters() {
  while (posterRunning < 2 && posterQueue.length) {
    const { file, resolve } = posterQueue.shift();
    posterRunning++;
    const v = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', playsInline: true });
    let settled = false;
    const finish = url => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load(); // lets the browser free the player
      if (url) posterCache.set(file, url); else posterJobs.delete(file); // a failure may be retried later
      posterRunning--;
      resolve(url);
      pumpPosters();
    };
    const timer = setTimeout(() => finish(null), 20000);
    v.addEventListener('loadeddata', () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, 640 / (v.videoWidth || 640));
        const c = Object.assign(document.createElement('canvas'), { width: Math.round(v.videoWidth * scale) || 1, height: Math.round(v.videoHeight * scale) || 1 });
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', 0.82));
      } catch { finish(null); }
    }, { once: true });
    v.addEventListener('error', () => { finish(null); renderMaybeGone(file); }, { once: true });
    v.src = `/renders/${encodeURIComponent(file)}`;
  }
}

// A render whose file was moved or deleted outside the app while the page shows it leaves quietly, wherever it is.
// (The server already leaves such renders out of what it sends; this covers what's on screen when it happens.)
// A video tile only loads its file when hovered, so its still (above) is what notices.
const goneFiles = new Set();
async function renderMaybeGone(file) {
  if (!file || goneFiles.has(file)) return;
  const res = await fetch(`/renders/${encodeURIComponent(file)}`, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
  if (res?.status !== 404 || goneFiles.has(file)) return; // there after all (a browser that can't play it, say)
  goneFiles.add(file);
  const seen = new Set();
  let held = false;
  for (const e of [state.entry, ...state.history, ...state.prev, ...(state.run?.entries || [])]) {
    if (!e?.variations || seen.has(e)) continue;
    seen.add(e);
    for (const v of e.variations) {
      if (!v.renders?.some(r => (r.files || []).some(f => f.file === file))) continue;
      held = true;
      for (const r of v.renders) r.files = (r.files || []).filter(f => f.file !== file);
      v.renders = v.renders.filter(r => r.files.length);
    }
  }
  if (!held) return;
  state.cards.forEach(c => { if (!c.interrupted) renderTiles(c); });
  renderPrevStrip();
  if (isView('gallery')) renderGallery();
  if (isView('history')) renderHistory();
}
document.addEventListener('error', e => {
  const src = (e.target?.getAttribute?.('src') || '').split('?')[0];
  if (src.startsWith('/renders/')) renderMaybeGone(decodeURIComponent(src.slice('/renders/'.length)));
}, true);

const fileOf = v => decodeURIComponent(v.getAttribute('src').split('/').pop());
const posterSeen = new IntersectionObserver(entries => {
  for (const { target: v, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    posterSeen.unobserve(v);
    capturePoster(fileOf(v)).then(url => { if (url) v.poster = url; });
  }
}, { rootMargin: '400px' });
const needsPoster = root => root.querySelectorAll?.('video[data-hover]:not([poster])').forEach(v => posterSeen.observe(v));
new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
  if (n.nodeType !== 1) return;
  if (n.matches('video[data-hover]:not([poster])')) posterSeen.observe(n);
  needsPoster(n);
}))).observe(document.body, { childList: true, subtree: true });

// Hovering a video tile plays it; leaving goes back to its still (load() shows the poster again and frees the player).
document.addEventListener('mouseover', e => { const v = e.target.closest?.('[data-hover]') || e.target.closest?.('.rtile, .gtile, .hthumb')?.querySelector('video[data-hover]'); if (v) v.play().catch(() => {}); });
document.addEventListener('mouseout', e => {
  const host = e.target.closest?.('.rtile, .gtile, .hthumb');
  const v = host?.querySelector('video[data-hover]');
  if (v && !host.contains(e.relatedTarget)) { v.pause(); if (v.poster) v.load(); }
});

function renderZone(card) {
  const zone = $('.render-zone', card.el);
  const entry = state.entry;
  if (!zone || !entry?.id || card.interrupted) { if (zone) zone.hidden = true; return; }
  const model = card.model;
  const flows = model ? workflowsFor(model.id) : [];
  zone.hidden = false;
  let bar = '';
  if (flows.length) {
    card.rb ??= { count: 1 };
    card.rb.workflowId = activeWorkflowId(model.id);
    const name = card.el.getAttribute('aria-label');
    bar = `<div class="render-bar">
      <span class="rb-title">🎨 Render</span>
      <select class="rb-wf" aria-label="Workflow for ${esc(name)}">${flows.map(f => `<option value="${esc(f.id)}"${f.id === card.rb.workflowId ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <button type="button" class="icon-btn rb-tune" title="Sampler settings for this workflow (seed, steps, CFG, sampler)" aria-label="Sampler settings">⚙</button>
      <div class="seg rb-count" role="radiogroup" aria-label="How many renders">${[1, 2, 3, 4].map(n => `<button type="button" role="radio" data-value="${n}">×${n}</button>`).join('')}</div>
      <button type="button" class="chip-btn rb-seed" aria-pressed="${card.rb.lockSeed}"></button>
      <span class="rb-status" aria-live="polite"></span>
      <button type="button" class="btn small primary rb-go">▶ Render</button>
      <div class="rb-settings" aria-label="Current sampler settings"></div>
    </div>`;
  } else if (model && !saved.get('hideRenderHint', false)) {
    bar = `<div class="render-hint"><span>🎨 Want the ${model.kind === 'video' ? 'video' : 'image'} too? Render it with ComfyUI on your own GPU.</span><span class="spacer"></span><button type="button" class="btn small rh-add">＋ Add a workflow</button><button type="button" class="icon-btn rh-x" aria-label="Hide this tip">✕</button></div>`;
  }
  zone.innerHTML = `${bar}<div class="renders" aria-label="Renders"></div>`;
  const bar$ = $('.render-bar', zone);
  if (bar$) {
    setActive($('.rb-count', bar$), card.rb.count);
    updateSeedChip(card);
    $('.rb-wf', bar$).addEventListener('change', e => pickWorkflow(model.id, e.target.value));
    $('.rb-tune', bar$).addEventListener('click', () => editWorkflow(card.rb.workflowId, { focusSampler: true }));
    updateSettingsLine(card);
    $('.rb-count', bar$).addEventListener('click', e => { const b = e.target.closest('button'); if (b) { card.rb.count = Number(b.dataset.value); setActive($('.rb-count', bar$), card.rb.count); } });
    $('.rb-seed', bar$).addEventListener('click', () => {
      if (model.id !== state.modelId) return toast(`The seed for ${model.name} is set in step 5 when ${model.name} is the picked model.`);
      $('#wfpSeed').scrollIntoView({ block: 'center', behavior: scrollMode() });
      $('#wfpSeed .seed-mode button.active')?.focus();
    });
    $('.rb-go', bar$).addEventListener('click', () => startRender(card));
  }
  $('.rh-add', zone)?.addEventListener('click', () => openWorkflowDialog({ modelId: model.id }));
  $('.rh-x', zone)?.addEventListener('click', () => { saved.set('hideRenderHint', true); state.cards.forEach(renderZone); toast('Tip hidden. Add workflows any time in Models.'); });
  renderTiles(card);
  updateRenderStatus(card);
}

// What a workflow will actually use (sampler, steps, CFG, seed), as small chips.
function settingsHtml(flow) {
  const s = flow?.settings || {};
  const bits = [
    s.sampler && `${s.sampler}${s.scheduler ? ` · ${s.scheduler}` : ''}`,
    s.steps != null && `${s.steps} steps`,
    s.cfg != null && `CFG ${s.cfg}${Number(s.cfg) === 1 ? ' 🔒' : ''}`,
    s.denoise != null && flow?.maps?.image && `denoise ${Number(s.denoise).toFixed(2)}`,
    loraCount(flow) && `🧬 ${loraCount(flow)} LoRA${loraCount(flow) > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return bits.length ? bits.map(b => `<span>${esc(b)}</span>`).join('') : '<span>workflow defaults</span>';
}

// One line under the render bar: what this workflow will actually use.
function updateSettingsLine(card) {
  const line = $('.rb-settings', card.el);
  const flow = state.workflows.find(f => f.id === card.rb?.workflowId);
  if (!line || !flow) return;
  const stale = state.wfStale.has(flow.id);
  line.innerHTML = `${stale ? '<button type="button" class="chip-btn rb-stale" title="This workflow was saved again in ComfyUI after you added it">↻ Changed in ComfyUI · Update</button>' : ''}${settingsHtml(flow)}`;
  // The details are in step ⑤ already: on the take they live in the ⚙ button's tooltip.
  const tune = $('.rb-tune', card.el);
  if (tune) tune.title = `Sampler settings: ${[...line.querySelectorAll(':scope > span')].map(x => x.textContent).join(', ')}. Click to change.`;
  $('.rb-stale', line)?.addEventListener('click', () => updateWorkflow(flow.id));
}

const SEED_ICON = { fixed: '🔒', increment: '＋1', decrement: '−1' };
function updateSeedChip(card) {
  const chip = $('.rb-seed', card.el);
  if (!chip) return;
  const s = state.workflows.find(f => f.id === card.rb?.workflowId)?.seed;
  chip.hidden = !s?.inputs;
  if (!s?.inputs) return;
  chip.textContent = s.mode === 'random' ? '🎲 Random seed' : `${SEED_ICON[s.mode]} Seed ${s.value}`;
  chip.title = 'The seed is set in step 5. Click to go there';
}

function updateRenderStatus(card) {
  const status = $('.rb-status', card.el);
  if (!status) return;
  const c = state.comfy;
  status.innerHTML = !c ? '' : c.ok ? '' : `<span class="dot bad"></span> ComfyUI offline`;
  status.title = c && !c.ok ? c.error : '';
}

const takeRenders = card => state.entry?.variations?.[card.index]?.renders || [];

function renderTiles(card) {
  const box = $('.renders', card.el);
  if (!box) return;
  const items = takeRenders(card).slice().reverse().flatMap(r => r.files.map(f => ({ entry: state.entry, index: card.index, render: r, file: f })));
  const ar = ASPECT_CSS(state.entry?.aspectRatio);
  const video = animateTarget();
  const picking = pickStep() != null;
  const tiles = items.map((it, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rtile${it.file.kind === 'audio' ? ' audio' : ''}`;
    b.style.setProperty('--ar', ar);
    b.setAttribute('aria-label', `Open render ${n + 1}${it.render.seed != null ? `, seed ${it.render.seed}` : ''}`);
    b.innerHTML = `${mediaTag(it.file, { hover: true })}${it.file.kind === 'video' ? '<span class="rt-kind">▶ video</span>' : ''}<span class="rt-meta">${it.render.seed != null ? `seed ${it.render.seed}` : ''}${it.render.secs ? ` · ${it.render.secs}s` : ''}</span>`;
    b.addEventListener('click', () => openLightbox(items, n));
    if (it.file.kind !== 'image' || (!video && !picking)) return b;
    const cell = document.createElement('div');
    cell.className = 'rcell';
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'rt-next' });
    if (picking) {
      // In a chain run: choose which renders go on to the next step.
      const on = state.run.picks.has(pickKey(it));
      const used = continuedFrom(state.run, it);
      go.classList.add('rt-pick');
      go.classList.toggle('on', on);
      go.textContent = on ? '✓ Picked' : used ? '↳ Used' : '☐ Pick';
      go.title = used && !on ? 'This one already went on to the next step. Pick it to send it again' : 'Send this one on to the next step';
      go.setAttribute('aria-pressed', on);
      go.setAttribute('aria-label', `Pick render ${n + 1} for the next step`);
      go.addEventListener('click', () => togglePick(it));
    } else {
      go.textContent = '🎬 Animate';
      go.title = `Make a video from this still with ${video.name}: it becomes the first frame`;
      go.setAttribute('aria-label', `Animate render ${n + 1} with ${video.name}`);
      go.addEventListener('click', () => continueFrom(it, { animate: true }));
    }
    cell.append(b, go);
    return cell;
  });
  box.replaceChildren(...card.running.values(), ...tiles);
  box.hidden = !box.children.length;
}

function runningTile(card) {
  const t = document.createElement('div');
  t.className = 'rtile running';
  t.style.setProperty('--ar', ASPECT_CSS(state.entry?.aspectRatio));
  t.innerHTML = '<div class="rt-shimmer"></div><div class="rt-live"><span class="rt-pct">…</span><span class="rt-stage">Waiting for ComfyUI…</span></div><div class="rt-bar"></div><button type="button" class="rt-cancel" aria-label="Cancel render" title="Cancel this render (a page reload keeps it going)">✕ Cancel</button>';
  return t;
}

// setup: the workflow, LoRAs and sampler settings a Generate was clicked with (see the line), instead of today's.
async function startRender(card, { quiet = false, setup = null } = {}) {
  const entry = state.entry; // the stage may show another entry by the time this finishes (chains)
  const flow = state.workflows.find(f => f.id === (setup?.workflowId || card.rb?.workflowId));
  if (!flow || !entry?.id) return;
  if (cardDirty(card)) await saveEdit(card, { quiet: true });
  if (!state.comfy?.ok) await loadComfyStatus();
  if (!state.comfy?.ok) return showError(state.comfy?.error || 'ComfyUI is not reachable.');
  if (!setup) saved.set(`wf.${card.model.id}`, flow.id);
  const body = { historyId: entry.id, index: card.index, versionIndex: card.view, workflowId: flow.id, count: card.rb.count, newSeed: card.rb.newSeed === true || undefined, ...(setup ? { setup: { loras: setup.loras, overrides: setup.overrides } } : {}) };
  const open = (onEvent, signal) => streamApi('/api/render', body, onEvent, signal).catch(err => {
    if (err.missing) noteMissingModels(flow.id, err.missing); // step ⑤ offers to download them
    throw err;
  });
  return followRender(card, entry, { count: card.rb.count, flowName: flow.name, quiet, open });
}

// Renders run on in Prompt Maker's server when the page reloads or closes. A page showing the entry picks them up
// again: same live tiles, progress and ✕ Cancel.
async function resumeRenders(entry) {
  const jobs = await api('/api/renders').catch(() => []);
  for (const job of jobs) {
    if (job.historyId !== entry.id || state.entry !== entry) continue;
    const following = [...state.renderRuns].find(r => r.runId === job.runId || (!r.runId && r.entryId === entry.id));
    if (following && (!following.runId || state.cards.includes(following.card))) continue;
    following?.detach(); // its tiles were on a stage that's gone: this one shows them now
    const card = state.cards.find(c => c.index === job.index && !c.interrupted);
    if (card) followRender(card, entry, { count: job.count, flowName: job.workflowName, runId: job.runId, open: (onEvent, signal) => streamApi(`/api/renders/${job.runId}/watch`, undefined, onEvent, signal) });
  }
}

// After a reload, the take that is still rendering comes back on the stage.
async function resumeAfterReload() {
  const [job] = await api('/api/renders').catch(() => []);
  if (!job || state.entry || state.busy) return;
  const entry = await api(`/api/history/${job.historyId}`).catch(() => null);
  if (!entry || state.entry) return;
  await openEntry(entry);
  toast('🎨 Your render is still going: picked it up where it is');
}

async function followRender(card, entry, { count, flowName, quiet = false, runId = null, open }) {
  const controller = new AbortController();
  const run = { controller, runId, entryId: entry.id, card, cancelled: false, detached: false };
  // Another view of this take took over its live tiles: this one just lets go, quietly.
  run.detach = () => { run.detached = true; controller.abort(); };
  state.renderRuns.add(run);
  const keys = Array.from({ length: count }, (_, i) => `${Date.now()}-${i}`);
  const tiles = keys.map(() => runningTile(card));
  keys.forEach((k, i) => card.running.set(k, tiles[i]));
  if (!liveTiles.has(entry)) liveTiles.set(entry, new Set());
  tiles.forEach(t => liveTiles.get(entry).add(t));
  // Newest first: the tile for render 1 goes first.
  renderTiles(card);
  // The server's job is what renders, so cancelling tells it (leaving the page or reloading doesn't).
  const cancelRun = () => {
    run.cancelled = true;
    if (run.runId) api(`/api/runs/${run.runId}/cancel`, { method: 'POST' }).catch(() => controller.abort());
  };
  tiles.forEach(t => $('.rt-cancel', t).addEventListener('click', cancelRun));
  const setTile = (i, pct, stage, big) => {
    const t = tiles[i];
    if (!t) return;
    if (pct != null) { $('.rt-pct', t).textContent = `${Math.round(pct)}%`; $('.rt-bar', t).style.width = `${pct}%`; }
    if (big != null) $('.rt-pct', t).textContent = big;
    if (stage != null) $('.rt-stage', t).textContent = stage;
  };
  const done = new Set();
  let failed = null;
  let nodeTitle = '';
  const nodesSeen = new Map();
  announce(`Rendering with ${flowName}`);
  setTitle('🎨 Rendering');
  try {
    await open(ev => {
      const i = ev.i ?? 0;
      if (ev.type === 'start') {
        run.runId = ev.runId;
        if (run.cancelled) cancelRun(); // ✕ before ComfyUI even had it
        pollRenders();
      }
      else if (ev.type === 'queued' && ev.position != null) {
        const ahead = ev.position - 1;
        setTile(i, null, ahead > 0 ? `Waiting: ${ahead} job${ahead > 1 ? 's' : ''} ahead in ComfyUI` : 'Next up in ComfyUI', `#${ev.position}`);
      } else if (ev.type === 'queued') setTile(i, null, 'Sent to ComfyUI…', '⏳');
      else if (ev.type === 'running') setTile(i, 0, 'Starting…');
      else if (ev.type === 'node') {
        nodeTitle = ev.title;
        if (!nodesSeen.has(i)) nodesSeen.set(i, new Set());
        nodesSeen.get(i).add(ev.node);
        setTile(i, null, ev.title);
      } else if (ev.type === 'progress') {
        const pct = ev.overall ?? (ev.max ? (ev.value / ev.max) * 100 : 0); // a video made in pieces: the whole render
        setTile(i, pct, `${nodeTitle || 'Sampling'} · ${ev.value}/${ev.max}`);
        setTitle(`🎨 ${Math.round(pct)}%${count > 1 ? ` (${i + 1}/${count})` : ''}`);
      } else if (ev.type === 'preview') {
        const t = tiles[i];
        let img = t && $('img.rt-preview', t);
        if (t && !img) {
          img = Object.assign(document.createElement('img'), { className: 'rt-preview', alt: '' });
          t.prepend(img);
        }
        if (img) img.src = ev.src;
      } else if (ev.type === 'render') {
        done.add(i);
        card.running.delete(keys[i]);
        liveTiles.get(entry)?.delete(tiles[i]);
        const v = entry.variations?.[card.index];
        if (v && !(v.renders || []).some(r => r.id === ev.render.id)) (v.renders ||= []).push(ev.render); // (replayed when picked up again)
        renderTiles(card);
        if (entry !== state.entry) renderPrevStrip();
        announce(`Render ${i + 1} of ${count} done`);
        if (state.batchRun) {
          state.batchRun.done++;
          state.batchRun.allDone++;
          updateGenerateLabel();
        }
      } else if (ev.type === 'error') {
        failed = ev.message;
        const t = tiles[i];
        if (t) {
          t.className = 'rtile failed';
          t.textContent = `⚠️ ${ev.message}`;
          t.title = ev.message;
        }
      }
    }, controller.signal);
  } catch (err) {
    if (err.name !== 'AbortError') failed = friendly(err);
  }
  state.renderRuns.delete(run);
  tiles.forEach(t => liveTiles.get(entry)?.delete(t));
  if (entry !== state.entry) renderPrevStrip();
  if (card.rb) card.rb.newSeed = false;
  refreshSeeds(); // increment / decrement moved the workflow's next seed on
  // Clear tiles that never finished (stopped); keep failed ones briefly so the reason is visible.
  keys.forEach((k, i) => {
    if (done.has(i)) return;
    const t = card.running.get(k);
    card.running.delete(k);
    if (t?.classList.contains('failed')) setTimeout(() => t.remove(), 12000);
  });
  renderTiles(card);
  pollRenders();
  if (run.detached) return;
  if (failed) {
    showError(failed);
    const box = $('.renders', card.el);
    if (box) {
      tiles.filter(t => t.classList.contains('failed')).forEach(t => box.prepend(t));
      box.hidden = !box.children.length;
    }
  } else if (quiet) { /* a batch says it once, at the end */ } else if (!done.size) toast('■ Render stopped');
  else toast(`🎨 ${done.size} render${done.size > 1 ? 's' : ''} ready`);
  setTitle(document.hidden && done.size ? '✓ Rendered' : '');
  loadComfyStatus();
}

// ---------- next step from a render (chaining) ----------

// The video model a still gets animated with: the one used last time, else the first video model.
function animateTarget() {
  const videos = state.models.filter(m => m.kind === 'video' && !m.motionVideo); // character animation has no first frame
  return videos.find(m => m.id === saved.get('animateModel', null)) || videos[0] || null;
}

// The character-animation model (e.g. Wan Animate 2): the one on Create if it is one, else the first.
const characterTarget = () => (currentModel()?.motionVideo ? currentModel() : state.models.find(m => m.motionVideo) || null);

// Starts the next step from a render: it becomes the input image on Create, linked back to where it came from.
// animate: switch to a video model and use the still as the first frame. character: switch to a character-animation
// model (Wan Animate 2) with the still as the character, for the motion video in step 3.
async function continueFrom(it, { animate, character = false }) {
  if (state.busy) return toast('Hold on, a prompt is still cooking. Stop it or wait.', true);
  const target = character ? characterTarget() : animate ? animateTarget() : null;
  if (animate && !target) return toast('Add a video model first (Models tab).', true);
  if (character && !target) return toast('Add a character-animation model first, like Wan Animate 2 (Models tab).', true);
  let blob;
  try {
    blob = await (await fetch(`/renders/${encodeURIComponent(it.file.file)}`)).blob();
  } catch (err) {
    return toast(`Couldn't use that render: ${err.message}`, true);
  }
  await flushEdits();
  showView('create');
  if (target) {
    if (target.id !== state.modelId) selectModel(target.id);
    state.imageRole = character ? 'character' : 'animate';
    saved.set('imageRole', state.imageRole);
  }
  const source = { entryId: it.entry.id, index: it.index, renderId: it.render.id, file: it.file.file, modelName: it.entry.modelName, seed: it.render.seed ?? null };
  await loadImageFile(new File([blob], it.file.name || it.file.file, { type: blob.type || 'image/png' }), { source, quiet: true });
  if (character) {
    toast(`🧍 Your still is the character for ${target.name}.${state.video ? ' Say where they are (or leave it to the AI), then Generate' : ' Now add a motion video for its moves'}`);
    announce(`The still is now the character for ${target.name}.`);
    $(state.video ? '#theme' : '#motionZone').scrollIntoView({ block: 'center', behavior: scrollMode() });
  } else if (target) {
    replaceTheme(''); // the theme now says what happens; ↶ Undo brings the still's theme back
    toast(`🎬 Ready to animate with ${target.name}. Say what happens (or leave it to the AI), then Generate`);
    announce(`The still is now the first frame for ${target.name}. Describe what happens, then generate.`);
    $('#theme').scrollIntoView({ block: 'center', behavior: scrollMode() });
  } else {
    toast('🖼️ Render set as your image, linked to where it came from');
    $('#dropzone').scrollIntoView({ block: 'center', behavior: scrollMode() });
  }
}

// ---------- chains: build them on Create (step ⑥) ----------
// Step 1 is the Create form itself; each "Then" step takes the renders of the step before as its input image.
// state.chain = { steps: [then steps], renders: renders per take for step 1, recipeId }.

const USE_LABEL = { animate: 'first frame', reference: 'reference', recreate: 'recreate', character: 'character' };
// How a Then step's model can use the image of the step before: first frame first on video models.
const chainUses = m => (m?.imageRoles?.length ? m.imageRoles : m?.kind === 'video' ? ['animate', 'reference', 'recreate'] : ['reference', 'recreate']);
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || lo));
const outputNoun = (m, n) => `${n} ${m?.kind === 'video' ? (n === 1 ? 'video' : 'videos') : (n === 1 ? 'still' : 'stills')}`;

function saveChainState() {
  saved.set('chain', { steps: state.chain.steps, renders: state.chain.renders, recipeId: state.chain.recipeId });
}

// The workflow a chain step renders with: the one asked for (by id, then by name), else the model's own pick
// if it can take an image, else the first one that can.
function chainWorkflow(modelId, ref) {
  const flows = workflowsFor(modelId);
  const hit = ref && (flows.find(f => f.id === ref.id) || flows.find(f => f.name === ref.name));
  if (hit) return hit.id;
  const active = flows.find(f => f.id === activeWorkflowId(modelId));
  return (active?.maps.image ? active : flows.find(f => f.maps.image))?.id || null;
}

function thenStep(st = {}) {
  const m = modelById(st.modelId) || animateTarget() || state.models[0];
  const uses = chainUses(m);
  const flows = m ? workflowsFor(m.id) : [];
  return {
    modelId: m?.id || '',
    workflowId: flows.some(f => f.id === st.workflowId) ? st.workflowId : m ? chainWorkflow(m.id, st.workflow) : null,
    use: uses.includes(st.use) ? st.use : uses[0],
    direction: st.direction || '',
    takes: clampInt(st.takes ?? 1, 1, 4),
    renders: clampInt(st.renders ?? 1, 1, 4),
    duration: m?.kind === 'video' ? (m.durations.includes(st.duration) ? st.duration : m.defaults.duration || m.durations[0] || '') : '',
    gate: st.gate === 'auto' ? 'auto' : 'pick',
    open: st.open ?? true,
  };
}

// What stops the chain from running: { all: reason or '', steps: [reason or '' per Then step] }.
function chainProblems() {
  const m0 = currentModel();
  const steps = state.chain.steps;
  let all = '';
  if (m0?.kind === 'video') all = `A video can't feed the next step yet, so start the chain with an image model. (Extending clips is coming.)`;
  else if (m0 && !workflowsFor(m0.id).length) all = `Chains continue from renders: add a workflow for ${m0.name} in step 5 first.`;
  const per = steps.map((st, i) => {
    const m = modelById(st.modelId);
    if (!m) return 'Pick a model for this step.';
    const flows = workflowsFor(m.id);
    const flow = flows.find(f => f.id === st.workflowId);
    if (!flow) return flows.some(f => f.maps.image) ? `Pick a workflow for ${m.name}.` : `${m.name} has no workflow that takes an image yet. Add one with ＋ (it needs a Load Image node).`;
    if (!flow.maps.image) return `“${flow.name}” has no image input, so it can't take the image from the step before. Pick an image-to-${m.kind} workflow.`;
    if (m.motionVideo && !state.video?.file) return `${m.name} copies the moves of a motion video: add one in step 3 (this step uses it).`;
    if (m.kind === 'video' && i < steps.length - 1) return 'A video can\'t feed the next step yet. (Extending clips is coming.)';
    return '';
  });
  return { all, steps: per };
}

function chainCost() {
  const m0 = currentModel();
  let n = state.variations * state.chain.renders;
  const parts = [outputNoun(m0, n)];
  for (const st of state.chain.steps) {
    const m = modelById(st.modelId);
    if (st.gate === 'pick') {
      parts.push('you pick', outputNoun(m, 2).replace(/^2 /, ''));
      break;
    }
    n *= st.takes * st.renders;
    parts.push(outputNoun(m, n));
  }
  return parts.join(' → ');
}

function updateGenerateLabel() {
  const chained = state.chain.steps.length > 0;
  const list = chained ? [] : pickedBatches();
  const run = state.batchRun;
  const which = run && (run.list.length > 1 ? `Batch ${run.index + 1}/${run.list.length}` : `“${cut(run.name, 22)}”`);
  $('#genLabel').textContent = run ? (run.stopped ? 'Stopping…' : state.busy ? `${which}: writing…` : `${which}: ${run.done} of ${run.total} rendered`)
    : state.busy ? 'Cooking…' : state.chainActive ? 'Chain running…'
      : chained ? 'Run chain' : list.length > 1 ? `Generate all ${list.length} batches` : list.length ? `Generate “${cut(list[0].name, 22)}”`
        : state.variations > 1 ? `Generate ${state.variations} takes` : 'Generate';
  const total = list.reduce((n, b) => n + b.count, 0);
  const chainLine = chained && !state.busy && !state.chainActive ? chainCost() : '';
  const cost = chainLine ? `⛓ ${chainLine}`
    : list.length && !state.busy && !run ? `🎞 ${list.length > 1 ? `${list.length} batches · ${total} ${outputWord(total)}` : batchLine(list[0])}` : '';
  $('#genCost').hidden = !cost;
  $('#genCost').textContent = cost;
}

function stepCardHtml(st, i, warn) {
  const m = modelById(st.modelId);
  const video = m?.kind === 'video';
  const flows = m ? workflowsFor(m.id) : [];
  const flow = flows.find(f => f.id === st.workflowId);
  const uses = chainUses(m);
  const open = st.open || Boolean(warn);
  const summary = [USE_LABEL[st.use], flow?.name || 'no workflow', `${st.takes} take${st.takes > 1 ? 's' : ''}${st.renders > 1 ? ` ×${st.renders}` : ''}`, video ? st.duration : ''].filter(Boolean).join(' · ');
  const models = [...state.models].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
  const from = i === 0 ? 'step 5' : `the step before`;
  return `
    <li class="chain-gate" data-i="${i}">
      <div class="seg gate" role="radiogroup" aria-label="Between ${from} and this step">
        <button type="button" role="radio" data-gate="pick" title="Wait while you pick which renders go on">⏸️ Let me pick</button>
        <button type="button" role="radio" data-gate="auto" title="Send every render on straight away">⚡ Auto</button>
      </div>
    </li>
    <li class="chain-card${open ? ' open' : ''}${warn ? ' bad' : ''}" data-i="${i}" style="--m:${m ? modelColor(m) : 'var(--hot)'}">
      <div class="cc-head">
        <button type="button" class="cc-toggle" data-act="toggle" aria-expanded="${open}">
          <span class="cc-ico" aria-hidden="true">${kindIcon(m?.kind)}</span>
          <span class="cc-title"><b>Then ${esc(m?.name || 'pick a model')}</b><small>${esc(summary)}</small></span>
          <span class="cc-caret" aria-hidden="true">▾</span>
        </button>
        <button type="button" class="icon-btn" data-act="remove" aria-label="Remove this step" title="Remove this step">✕</button>
      </div>
      <div class="cc-body"${open ? '' : ' hidden'}>
        <div class="cc-grid">
          <label class="dial"><span>Model</span><select data-f="modelId">${models.map(x => `<option value="${esc(x.id)}"${x.id === st.modelId ? ' selected' : ''}>${kindIcon(x.kind)} ${esc(x.name)}</option>`).join('')}</select></label>
          <label class="dial"><span>Use the image as</span><select data-f="use">${uses.map(u => `<option value="${u}"${u === st.use ? ' selected' : ''}>${USE_LABEL[u]}</option>`).join('')}</select></label>
        </div>
        <label class="dial"><span>${st.use === 'animate' ? 'What happens' : st.use === 'character' ? 'Where, and from what angle' : 'What changes'} <small class="cc-opt">optional</small></span>
          <textarea data-f="direction" rows="2" placeholder="${st.use === 'animate' ? 'e.g. she takes a sip and laughs, slow push-in. Empty = the AI picks fitting motion' : st.use === 'character' ? 'e.g. on a rooftop at sunset, low angle. The moves come from the motion video in step 3' : 'e.g. make it night, add rain. Empty = keep it as is'}">${esc(st.direction)}</textarea></label>
        <div class="dial"><span>Workflow</span>
          <div class="cc-wf">
            <select data-f="workflowId" aria-label="Workflow for this step"><option value="">— pick a workflow —</option>${flows.map(f => `<option value="${esc(f.id)}"${f.id === st.workflowId ? ' selected' : ''}${f.maps.image ? '' : ' disabled'}>${esc(f.name)}${f.maps.image ? '' : ' (no image input)'}</option>`).join('')}</select>
            <button type="button" class="btn small" data-act="addwf" title="Add a workflow for ${esc(m?.name || 'this model')}" aria-label="Add a workflow">＋</button>
          </div>
        </div>
        <div class="cc-grid${video && m.durations.length ? ' three' : ''}">
          <div class="dial"><span>Takes</span><div class="seg" data-f="takes" role="radiogroup" aria-label="Takes">${[1, 2, 3, 4].map(n => `<button type="button" role="radio" data-value="${n}">${n}</button>`).join('')}</div></div>
          <div class="dial"><span>Renders each</span><div class="seg" data-f="renders" role="radiogroup" aria-label="Renders per take">${[1, 2, 3, 4].map(n => `<button type="button" role="radio" data-value="${n}">×${n}</button>`).join('')}</div></div>
          ${video && m.durations.length ? `<label class="dial"><span>Duration</span><select data-f="duration">${m.durations.map(d => `<option${d === st.duration ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>` : ''}
        </div>
        <p class="warn-line cc-warn"${warn ? '' : ' hidden'}>${esc(warn ? `⚠️ ${warn}` : '')}</p>
      </div>
    </li>`;
}

function renderChainEditor() {
  const box = $('#chainBox');
  if (!box) return;
  $('#motionBlock').hidden = !currentModel()?.motionVideo && !chainNeedsVideo();
  const focus = document.activeElement?.closest?.('#chainBox') ? { i: document.activeElement.closest('[data-i]')?.dataset.i, sel: document.activeElement.dataset.f ? `[data-f="${document.activeElement.dataset.f}"]` : document.activeElement.dataset.act ? `[data-act="${document.activeElement.dataset.act}"]` : null } : null;
  const steps = state.chain.steps;
  // Fill in workflows that weren't known yet (e.g. just added with ＋).
  steps.forEach(st => { if (!st.workflowId && st.modelId) st.workflowId = chainWorkflow(st.modelId); });
  const m0 = currentModel();
  const lastKind = (steps.length ? modelById(steps.at(-1).modelId) : m0)?.kind;
  const canAdd = Boolean(m0) && lastKind !== 'video' && steps.length < 4;
  const problems = state.workflowsLoaded ? chainProblems() : { all: '', steps: [] };
  const recipe = state.recipes.find(r => r.id === state.chain.recipeId);
  box.innerHTML = `
    ${steps.length && problems.all ? `<p class="warn-line">⚠️ ${esc(problems.all)}</p>` : ''}
    ${steps.length ? `<ol class="chain-steps">${steps.map((st, i) => stepCardHtml(st, i, problems.steps[i])).join('')}</ol>` : ''}
    <div class="chain-bar">
      <button type="button" class="btn small" data-act="add"${canAdd ? '' : ' disabled'} title="${canAdd ? 'Add a step that continues from the renders before it' : lastKind === 'video' ? 'A video can\'t feed the next step yet (extending clips is coming)' : 'That\'s as long as a chain gets'}">＋ Then…</button>
      ${steps.length ? `<button type="button" class="btn small" data-act="save">💾 ${recipe ? 'Save chain' : 'Save as a chain'}</button>` : '<span class="muted small">Turn your stills into videos, or chain any steps.</span>'}
    </div>
    <div class="chain-save" hidden>
      <input maxlength="80" placeholder="Name this chain, e.g. Still → Video" aria-label="Chain name" value="${esc(recipe?.name || '')}">
      <button type="button" class="btn small primary" data-act="save-ok">Save</button>
      <button type="button" class="btn small" data-act="save-cancel">Cancel</button>
    </div>
    <div class="chain-recipes">
      <span class="cr-label">⛓ Chains</span>
      ${state.recipes.map(r => `<span class="cr-item${r.id === state.chain.recipeId ? ' on' : ''}"><button type="button" class="chip-btn" data-recipe="${esc(r.id)}" aria-pressed="${r.id === state.chain.recipeId}" title="${esc(r.steps.map(s => modelById(s.modelId)?.name || s.modelId).join(' → '))}">${esc(r.name)}</button>${r.id === state.chain.recipeId ? `<button type="button" class="icon-btn" data-act="export" title="Export “${esc(r.name)}”" aria-label="Export this chain">⤒</button><button type="button" class="icon-btn" data-act="delete-recipe" title="Delete “${esc(r.name)}”" aria-label="Delete this chain">🗑</button>` : ''}</span>`).join('')}
      <button type="button" class="chip-btn" data-act="import" title="Import a chain someone shared (.json)">⤓ Import</button>
    </div>`;
  steps.forEach((st, i) => {
    setActive($(`.chain-gate[data-i="${i}"] .gate`, box), st.gate);
    $$(`.chain-gate[data-i="${i}"] .gate button`, box).forEach(b => { b.classList.toggle('active', b.dataset.gate === st.gate); b.setAttribute('aria-checked', b.dataset.gate === st.gate); });
    setActive($(`.chain-card[data-i="${i}"] [data-f="takes"]`, box), st.takes);
    setActive($(`.chain-card[data-i="${i}"] [data-f="renders"]`, box), st.renders);
  });
  if (focus?.sel) $(`${focus.i != null ? `[data-i="${focus.i}"].chain-card ` : ''}${focus.sel}`, box)?.focus();
  $('#wfpRenders').hidden = !steps.length;
  setActive($('#wfpRenders .seg'), state.chain.renders);
  renderBatch(); // a chain turns the batch off, and hides auto-render

}

const chainStepOf = el => state.chain.steps[Number(el.closest('[data-i]')?.dataset.i)];

$('#chainBox').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const st = chainStepOf(b);
  const act = b.dataset.act;
  if (act === 'add') {
    state.chain.steps.forEach(s => { s.open = false; });
    state.chain.steps.push(thenStep({ open: true }));
    saveChainState();
    renderChainEditor();
    $('.chain-card:last-of-type [data-f="direction"]', $('#chainBox'))?.focus();
    return;
  }
  if (act === 'remove' && st) {
    state.chain.steps.splice(state.chain.steps.indexOf(st), 1);
  } else if (act === 'toggle' && st) {
    st.open = !st.open;
  } else if (act === 'addwf' && st) {
    return openWorkflowDialog({ modelId: st.modelId });
  } else if (act === 'save') {
    const form = $('.chain-save', $('#chainBox'));
    form.hidden = false;
    $('input', form).focus();
    $('input', form).select();
    return;
  } else if (act === 'save-cancel') {
    $('.chain-save', $('#chainBox')).hidden = true;
    return;
  } else if (act === 'save-ok') {
    return saveRecipe();
  } else if (act === 'import') {
    return $('#chainImportInput').click();
  } else if (act === 'export') {
    const r = state.recipes.find(x => x.id === state.chain.recipeId);
    if (r) { download(`${r.id}.prompt-maker-chain.json`, (({ builtin, edited, ...x }) => x)(r)); toast(`⤒ Exported “${r.name}”`); }
    return;
  } else if (act === 'delete-recipe') {
    const r = state.recipes.find(x => x.id === state.chain.recipeId);
    if (!r) return;
    return confirmClick(b, '✓?', async () => {
      try {
        await api(`/api/chains/${r.id}`, { method: 'DELETE' });
        state.chain.recipeId = null;
        await loadRecipes();
        toast(`🗑️ Deleted the chain “${r.name}” (its steps are still here)`);
      } catch (err) {
        toast(err.message, true);
      }
    });
  } else if (b.dataset.recipe) {
    const r = state.recipes.find(x => x.id === b.dataset.recipe);
    if (r) applyRecipe(r);
    return;
  } else if (b.dataset.gate && st) {
    st.gate = b.dataset.gate;
  } else if (b.dataset.value && st) {
    const f = b.closest('[data-f]')?.dataset.f;
    if (f === 'takes' || f === 'renders') st[f] = Number(b.dataset.value);
  } else return;
  saveChainState();
  renderChainEditor();
});
$('#chainBox').addEventListener('change', e => {
  const f = e.target.dataset.f;
  const st = f && chainStepOf(e.target);
  if (!st || f === 'direction') return;
  if (f === 'modelId') Object.assign(st, thenStep({ ...st, modelId: e.target.value, workflowId: null, duration: '' }), { open: true });
  else st[f] = e.target.value || null;
  saveChainState();
  renderChainEditor();
});
$('#chainBox').addEventListener('input', e => {
  if (e.target.dataset.f !== 'direction') return;
  chainStepOf(e.target).direction = e.target.value;
  saveChainState();
});
// The name box sits inside the Create form: Enter saves the chain instead of submitting (= generating).
$('#chainBox').addEventListener('keydown', e => {
  if (!e.target.closest('.chain-save')) return;
  if (e.key === 'Enter') { e.preventDefault(); saveRecipe(); }
  if (e.key === 'Escape') { e.preventDefault(); $('.chain-save', $('#chainBox')).hidden = true; }
});
async function saveRecipe() {
  const input = $('.chain-save input', $('#chainBox'));
  const name = input.value.trim();
  if (!name) return input.focus();
  try {
    const r = await api('/api/chains?overwrite=1', { method: 'POST', body: chainRecipe(name) });
    state.chain.recipeId = r.id;
    saveChainState();
    await loadRecipes();
    toast(`💾 Saved the chain “${r.name}”`);
  } catch (err) {
    toast(err.message, true);
  }
}
$('#wfpRenders').addEventListener('click', e => {
  const b = e.target.closest('button[data-value]');
  if (!b) return;
  state.chain.renders = Number(b.dataset.value);
  saveChainState();
  renderChainEditor();
});
$('#chainImportInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await api('/api/chains?overwrite=1', { method: 'POST', body: JSON.parse(await file.text()) });
    await loadRecipes();
    applyRecipe(state.recipes.find(x => x.id === r.id) || r);
  } catch (err) {
    toast(`Import failed: ${err.message}`, true);
  }
});

// The current setup as a recipe (also what a run remembers, so it can be continued later).
function chainRecipe(name = '') {
  const m0 = currentModel();
  const ref = id => { const f = state.workflows.find(x => x.id === id); return f ? { id: f.id, name: f.name } : null; };
  return {
    name,
    steps: [
      { modelId: m0.id, workflow: ref(activeWorkflowId(m0.id)), takes: state.variations, renders: state.chain.renders, dials: { aspectRatio: $('#aspect').value, resolution: $('#resolution').value, length: state.length, temperature: Number($('#temperature').value) } },
      ...state.chain.steps.map(s => ({ modelId: s.modelId, workflow: ref(s.workflowId), takes: s.takes, renders: s.renders, use: s.use, direction: s.direction, duration: s.duration, gate: s.gate })),
    ],
  };
}

function applyRecipe(r, { quiet = false } = {}) {
  const [first, ...rest] = r.steps;
  const missing = r.steps.find(s => !modelById(s.modelId));
  if (missing) return toast(`“${r.name}” uses the model “${missing.modelId}”, which isn't in your Models.`, true);
  const dials = first.dials || {};
  selectModel(first.modelId, Object.keys(dials).length ? { values: { ...saved.get(prefsKey(first.modelId), {}), ...dials } } : {});
  setVariations(first.takes);
  const wf0 = chainWorkflow(first.modelId, first.workflow) || activeWorkflowId(first.modelId);
  if (first.workflow && wf0) pickWorkflow(first.modelId, wf0);
  state.chain = { recipeId: r.id || null, renders: first.renders || 1, steps: rest.map(s => thenStep({ ...s, open: false })) };
  saveChainState();
  renderChainEditor();
  if (!quiet) toast(`⛓ “${r.name}” is set up. Describe the shot, then Run chain`);
}

async function loadRecipes() {
  state.recipes = await api('/api/chains').catch(() => []);
  if (state.chain.recipeId && !state.recipes.some(r => r.id === state.chain.recipeId)) state.chain.recipeId = null;
  renderChainEditor();
}

// ---------- chains: running them ----------
// state.run = { id, theme, steps: [{ modelId, workflowId, takes, renders, use?, direction?, duration?, gate? }],
//   entries (history entries of the run), picks (renders chosen to continue), rendering (entry ids), status }

// A run's step k. Then steps come from the chain on screen, so changes you make while picking (say, what
// happens next) apply when you Continue. Step 0 and steps no longer on screen come from the run itself.
function runStep(run, k) {
  return (k > 0 && state.chain.steps[k - 1]) || run.steps[k];
}
const runLength = run => (run.steps.length ? Math.max(run.steps.length, state.chain.steps.length + 1) : 0);

function setChainActive(on) {
  state.chainActive = on;
  setBusy(state.busy);
}

// A run's steps as the client uses them, from the recipe-shaped snapshot stored on its first entry.
const runSteps = snapshot => snapshot.map((s, i) => (i === 0
  ? { modelId: s.modelId, workflowId: chainWorkflow(s.modelId, s.workflow) || activeWorkflowId(s.modelId), takes: s.takes, renders: s.renders }
  : thenStep({ ...s, open: false })));

async function runChain() {
  const { all, steps: per } = chainProblems();
  const stepProblem = per.find(Boolean);
  if (all || stepProblem) {
    showError(all || `Then step ${per.indexOf(stepProblem) + 1}: ${stepProblem}`);
    $('#chainStep').scrollIntoView({ block: 'center', behavior: scrollMode() });
    return;
  }
  const body = await formRequest();
  if (!body) return;
  const llm = selectedLlm();
  if (llm?.vision === false) return showError(`${llm.name} is text-only, and each Then step shows the image to the brain. Pick a vision model (👁) in the top bar.`);
  const m0 = currentModel();
  const recipe = chainRecipe();
  const run = { id: crypto.randomUUID(), theme: body.theme, steps: runSteps(recipe.steps), entries: [], picks: new Map(), rendering: new Set(), status: 'running', stopped: false };
  state.run = run;
  body.chain = { runId: run.id, step: 0, steps: recipe.steps };
  setChainActive(true);
  renderRunStrip();
  const entry = await runGeneration(body, m0);
  if (!entry || run.stopped) return finishRun(run);
  run.entries.push(entry);
  renderRunStrip();
  await renderStep(run, entry, 0);
  await advance(run, 0);
}

// Renders a step's freshly written takes with the step's workflow. Must start while they're on the stage.
async function renderStep(run, entry, k) {
  const step = runStep(run, k);
  if (state.entry !== entry) return;
  if (step.workflowId && workflowsFor(entry.modelId).some(f => f.id === step.workflowId)) pickWorkflow(entry.modelId, step.workflowId);
  const cards = state.cards.filter(c => c.rb && !c.interrupted);
  run.rendering.add(entry.id);
  renderRunStrip();
  await Promise.all(cards.map(c => { c.rb.count = step.renders; return startRender(c); }));
  run.rendering.delete(entry.id);
  renderRunStrip();
}

// The image renders a step made (what the next step can continue from).
function stepOutputs(run, k) {
  return run.entries.filter(e => e.chain?.step === k).flatMap(entry => entry.variations.flatMap((v, index) =>
    (v.renders || []).flatMap(render => render.files.filter(f => f.kind === 'image').map(file => ({ entry, index, render, file })))));
}
const pickKey = it => `${it.render.id}|${it.file.file}`;
const continuedFrom = (run, it) => run.entries.some(e => e.source?.renderId === it.render.id && e.source.file === it.file.file);

async function advance(run, k) {
  const next = runStep(run, k + 1);
  if (!next) return finishRun(run, '✓ Chain done');
  if (next.gate === 'auto') return continueWith(run, k, stepOutputs(run, k).filter(it => !continuedFrom(run, it)));
  finishRun(run);
  toast(`⏸️ Pick the ${outputNoun(modelById(runStep(run, k).modelId), 2).replace(/^2 /, '')} to continue with, then Continue ▶`);
}

async function continueWith(run, k, items) {
  const step = runStep(run, k + 1);
  const model = modelById(step?.modelId);
  if (!model) return showError('This chain\'s next model no longer exists.');
  const problem = state.chain.steps[k] === step && chainProblems().steps[k];
  if (problem) return showError(`Then step ${k + 1}: ${problem}`);
  if (!items.length) {
    finishRun(run);
    return toast(`Nothing to continue with: step ${k + 1} has no image renders.`, true);
  }
  run.status = 'running';
  run.stopped = false;
  items.forEach(it => run.picks.delete(pickKey(it)));
  setChainActive(true);
  renderRunStrip();
  const rendering = [];
  for (const it of items) {
    if (run.stopped) break;
    let img;
    try {
      img = await imageFromRender(it.file);
    } catch (err) {
      showError(`Couldn't use that render: ${friendly(err)}`);
      break;
    }
    // A character animation takes the character's shape (and the motion video from step 3, cropped to it).
    const motion = model.motionVideo ? videoForRequest() : null;
    const shape = img.ratio || (motion && state.video.ratio);
    const aspect = ownAspect(model, shape) || closestAspect(model, shape) || model.defaults.aspectRatio || '';
    const body = {
      modelId: model.id,
      theme: step.direction.trim(),
      imageRole: chainUses(model).includes(step.use) ? step.use : chainUses(model)[0],
      ...(motion ? { video: motion } : {}),
      aspectRatio: aspect,
      resolution: resolutionFor({ ...model, resolutions: sizeChoices(model, aspect) }, aspect, model.defaults.resolution) || model.defaults.resolution || '',
      duration: model.kind === 'video' ? step.duration : '',
      length: model.defaults.length,
      temperature: model.defaults.temperature,
      variations: step.takes,
      imageFile: img.file,
      source: { entryId: it.entry.id, index: it.index, renderId: it.render.id, file: it.file.file },
      chain: { runId: run.id, step: k + 1 },
    };
    const entry = await runGeneration(body, model);
    if (!entry) break;
    run.entries.push(entry);
    renderRunStrip();
    rendering.push(renderStep(run, entry, k + 1)); // ComfyUI renders while the brain writes the next one
  }
  await Promise.all(rendering);
  if (run.stopped || state.run !== run) return finishRun(run);
  await advance(run, k + 1);
}

function finishRun(run, message) {
  run.status = runStep(run, run.entries.reduce((k, e) => Math.max(k, e.chain?.step ?? 0), 0) + 1) ? 'waiting' : 'done';
  setChainActive(false);
  renderRunStrip();
  state.cards.forEach(renderTiles);
  if (message && !run.stopped) toast(message);
}

// A refine or a saved edit brings back a new copy of the entry: keep the run pointing at it.
function syncRunEntry(entry) {
  const list = state.run?.entries;
  const i = list ? list.findIndex(e => e.id === entry.id) : -1;
  if (i < 0) return;
  list[i] = entry;
  renderRunStrip();
}

function closeRun() {
  state.run = null;
  renderRunStrip();
}

// Shows one of the run's entries on the stage, leaving the Create form as it is.
function showEntry(entry) {
  if (state.busy) return toast('Hold on, a prompt is still cooking.', true);
  state.timings = {};
  renderResults(entry);
  renderRunStrip();
}

// Which step of the current run the stage's entry belongs to, if a next step can continue from it.
function pickStep() {
  const run = state.run;
  if (!run || !state.entry?.chain || state.entry.chain.runId !== run.id) return null;
  const k = state.entry.chain.step;
  return runStep(run, k + 1) && !state.chainActive ? k : null;
}

// The step Continue and Pick all act on: the one on stage if it can go on, else the newest step.
function focusStep(run) {
  return pickStep() ?? run.entries.reduce((k, e) => Math.max(k, e.chain?.step ?? 0), 0);
}

function togglePick(it) {
  const run = state.run;
  if (!run) return;
  const key = pickKey(it);
  if (run.picks.has(key)) run.picks.delete(key); else run.picks.set(key, it);
  state.cards.forEach(renderTiles);
  renderRunStrip();
}

function renderRunStrip() {
  const el = $('#runStrip');
  const run = state.run;
  el.hidden = !run;
  if (!run) return;
  const steps = Array.from({ length: runLength(run) }, (_, k) => runStep(run, k));
  const last = focusStep(run);
  const next = steps[last + 1];
  const outputs = next ? stepOutputs(run, last) : [];
  const fresh = outputs.filter(it => !continuedFrom(run, it));
  const pool = fresh.length ? fresh : outputs;
  const picks = [...run.picks.values()].filter(it => it.entry.chain?.step === last);
  const writing = state.chainActive && state.busy;
  const status = run.status === 'running'
    ? (writing ? `✍️ Writing step ${state.entry?.chain?.step + 1 || 1}…` : run.rendering.size ? '🎨 Rendering…' : '⛓ Running…')
    : next ? (outputs.length ? `⏸️ Pick ${outputNoun(modelById(steps[last].modelId), 2).replace(/^2 /, '')} to continue with` : 'Waiting for renders') : '✓ Done';
  const chip = e => {
    const files = e.variations.flatMap(v => (v.renders || []).flatMap(r => r.files.map(f => ({ ...f, at: r.createdAt })))).filter(f => f.kind !== 'audio');
    const cover = files.sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const m = modelById(e.modelId);
    return `<button type="button" class="rs-chip${e === state.entry ? ' on' : ''}${run.rendering.has(e.id) ? ' busy' : ''}" data-id="${esc(e.id)}" style="--m:${modelColor(m || { id: e.modelId })}" aria-label="Show ${esc(e.modelName)}${e.source ? `, from take ${e.source.index + 1}` : ''}" aria-current="${e === state.entry}">${cover ? mediaTag(cover) : e.imageFile ? `<img src="/images/${esc(e.imageFile)}" alt="">` : `<span class="rs-ico">${kindIcon(e.modelKind)}</span>`}${files.length > 1 ? `<em>${files.length}</em>` : ''}</button>`;
  };
  el.innerHTML = `
    <div class="rs-head">
      <span class="rs-title">⛓ Chain</span>
      <span class="rs-theme" title="${esc(run.theme || '')}">${esc(run.theme || 'from an image')}</span>
      <span class="rs-status" aria-live="polite">${esc(status)}</span>
      <span class="spacer"></span>
      ${next && run.status !== 'running' && outputs.length ? `${pool.length > 1 ? `<button type="button" class="btn small" data-act="pick-all">Pick all ${pool.length}</button>` : ''}<button type="button" class="btn small primary" data-act="continue"${picks.length ? '' : ' disabled'}>Continue ▶${picks.length ? ` ${picks.length}` : ''}</button>` : ''}
      <button type="button" class="icon-btn" data-act="close" aria-label="Close the chain view" title="Close (the run stays in History)">✕</button>
    </div>
    <ol class="rs-steps">${steps.map((st, k) => {
      const m = modelById(st.modelId);
      const entries = run.entries.filter(e => e.chain?.step === k);
      return `${k ? `<li class="rs-gate" title="${st.gate === 'auto' ? 'Every render goes on' : 'You pick which renders go on'}">${st.gate === 'auto' ? '⚡' : '⏸️'}</li>` : ''}
        <li class="rs-step" style="--m:${m ? modelColor(m) : 'var(--hot)'}">
          <span class="rs-label">${k + 1} · ${kindIcon(m?.kind)} ${esc(m?.name || st.modelId)}</span>
          <div class="rs-items">${entries.map(chip).join('') || '<span class="rs-wait">…</span>'}</div>
        </li>`;
    }).join('')}</ol>`;
}

$('#runStrip').addEventListener('click', e => {
  const run = state.run;
  const b = e.target.closest('button');
  if (!b || !run) return;
  if (b.dataset.act === 'close') return closeRun(), state.cards.forEach(renderTiles);
  const last = focusStep(run);
  if (b.dataset.act === 'pick-all') {
    const outputs = stepOutputs(run, last);
    const fresh = outputs.filter(it => !continuedFrom(run, it));
    (fresh.length ? fresh : outputs).forEach(it => run.picks.set(pickKey(it), it));
    state.cards.forEach(renderTiles);
    return renderRunStrip();
  }
  if (b.dataset.act === 'continue') return continueWith(run, last, [...run.picks.values()].filter(it => it.entry.chain?.step === last));
  if (b.classList.contains('rs-chip')) {
    const entry = run.entries.find(x => x.id === b.dataset.id);
    if (entry && entry !== state.entry) showEntry(entry);
  }
});

// Reopens a whole run from History: the Create form gets its first step and its chain back.
async function openRun(entry) {
  const all = await api('/api/history').catch(() => null);
  if (!all) return toast('Couldn\'t load History.', true);
  state.history = all;
  const entries = all.filter(e => e.chain?.runId === entry.chain.runId).reverse();
  const root = entries.find(e => e.chain.step === 0);
  const live = entries.find(e => e.id === entry.id) || entry;
  await loadForm(root || live);
  if (root?.chain.steps) {
    const [first, ...rest] = root.chain.steps;
    const wf0 = chainWorkflow(first.modelId, first.workflow);
    if (wf0) pickWorkflow(first.modelId, wf0);
    // Each step as it actually ran (you can change a step while picking), from its newest entry.
    const ran = rest.map((st, i) => {
      const kid = entries.filter(e => e.chain.step === i + 1).at(-1);
      if (!kid) return thenStep({ ...st, open: false });
      const render = kid.variations.flatMap(v => v.renders || []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1);
      return thenStep({ ...st, modelId: kid.modelId, direction: kid.theme || '', use: kid.imageRole || st.use, takes: kid.variations.length, duration: kid.duration || st.duration, workflowId: render?.workflowId, open: false });
    });
    state.chain = { recipeId: null, renders: first.renders || 1, steps: ran };
    saveChainState();
    renderChainEditor();
  }
  state.run = { id: entry.chain.runId, theme: (root || live).theme, steps: root?.chain.steps ? runSteps(root.chain.steps) : [], entries, picks: new Map(), rendering: new Set(), status: 'waiting', stopped: false };
  if (!root?.chain.steps) state.run.steps = [...new Set(entries.map(e => e.chain.step))].map(k => ({ modelId: entries.find(e => e.chain.step === k).modelId }));
  finishRun(state.run);
  showView('create');
  showEntry(live);
}

// ---------- lightbox ----------

const lb = { items: [], index: 0, fromGallery: false, returnFocus: null };

function openLightbox(items, index, { fromGallery = false } = {}) {
  lb.items = items;
  lb.index = index;
  lb.fromGallery = fromGallery;
  lb.returnFocus = document.activeElement;
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  lbRender();
  $('#lbClose').focus();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lbStage').innerHTML = '';
  document.body.style.overflow = '';
  const seen = lb.items[lb.index];
  if (lb.fromGallery && seen) {
    // The Gallery marks the render you looked at last (you may have browsed on from the one you opened).
    state.gallerySeen = galleryKey(seen);
    const tile = markSeen();
    if (tile) {
      tile.focus({ preventScroll: true });
      tile.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  lb.returnFocus?.focus?.();
}

const galleryKey = it => `${it.render.id}/${it.file.file}`;
function markSeen() {
  let hit = null;
  $$('#galleryGrid .gtile').forEach(t => { const on = t.dataset.key === state.gallerySeen; t.classList.toggle('seen', on); if (on) hit = t; });
  return hit;
}

function stepLightbox(d) {
  if (!lb.items.length) return;
  lb.index = (lb.index + d + lb.items.length) % lb.items.length;
  lbRender();
}

function lbRender() {
  const it = lb.items[lb.index];
  if (!it) return closeLightbox();
  const { entry, render, file } = it;
  const m = modelById(entry.modelId);
  $('#lightbox').style.setProperty('--m', modelColor(m || { id: entry.modelId }));
  $('#lbStage').innerHTML = mediaTag(file, { controls: true });
  $('#lbPrev').disabled = $('#lbNext').disabled = lb.items.length < 2;
  const facts = [
    ['Model', entry.modelName],
    entry.source ? ['From', takeLabel(entry.source)] : null,
    ['Workflow', render.workflowName],
    ['Seed', render.seed ?? '—'],
    render.sampler ? ['Sampler', `${render.sampler}${render.steps ? ` · ${render.steps} steps` : ''}${render.cfg != null ? ` · CFG ${render.cfg}` : ''}`] : null,
    render.loras?.length ? ['LoRAs', render.loras.map(l => `${loraShort(l.name)} ${Number(l.strength).toFixed(2)}`).join(', ')] : null,
    ['Size', render.size || render.aspect || '—'],
    render.frames ? ['Frames', `${render.frames}${render.duration ? ` (${render.duration})` : ''}`] : render.duration ? ['Duration', render.duration] : null,
    ['Took', render.secs ? `${render.secs}s` : '—'],
    ['Made', new Date(render.createdAt).toLocaleString()],
  ].filter(Boolean);
  $('#lbInfo').innerHTML = `
    <h3>${esc(entry.theme || 'From an image')}</h3>
    <dl class="lb-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <pre class="lb-prompt">${esc(render.text)}</pre>
    <div class="lb-actions">
      <a class="btn small primary" href="/renders/${encodeURIComponent(file.file)}" download="${esc(file.name || file.file)}">⬇ Download</a>
      <button type="button" class="btn small" data-lb="copy">📋 Copy prompt</button>
      ${file.kind === 'image' && animateTarget() ? `<button type="button" class="btn small" data-lb="animate" title="Make a video from this still: it becomes the first frame">🎬 Animate this</button>` : ''}
      ${file.kind === 'image' && characterTarget() ? `<button type="button" class="btn small" data-lb="character" title="Make it perform a motion video's moves with ${esc(characterTarget().name)}">🧍 Animate as a character</button>` : ''}
      ${file.kind === 'video' && characterTarget() ? `<button type="button" class="btn small" data-lb="motion" title="Use this video's moves for a character, with ${esc(characterTarget().name)}">🕺 Use as motion video</button>` : ''}
      ${file.kind === 'image' ? '<button type="button" class="btn small" data-lb="use" title="Use this render as the input image for your next prompt">🖼️ Use as input image</button>' : ''}
      ${render.seed != null && state.workflows.some(f => f.id === render.workflowId) ? '<button type="button" class="btn small" data-lb="seed" title="Render with this seed from now on">🔒 Use this seed</button>' : ''}
      ${lb.fromGallery ? '<button type="button" class="btn small" data-lb="open">↗ Open in Create</button>' : '<button type="button" class="btn small" data-lb="again">🎲 Render again</button>'}
      <button type="button" class="btn small fav${render.favorite ? ' on' : ''}" data-lb="fav" aria-pressed="${Boolean(render.favorite)}" title="${render.favorite ? 'Remove from favorites' : 'Add to favorites (Gallery → ♥ Favorites)'}">${render.favorite ? '♥ Favorite' : '♡ Favorite'}</button>
      <button type="button" class="btn small danger" data-lb="delete">🗑 Delete</button>
    </div>
    <p class="muted small">${lb.index + 1} of ${lb.items.length} · ← → to browse · Esc to close</p>`;
  $('[data-lb="copy"]', $('#lbInfo')).addEventListener('click', e => copyText(render.text, e.currentTarget));
  $('[data-lb="fav"]', $('#lbInfo')).addEventListener('click', async () => {
    try {
      const updated = await api(`/api/history/${entry.id}/renders/${render.id}`, { method: 'PATCH', body: { favorite: !render.favorite } });
      forgetRender(updated); // every copy of the entry gets the new state
      it.render = updated.variations[it.index].renders.find(r => r.id === render.id) || render;
      lbRender();
      $('[data-lb="fav"]', $('#lbInfo'))?.focus();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('[data-lb="open"]', $('#lbInfo'))?.addEventListener('click', () => { closeLightbox(); openEntry(entry); });
  $('[data-lb="animate"]', $('#lbInfo'))?.addEventListener('click', () => { closeLightbox(); continueFrom(it, { animate: true }); });
  $('[data-lb="use"]', $('#lbInfo'))?.addEventListener('click', () => { closeLightbox(); continueFrom(it, { animate: false }); });
  $('[data-lb="character"]', $('#lbInfo'))?.addEventListener('click', () => { closeLightbox(); continueFrom(it, { animate: false, character: true }); });
  $('[data-lb="motion"]', $('#lbInfo'))?.addEventListener('click', async () => {
    if (state.busy) return toast('Hold on, a prompt is still cooking. Stop it or wait.', true);
    closeLightbox();
    await flushEdits();
    showView('create');
    const target = characterTarget();
    if (target.id !== state.modelId) selectModel(target.id);
    await useRenderAsVideo(it);
    $('#motionZone').scrollIntoView({ block: 'center', behavior: scrollMode() });
  });
  $('[data-lb="seed"]', $('#lbInfo'))?.addEventListener('click', () => {
    const flow = state.workflows.find(f => f.id === render.workflowId);
    if (!flow) return;
    setSeed(flow, { mode: 'fixed', value: render.seed });
    toast(`🔒 “${flow.name}” now renders with seed ${render.seed}`);
  });
  $('[data-lb="again"]', $('#lbInfo'))?.addEventListener('click', () => {
    const card = state.cards.find(c => c.index === it.index);
    if (!card || !card.rb) return;
    if (state.workflows.some(f => f.id === render.workflowId)) card.rb.workflowId = render.workflowId;
    card.rb.newSeed = true; // "again" always means a new seed, whatever the seed mode
    closeLightbox();
    renderZone(card);
    startRender(card);
  });
  $('[data-lb="delete"]', $('#lbInfo')).addEventListener('click', e => confirmClick(e.currentTarget, 'Sure?', async () => {
    try {
      await deleteRenderNow(entry, render);
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

// Deletes one render for good (the lightbox's Delete, and the assistant after you confirm).
async function deleteRenderNow(entry, render) {
  const updated = await api(`/api/history/${entry.id}/renders/${render.id}`, { method: 'DELETE' });
  forgetRender(updated);
  forgetSeenImages();
  if (!$('#lightbox').hidden) {
    lb.items = lb.items.filter(x => x.render.id !== render.id);
    lb.index = Math.min(lb.index, lb.items.length - 1);
    if (lb.items.length) lbRender(); else closeLightbox();
  }
  toast('🗑️ Render deleted');
}

$('#lbClose').addEventListener('click', closeLightbox);
$('#lbPrev').addEventListener('click', () => stepLightbox(-1));
$('#lbNext').addEventListener('click', () => stepLightbox(1));
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox' || e.target.id === 'lbStage') closeLightbox(); });

// ---------- gallery ----------

async function loadGallery() {
  try {
    state.history = await api('/api/history');
  } catch (err) {
    toast(err.message, true);
  }
  renderGallery();
}

function galleryItems() {
  const items = [];
  for (const entry of state.history) {
    entry.variations.forEach((v, index) => {
      for (const render of v.renders || []) for (const file of render.files) items.push({ entry, index, render, file });
    });
  }
  return items.sort((a, b) => (a.render.createdAt < b.render.createdAt ? 1 : -1));
}

function renderGallery() {
  const all = galleryItems();
  const models = [...new Map(all.map(it => [it.entry.modelId, it.entry.modelName])).entries()];
  if (state.galleryModel && !models.some(([id]) => id === state.galleryModel)) state.galleryModel = '';
  $('#galleryModels').innerHTML = models.length > 1 ? [['', 'All models'], ...models].map(([id, name]) => `<button type="button" class="chip-btn" data-id="${esc(id)}" aria-pressed="${state.galleryModel === id}" style="--m:${id ? modelColor(modelById(id) || { id }) : 'var(--text-2)'}">${esc(name)}</button>`).join('') : '';
  $$('#galleryKinds button').forEach(b => b.setAttribute('aria-pressed', b.dataset.kind === state.galleryKind));
  const items = all.filter(it => (!state.galleryKind || it.file.kind === state.galleryKind || (state.galleryKind === 'fav' && it.render.favorite)) && (!state.galleryModel || it.entry.modelId === state.galleryModel));
  $('#galleryCount').textContent = all.length ? all.length : '';
  const grid = $('#galleryGrid');
  grid.style.height = '';
  if (!items.length) {
    const none = !all.length;
    grid.innerHTML = `<div class="empty">
      <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>${none ? 'No renders yet' : 'Nothing matches'}</h3>
      <p>${none ? 'Attach a ComfyUI workflow to a model (Models tab), then hit <b>▶ Render</b> on any take. Every image and video lands here.' : 'Try another filter.'}</p>
      ${none ? '<div class="try"><button type="button" class="btn primary" data-go="models">🎨 Set up a workflow</button></div>' : ''}</div>`;
    $('[data-go]', grid)?.addEventListener('click', () => showView('models/models'));
    return;
  }
  grid.innerHTML = '';
  items.forEach((it, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gtile';
    b.dataset.key = galleryKey(it);
    b.style.setProperty('--m', modelColor(modelById(it.entry.modelId) || { id: it.entry.modelId }));
    b.setAttribute('aria-label', `Open render: ${it.entry.theme || 'from an image'}`);
    b.innerHTML = `${it.file.kind === 'audio' ? '<div class="rtile audio" style="aspect-ratio:1">🔊</div>' : mediaTag(it.file, { hover: true })}${it.file.kind === 'video' ? '<span class="rt-kind">▶ video</span>' : ''}${it.render.favorite ? '<span class="g-fav" aria-label="Favorite">♥</span>' : ''}<span class="g-cap"><b>${esc(it.entry.theme || 'From an image')}</b><span>${esc(it.entry.modelName)} · ${esc(it.render.workflowName)}</span></span>`;
    b.addEventListener('click', () => openLightbox(items, n, { fromGallery: true }));
    grid.append(b);
  });
  markSeen();
  layoutGallery();
}

// Masonry in reading order: each tile, newest first, goes into whichever column is shortest,
// so the next render sits beside the last one rather than below it. Tiles stay in DOM order
// (for Tab and screen readers); only their position is set here.
function layoutGallery() {
  const grid = $('#galleryGrid');
  const tiles = $$('.gtile:not([hidden])', grid);
  if (!tiles.length) return;
  const css = getComputedStyle(grid);
  const gap = +css.getPropertyValue('--g-gap') || 14;
  const min = +css.getPropertyValue('--g-min') || 260;
  const width = grid.clientWidth;
  const cols = Math.max(1, Math.min(+css.getPropertyValue('--g-cols') || 4, Math.floor((width + gap) / (min + gap))));
  const colW = (width - gap * (cols - 1)) / cols;
  const heights = Array(cols).fill(0);
  for (const t of tiles) t.style.width = `${colW}px`;
  for (const t of tiles) {
    const c = heights.indexOf(Math.min(...heights));
    t.style.left = `${c * (colW + gap)}px`;
    t.style.top = `${heights[c]}px`;
    heights[c] += t.offsetHeight + gap;
  }
  grid.style.height = `${Math.max(...heights) - gap}px`;
}

// Until a picture loads its tile is a square; once its real size is known, place everything again.
let galleryFrame = 0;
function relayoutGallery() {
  cancelAnimationFrame(galleryFrame);
  galleryFrame = requestAnimationFrame(layoutGallery);
}
$('#galleryGrid').addEventListener('load', relayoutGallery, true);
$('#galleryGrid').addEventListener('loadedmetadata', relayoutGallery, true);
// A render whose file was moved or deleted outside the app quietly leaves the layout.
$('#galleryGrid').addEventListener('error', e => {
  const tile = e.target.closest?.('.gtile');
  if (!tile || tile.hidden) return;
  tile.hidden = true;
  relayoutGallery();
}, true);
let galleryWidth = 0;
new ResizeObserver(([e]) => { if (e.contentRect.width !== galleryWidth) { galleryWidth = e.contentRect.width; relayoutGallery(); } }).observe($('#galleryGrid'));

$('#galleryKinds').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.galleryKind = b.dataset.kind; renderGallery(); } });
$('#galleryModels').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.galleryModel = b.dataset.id; renderGallery(); } });

// ---------- models → workflows ----------

const MAP_CHIPS = [['prompt', '✍️ Prompt'], ['motion', '🕺 Motion'], ['image', '🖼️ Image'], ['video', '🎞️ Video'], ['size', '📐 Size'], ['duration', '⏱️ Duration'], ['seed', '🎲 Seed']];
// Motion chips only matter on character-animation models.
const mapChips = m => MAP_CHIPS.filter(([k]) => m?.motionVideo || (k !== 'motion' && k !== 'video'));
const sourceLabel = src => (src.startsWith('comfyui:') ? 'from your ComfyUI library' : src.startsWith('comfytemplate:') ? 'ComfyUI template' : 'uploaded file');

function renderWorkflowList() {
  const list = $('#wfList');
  const id = state.editId;
  const m = modelById(id);
  $('#wfCard').style.setProperty('--m', m ? modelColor(m) : 'var(--hot)');
  $('#addWorkflowBtn').disabled = !id;
  if (!id) {
    list.innerHTML = '<li class="wf-empty">Save this model first, then attach workflows to it.</li>';
    return;
  }
  const flows = workflowsFor(id);
  if (!flows.length) {
    list.innerHTML = '<li class="wf-empty">No workflows yet. Click <b>＋ Add workflow</b> to pick one you\'ve saved in ComfyUI. It\'s optional: prompts work fine without one.</li>';
    return;
  }
  list.innerHTML = flows.map(f => `
    <li class="wf-row" data-id="${esc(f.id)}">
      <span aria-hidden="true">🎨</span>
      <div><div class="wf-name">${esc(f.name)}${state.wfStale.has(f.id) ? ' <span class="tag warn">↻ changed in ComfyUI</span>' : ''}</div><div class="wf-src">${sourceLabel(f.source)} · ${f.nodes} nodes</div></div>
      <div class="wf-maps">${mapChips(m).map(([k, label]) => `<span class="${f.maps[k] ? 'on' : ''}" title="${f.maps[k] ? 'Set by Prompt Maker' : 'Left as the workflow has it'}">${label}</span>`).join('')}</div>
      <div class="wf-actions">
        ${state.wfStale.has(f.id) ? '<button type="button" class="btn small primary" data-act="refresh">↻ Update</button>' : ''}
        <button type="button" class="btn small" data-act="setup">⚙ Set up</button>
        <button type="button" class="btn small" data-act="export">Export</button>
        <button type="button" class="btn small danger" data-act="delete">Delete</button>
      </div>
    </li>`).join('');
}

$('#wfList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.wf-row').dataset.id;
  try {
    if (btn.dataset.act === 'refresh') {
      await updateWorkflow(id);
    } else if (btn.dataset.act === 'setup') {
      const data = await api(`/api/workflows/${id}`);
      openWorkflowDialog({ edit: data });
    } else if (btn.dataset.act === 'export') {
      const w = await api(`/api/workflows/${id}`);
      download(`${slug(w.name) || 'workflow'}.prompt-maker.json`, { format: 'prompt-maker-workflow', version: 1, name: w.name, prompt: w.prompt, mapping: w.mapping, options: w.options, models: w.models || [] });
      toast('⤒ Workflow exported');
    } else if (btn.dataset.act === 'delete') {
      confirmClick(btn, 'Sure?', async () => {
        await api(`/api/workflows/${id}`, { method: 'DELETE' });
        await loadWorkflows();
        toast('🗑️ Workflow removed');
      });
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- add / set up a workflow (dialog) ----------

const dlg = { editId: null, modelId: null, prepared: null, saved: [] };

// Opens on the picker to add a workflow to modelId, or straight on the setup of an existing one (edit).
function openWorkflowDialog({ edit = null, modelId = null, focusSampler = false } = {}) {
  const d = $('#wfDialog');
  dlg.modelId = edit?.modelId || modelId;
  const m = modelById(dlg.modelId);
  d.style.setProperty('--m', m ? modelColor(m) : 'var(--hot)');
  dlg.editId = edit?.id || null;
  $('#wfPickMsg').hidden = true;
  $('#wfDelete').hidden = !edit;
  $('#wfRefresh').hidden = !edit;
  if (edit) $('#wfRefresh').textContent = edit.source?.startsWith('comfyui:') || edit.source?.startsWith('comfytemplate:') ? '↻ Update from ComfyUI' : '↻ Update from a file';
  if (edit) {
    $('#wfDialogTitle').textContent = `Set up “${edit.name}”`;
    showSetup(edit);
  } else {
    $('#wfDialogTitle').textContent = `Add a workflow to ${m?.name || 'this model'}`;
    $('#wfPick').hidden = false;
    $('#wfSetup').hidden = true;
    $('#wfBack').hidden = true;
    $('#wfSave').hidden = true;
    switchWfTab('comfy');
  }
  if (!d.open) d.showModal();
  if (focusSampler) requestAnimationFrame(() => { $('#rowSeed').scrollIntoView({ block: 'center' }); $('#samplerCtl input:not(:disabled), #samplerCtl select:not(:disabled)')?.focus(); });
}

function switchWfTab(tab) {
  setActive($('.wf-tabs'), tab);
  $$('.wf-tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.value === tab));
  $('#wfFromComfy').hidden = tab !== 'comfy';
  $('#wfFromFile').hidden = tab !== 'upload';
  if (tab === 'comfy') loadSavedWorkflows();
}

async function loadSavedWorkflows() {
  const list = $('#wfSaved');
  list.innerHTML = '<li class="muted small">Looking in ComfyUI…</li>';
  const st = await loadComfyStatus();
  if (!st.ok) {
    list.innerHTML = `<li class="wf-empty">🔌 ComfyUI isn't answering at ${esc(st.url || state.settings?.comfyUrl || '')}. Start it, then <button type="button" class="btn small" id="wfRetry">Try again</button><br><small class="muted">Or switch to <b>Upload a file</b> to use an API-format export.</small></li>`;
    $('#wfRetry').addEventListener('click', loadSavedWorkflows);
    return;
  }
  renderTemplates();
  try {
    dlg.saved = await api('/api/comfy/workflows');
  } catch (err) {
    list.innerHTML = `<li class="wf-empty">${esc(err.message)}</li>`;
    return;
  }
  renderSavedList();
}

// ComfyUI's own templates for the model (its playbook names them), offered above your saved workflows.
function renderTemplates() {
  const m = modelById(dlg.modelId);
  const list = m?.comfyTemplates || [];
  $('#wfTemplates').hidden = !list.length;
  $('#wfTplModel').textContent = m?.name || '';
  const have = new Set(workflowsFor(dlg.modelId).map(f => f.source));
  $('#wfTplList').innerHTML = list.map(t => `<li><button type="button" data-template="${esc(t.name)}" data-title="${esc(t.title)}"><span aria-hidden="true">⭐</span><span class="ws-tpl">${esc(t.title)}${t.note ? `<span class="ws-note">${esc(t.note)}</span>` : ''}</span>${have.has(`comfytemplate:${t.name}`) ? '<span class="ws-date">added already</span>' : ''}</button></li>`).join('');
}
$('#wfTplList').addEventListener('click', e => {
  const b = e.target.closest('button[data-template]');
  if (b) prepareWorkflow({ template: b.dataset.template, templateTitle: b.dataset.title });
});

function renderSavedList() {
  const q = $('#wfSearch').value.trim().toLowerCase();
  const items = dlg.saved.filter(f => !q || f.path.toLowerCase().includes(q));
  $('#wfSaved').innerHTML = items.length
    ? items.map(f => `<li><button type="button" data-path="${esc(f.path)}"><span aria-hidden="true">🧩</span><span class="ws-name">${esc(f.path.replace(/\.json$/i, ''))}</span><span class="ws-date">${f.modified ? timeAgo(new Date(f.modified).toISOString()) : ''}</span></button></li>`).join('')
    : `<li class="wf-empty">${dlg.saved.length ? 'No matches.' : 'No saved workflows in ComfyUI yet. Save one there (Workflow → Save), or upload a file.'}</li>`;
}

$('#wfSearch').addEventListener('input', renderSavedList);
$('#wfSaved').addEventListener('click', e => {
  const b = e.target.closest('button[data-path]');
  if (b) prepareWorkflow({ comfyPath: b.dataset.path });
});
$('.wf-tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) switchWfTab(b.dataset.value); });
$('#wfClose').addEventListener('click', () => $('#wfDialog').close());
$('#wfBack').addEventListener('click', () => openWorkflowDialog({ modelId: dlg.modelId }));
$('#wfRefresh').addEventListener('click', () => {
  const flow = state.workflows.find(f => f.id === dlg.editId);
  if (!flow) return;
  if (flow.source.startsWith('comfyui:') || flow.source.startsWith('comfytemplate:')) updateWorkflow(flow.id, { review: true });
  else $('#wfRefreshFile').click();
});
$('#wfRefreshFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !dlg.editId) return;
  try {
    await updateWorkflow(dlg.editId, { json: JSON.parse(await file.text()), review: true });
  } catch {
    wfToast('That file isn\'t valid JSON. Pick a ComfyUI workflow (.json).');
  }
});
$('#wfDelete').addEventListener('click', e => {
  const id = dlg.editId;
  if (!id) return;
  confirmClick(e.currentTarget, 'Sure? Delete it', async () => {
    try {
      await api(`/api/workflows/${id}`, { method: 'DELETE' });
      $('#wfDialog').close();
      await loadWorkflows();
      toast('🗑️ Workflow removed');
    } catch (err) {
      wfToast(err.message);
    }
  });
});
$('#wfDrop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#wfFile').click(); } });
$('#wfFile').addEventListener('change', e => { readWorkflowFile(e.target.files[0]); e.target.value = ''; });
$('#wfDrop').addEventListener('dragover', e => { e.preventDefault(); e.currentTarget.classList.add('drag'); });
$('#wfDrop').addEventListener('dragleave', e => e.currentTarget.classList.remove('drag'));
$('#wfDrop').addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag');
  readWorkflowFile(e.dataTransfer.files[0]);
});

async function readWorkflowFile(file) {
  if (!file) return;
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return wfMessage('That file isn\'t valid JSON. Pick a ComfyUI workflow (.json).');
  }
  prepareWorkflow({ json, name: file.name });
}

function wfMessage(msg) {
  const el = $('#wfPickMsg');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function prepareWorkflow(payload) {
  wfMessage('');
  $('#wfBusy').hidden = false;
  try {
    const data = await api('/api/workflows/prepare', { method: 'POST', body: payload });
    dlg.editId = null;
    showSetup(data);
  } catch (err) {
    wfMessage(err.message);
  } finally {
    $('#wfBusy').hidden = true;
  }
}

const targetKey = t => (t ? `${t.node}|${t.input}` : '');

const PARAM_LABEL = { seed: 'Seed', steps: 'Steps', cfg: 'CFG', sampler: 'Sampler', scheduler: 'Scheduler', denoise: 'Denoise', pose: 'Pose strength', poseStart: 'Pose start', poseEnd: 'Pose end', identity: 'Character strength' };
// What the character-animation knobs do (Wan Animate 2), shown on hover.
const PARAM_TIP = {
  pose: 'How strongly the motion video drives the moves. 1 is as trained; lower loosens it, higher follows it harder.',
  poseStart: 'When, in the sampling steps (0–1), the motion video starts to count.',
  poseEnd: 'When, in the sampling steps (0–1), the motion video stops counting. Around 0.7 keeps the moves but loosens fine detail.',
  identity: 'How closely the character keeps the image\'s look. Below 1 lets the prompt restyle it; above 1 holds it tighter.',
};
const paramLabel = p => {
  const stage = /^(stage\d+|first|second|pass\d+|hires|refiner|base)_/i.exec(p.input)?.[1];
  const base = p.input.toLowerCase() === 'guidance' ? 'Guidance' : PARAM_LABEL[p.kind];
  return stage ? `${base} (${stage.replace(/_/g, ' ')})` : base;
};

// The workflow's seed / steps / CFG / sampler / scheduler, shown as they are and editable.
function renderSamplerControls(data) {
  const box = $('#samplerCtl');
  const params = data.candidates?.params || [];
  const overrides = data.overrides || {};
  const groups = new Map();
  for (const p of params) {
    if (!groups.has(p.node)) groups.set(p.node, []);
    groups.get(p.node).push(p);
  }
  box.innerHTML = '';
  for (const [node, list] of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'sp-node';
    wrap.innerHTML = `<b>#${esc(node)} ${esc(list[0].title)}</b><div class="sp-grid"></div>`;
    for (const p of list) {
      const key = `${p.node}|${p.input}`;
      const current = p.kind === 'seed' ? data.options?.seed ?? overrides[key] ?? p.value : overrides[key] ?? p.value;
      const field = document.createElement('label');
      field.className = 'sp-field';
      field.dataset.key = key;
      field.dataset.kind = p.kind;
      field.dataset.original = String(p.value);
      if (PARAM_TIP[p.kind]) field.title = PARAM_TIP[p.kind];
      const control = p.options
        ? `<select>${p.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`
        : `<input type="${p.kind === 'sampler' || p.kind === 'scheduler' ? 'text' : 'number'}" ${p.kind === 'cfg' ? 'step="0.1" min="0"' : ['denoise', 'poseStart', 'poseEnd'].includes(p.kind) ? 'step="0.01" min="0" max="1"' : ['pose', 'identity'].includes(p.kind) ? 'step="0.05" min="0" max="10"' : p.kind === 'steps' ? 'step="1" min="1"' : 'step="1" min="0"'}>`;
      const locked = p.kind === 'cfg' && Number(p.value) === 1 && overrides[key] === undefined;
      field.innerHTML = `<span>${esc(paramLabel(p))} <button type="button" class="sp-reset" title="Back to the workflow's value (${esc(p.value)})" hidden>↺</button>${locked ? '<button type="button" class="sp-unlock" title="CFG 1 is what distilled, turbo and lightning models need. Unlock only if you know this model takes more.">🔒 unlock</button>' : ''}</span>${control}${locked ? '<small class="sp-lock">Locked at 1 (distilled/turbo)</small>' : ''}`;
      const input = $('input, select', field);
      input.value = String(current);
      input.title = `Workflow value: ${p.value}`;
      if (locked) input.disabled = true;
      const sync = () => {
        const edited = String(input.value) !== String(p.value);
        field.classList.toggle('edited', edited && !input.disabled);
        $('.sp-reset', field).hidden = !edited || input.disabled;
      };
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      $('.sp-reset', field).addEventListener('click', e => { e.preventDefault(); input.value = String(p.value); sync(); });
      $('.sp-unlock', field)?.addEventListener('click', e => {
        e.preventDefault();
        input.disabled = false;
        e.currentTarget.remove();
        $('.sp-lock', field)?.remove();
        input.focus();
      });
      sync();
      $('.sp-grid', wrap).append(field);
    }
    box.append(wrap);
  }
  syncSeedFields();
}

// Seed fields only matter when the seed isn't random.
function syncSeedFields() {
  const random = $('#optSeedMode').value === 'random';
  $$('#samplerCtl .sp-field[data-kind="seed"]').forEach(f => {
    const input = $('input', f);
    input.disabled = random;
    f.title = random ? 'A new random seed is used every render' : '';
    f.classList.toggle('edited', !random && input.value !== f.dataset.original);
  });
}
$('#optSeedMode').addEventListener('change', syncSeedFields);

function readOverrides() {
  const out = {};
  for (const f of $$('#samplerCtl .sp-field')) {
    const input = $('input, select', f);
    if (input.disabled) continue;
    if (f.dataset.kind === 'seed') continue; // the seed is the seed mode's value, saved with the options
    if (String(input.value) === f.dataset.original) continue;
    out[f.dataset.key] = f.dataset.kind === 'sampler' || f.dataset.kind === 'scheduler' ? input.value : Number(input.value);
  }
  return out;
}
const parseTarget = v => (v ? { node: v.slice(0, v.lastIndexOf('|')), input: v.slice(v.lastIndexOf('|') + 1) } : null);

function optionLabel(c) {
  let extra = '';
  if (typeof c.value === 'string' && c.value) extra = ` — “${c.value.slice(0, 42)}${c.value.length > 42 ? '…' : ''}”`;
  else if (typeof c.value === 'number') extra = ` (${c.value})`;
  return `${c.label}${extra}`;
}

function fillMap(sel, list, current, none = '— leave as the workflow has it —') {
  const opts = list.slice();
  if (current && !opts.some(c => c.node === current.node && c.input === current.input)) opts.unshift({ ...current, label: `#${current.node} → ${current.input}` });
  sel.innerHTML = `<option value="">${esc(none)}</option>${opts.map(c => `<option value="${esc(targetKey(c))}">${esc(optionLabel(c))}</option>`).join('')}`;
  sel.value = targetKey(current);
}

function addPromptRow(current) {
  const row = document.createElement('div');
  row.className = 'map-multi';
  const first = !$('#mapPrompt .map-multi');
  row.innerHTML = `<select aria-label="${first ? 'Prompt goes into' : 'Also send the prompt to'}"></select>${first ? '' : '<button type="button" class="icon-btn" aria-label="Remove">✕</button>'}`;
  fillMap($('select', row), dlg.prepared.candidates.text, current, first ? '— pick where the prompt goes —' : '— pick an input —');
  $('button', row)?.addEventListener('click', () => row.remove());
  const add = $('#mapPrompt .map-add');
  if (add) add.before(row); else $('#mapPrompt').append(row);
}

function showSetup(data) {
  dlg.prepared = data;
  $('#wfPick').hidden = true;
  $('#wfSetup').hidden = false;
  $('#wfBack').hidden = Boolean(dlg.editId);
  $('#wfSave').hidden = false;
  $('#wfSave').textContent = dlg.editId ? 'Save changes' : 'Save workflow';
  $('#wfName').value = data.name || '';
  $('#wfWarnings').innerHTML = (data.warnings || []).map(w => `<p class="wf-warn">⚠️ ${esc(w)}</p>`).join('');
  const c = data.candidates;
  const m = data.mapping;
  $('#mapPrompt').innerHTML = '<button type="button" class="btn small map-add">＋ Also send the prompt to…</button>';
  $('#mapPrompt .map-add').addEventListener('click', () => addPromptRow(null));
  (m.prompt?.length ? m.prompt : [null]).forEach(t => addPromptRow(t));
  if (!c.text.length) $('#wfWarnings').insertAdjacentHTML('beforeend', '<p class="wf-warn">⚠️ This workflow has no text input to put a prompt into. It can\'t be used for rendering prompts.</p>');
  fillMap($('#mapImage'), c.image, m.image);
  fillMap($('#mapMotion'), c.motion || [], m.motion?.[0] || null);
  fillMap($('#mapVideo'), c.video || [], m.video || null);
  fillMap($('#mapWidth'), c.width, m.width);
  fillMap($('#mapHeight'), c.height, m.height);
  fillMap($('#mapAspect'), c.aspect, m.aspect);
  fillMap($('#mapSeconds'), c.seconds, m.seconds);
  fillMap($('#mapFrames'), c.frames, m.frames);
  fillMap($('#mapFps'), c.fps, m.fps);
  $('#optSnap').value = String(data.options.snap);
  $('#optFps').value = data.options.fps;
  $('#optFrameRule').value = data.options.frameRule;
  $('#optSeedMode').value = data.options.seedMode || (data.options.randomizeSeed === false ? 'fixed' : 'random');
  $('#optSeedLabel').textContent = c.seed.length ? `${c.seed.length} seed input${c.seed.length > 1 ? 's' : ''}` : 'This workflow has no seed input';
  $('#optSeedMode').disabled = !c.seed.length;
  renderSamplerControls(data);
  // Only show what this workflow can actually take; name the rest.
  const rows = [
    ['#rowMotion', 'a motion prompt', c.motion?.length || m.motion?.length],
    ['#rowImage', 'an input image', c.image.length || m.image],
    ['#rowVideo', 'a motion video', c.video?.length || m.video],
    ['#rowSize', 'a size', c.width.length || c.height.length || c.aspect.length || m.width || m.aspect],
    ['#rowDuration', 'a duration', c.seconds.length || c.frames.length || m.seconds || m.frames],
    ['#rowSeed', 'sampler settings', c.seed.length || (c.params || []).length],
  ];
  const missing = [];
  const motionModel = Boolean(modelById(dlg.modelId || data.modelId)?.motionVideo);
  for (const [sel, what, has] of rows) {
    const motionRow = sel === '#rowMotion' || sel === '#rowVideo';
    $(sel).hidden = motionRow && !has && !motionModel; // only character animation cares
    $(sel).classList.toggle('unused', !has);
    if (!has && !$(sel).hidden) missing.push(what);
  }
  $('#mapMissing').hidden = !missing.length;
  $('#mapMissing').textContent = missing.length ? `Not in this workflow: ${missing.join(', ')}. Those stay as the workflow has them.` : '';
  $('#wfName').focus();
}

$('#wfSave').addEventListener('click', async () => {
  const data = dlg.prepared;
  const prompt = $$('#mapPrompt select').map(s => parseTarget(s.value)).filter(Boolean);
  if (!prompt.length) return wfToast('Pick where the prompt goes first.');
  const mapping = {
    prompt,
    motion: [parseTarget($('#mapMotion').value)].filter(Boolean),
    image: parseTarget($('#mapImage').value),
    video: parseTarget($('#mapVideo').value),
    width: parseTarget($('#mapWidth').value),
    height: parseTarget($('#mapHeight').value),
    aspect: parseTarget($('#mapAspect').value),
    seconds: parseTarget($('#mapSeconds').value),
    frames: parseTarget($('#mapFrames').value),
    fps: parseTarget($('#mapFps').value),
    seed: data.candidates.seed.map(t => ({ node: t.node, input: t.input })),
  };
  const seedField = $('#samplerCtl .sp-field[data-kind="seed"] input');
  const options = { snap: Number($('#optSnap').value), fps: Number($('#optFps').value) || 24, frameRule: $('#optFrameRule').value, seedMode: $('#optSeedMode').value, ...(seedField && $('#optSeedMode').value !== 'random' ? { seed: Number(seedField.value) } : {}) };
  const name = $('#wfName').value.trim() || data.name;
  try {
    const overrides = readOverrides();
    if (dlg.editId) await api(`/api/workflows/${dlg.editId}`, { method: 'PUT', body: { name, mapping, options, overrides } });
    else {
      const added = await api('/api/workflows', { method: 'POST', body: { modelId: dlg.modelId, name, source: data.source, sourceModified: data.sourceModified, prompt: data.prompt, models: data.models || [], mapping, options, overrides } });
      saved.set(`wf.${dlg.modelId}`, added.id); // a workflow you just added is the one you want next
    }
    $('#wfDialog').close();
    await loadWorkflows();
    toast(dlg.editId ? '💾 Workflow updated' : `🎨 “${name}” is ready: hit ▶ Render on any take`);
    loadComfyStatus();
  } catch (err) {
    wfToast(err.message);
  }
});

function wfToast(msg) {
  const w = $('#wfWarnings');
  w.querySelector('.wf-err')?.remove();
  w.insertAdjacentHTML('afterbegin', `<p class="wf-warn wf-err">✋ ${esc(msg)}</p>`);
  w.scrollIntoView({ block: 'nearest' });
}

$('#addWorkflowBtn').addEventListener('click', () => openWorkflowDialog({ modelId: state.editId }));

// Settings: ComfyUI connection test.
$('#sComfyTest').addEventListener('click', async () => {
  const out = $('#sComfyResult');
  out.hidden = false;
  out.className = 'test-result';
  out.textContent = 'Testing…';
  const res = await api(`/api/comfy/status?url=${encodeURIComponent($('#sComfyUrl').value.trim())}`).catch(err => ({ ok: false, error: err.message }));
  out.className = `test-result ${res.ok ? 'ok' : 'bad'}`;
  out.textContent = res.ok
    ? `✓ Connected to ComfyUI ${res.version}${res.gpu ? ` on ${res.gpu}` : ''}${res.vramTotal ? ` (${Math.round(res.vramTotal / 2 ** 30)} GB)` : ''}.`
    : `✗ ${res.error}`;
});

// ---------- the assistant (✦ Ask) ----------
// Chat with the Brain, which can look at and use the app through tools. The tools run here, through the same
// functions the buttons use, so everything it does shows up on screen. The conversation lives in the data folder.

const as = { messages: [], loaded: false, busy: false, stopped: false, controller: null, running: null, live: null };

const T = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const S = description => ({ type: 'string', description });
const N = description => ({ type: 'number', description });
const I = description => ({ type: 'integer', description });
const B = description => ({ type: 'boolean', description });
const E = (values, description) => ({ type: 'string', enum: values, description });

// The tools a job's steps can use: the ones that set up Create and make things (nothing that deletes or asks).
const JOB_TOOLS = new Set(['set_model', 'set_theme', 'set_dials', 'use_image', 'set_image_role', 'clear_image', 'use_motion_video', 'clear_motion_video', 'edit_motion_video', 'character_from_render', 'pick_workflow', 'add_lora', 'set_lora', 'remove_lora', 'set_seed', 'set_auto_render', 'new_session', 'generate', 'refine_take', 'render', 'animate_render', 'build_chain', 'clear_chain', 'load_chain', 'continue_chain', 'favorite_render', 'favorite_entry']);

const TOOLS = [
  T('get_state', 'What is on the Create page right now: model, theme, image, dials, workflow, LoRAs, chain, takes on screen, ComfyUI status.'),
  T('list_models', 'The target models (image and video) with their aspect ratios, resolutions and durations.'),
  T('list_workflows', 'The ComfyUI workflows of a model, and which one is picked.', { model: S('Model name; default: the current model') }),
  T('list_loras', 'The LoRAs available for a model (from its LoRA folder) and the ones in use on the picked workflow.', { model: S('Model name; default: the current model'), search: S('Words to filter by') }),
  T('read_guide', 'Look up how something in Prompt Maker works, in its user guide. Use it before answering how-to questions.', { topic: S('What to look up, e.g. "LoRAs" or "animate a still"') }, ['topic']),
  T('search_history', 'Find earlier prompts in History by words in their theme or text.', { query: S('Words to look for'), limit: I('How many, up to 10') }, ['query']),
  T('read_take', 'The full text of a take on screen, and its renders.', { take: I('Take number, starting at 1') }, ['take']),
  T('set_model', 'Pick the target model on Create.', { model: S('Model name, e.g. "LTX 2.3"') }, ['model']),
  T('set_theme', 'Write the theme in step 2: what the shot shows, or what happens (when animating an image).', { text: S('The theme') }, ['text']),
  T('set_dials', 'Set step 4 dials. Only the ones given change.', { aspect: S('e.g. "16:9", "9:16"'), resolution: S('e.g. "1920×1080"'), duration: S('Video only, e.g. "6s"'), length: E(['short', 'medium', 'long'], 'Prompt length'), takes: I('How many versions to write, 1–4'), temperature: N('0 = precise … 2 = wild'), batch: S('What Generate runs: the name of a saved batch, "all" (every batch, one after another) or "off"') }),
  T('set_image_role', 'How the image in step 3 is used.', { role: E(['reference', 'recreate', 'animate', 'character'], 'animate = first frame of a video (video models only); character = the character a motion video animates (character-animation models like Wan Animate 2 only)') }, ['role']),
  T('clear_image', 'Remove the image from step 3.'),
  T('use_motion_video', 'Set the motion video in step 3 for a character-animation model (Wan Animate 2): the character copies its moves. From a folder (list_folder lists videos too), or a video render (take and render; or the one in the lightbox when neither is given). Switches to that model if needed.', { folder: S('The folder, as list_folder took it'), file: S('The video file name, from list_folder'), take: I('Take number of a video render'), render: I('1 = newest render of that take') }),
  T('clear_motion_video', 'Remove the motion video from step 3.'),
  T('edit_motion_video', 'Change the motion video in step 3 (needs ffmpeg; each makes a copy and uses it): use only part of it (start and seconds, e.g. the stretch the workflow animates), crop the black bars around its picture, or make a 24 fps copy of a fast one.', { start: N('Use part of it: seconds from its start'), seconds: N('Use part of it: how many seconds'), crop_bars: B('Crop the black bars around the picture'), fps24: B('Make a 24 fps copy') }),
  T('character_from_render', 'Make a still render the character for Wan Animate 2: switches to that model and attaches the still. Then set a motion video (use_motion_video) and a theme for the place and camera, and generate.', { take: I('Take number; default 1'), render: I('1 = newest render of that take') }),
  T('pick_workflow', 'Pick the ComfyUI workflow that renders the takes (step 5).', { name: S('Workflow name') }, ['name']),
  T('add_lora', 'Add a LoRA (from the model\'s LoRA folder) to the picked workflow.', { name: S('LoRA name or part of it'), strength: N('Strength, usually 0.3–1.2; default 1') }, ['name']),
  T('set_lora', 'Change a LoRA\'s strength or switch it on or off (the workflow\'s own LoRAs or added ones).', { name: S('LoRA name or part of it'), strength: N('New strength'), on: B('On or off') }, ['name']),
  T('remove_lora', 'Remove a LoRA that was added (the workflow\'s own LoRAs can only be switched off).', { name: S('LoRA name or part of it') }, ['name']),
  T('set_seed', 'Set how the picked workflow seeds each render: random, fixed, increment (+1 each render) or decrement (−1), and/or the seed number.', { mode: E(['random', 'fixed', 'increment', 'decrement'], 'Seed mode'), value: I('The seed (the next one, for increment / decrement)') }),
  T('set_auto_render', 'Turn auto-render on or off for the current model (renders every new prompt right away).', { on: B('On or off') }, ['on']),
  T('new_session', 'Clear the theme, image and takes to start fresh. Everything stays in History.'),
  T('generate', 'Write the takes for the current setup (or run the chain if one is built in step 6). Waits until they are written.'),
  T('refine_take', 'Change a take with an instruction, e.g. "golden hour" or "shorter".', { take: I('Take number, starting at 1'), instruction: S('What to change') }, ['take', 'instruction']),
  T('render', 'Render takes with ComfyUI and wait for the result.', { take: I('Take number; leave out to render every take'), count: I('Renders per take, 1–50; default 1') }),
  T('animate_render', 'Make a still render the first frame of a video: switches to the video model and attaches the still. Then use set_theme for what happens, and generate.', { take: I('Take number; default 1'), render: I('1 = newest render of that take') }),
  T('build_chain', 'Set the steps after step 1 in step 6 (replaces any there). Each step continues from the renders of the step before.', {
    steps: { type: 'array', description: 'The Then steps, in order', items: { type: 'object', properties: { model: S('Model name'), use: E(['animate', 'reference', 'recreate', 'character'], 'How it uses the image; animate = first frame; character = Wan Animate 2 (uses the motion video in step 3)'), what_happens: S('Optional direction'), workflow: S('Optional workflow name'), takes: I('1–4'), renders: I('1–4'), duration: S('Video only, e.g. "6s"'), gate: E(['pick', 'auto'], 'pick = wait for the user to choose renders; auto = all go on') }, required: ['model'] } },
  }, ['steps']),
  T('clear_chain', 'Remove every step from step 6, back to a single step.'),
  T('load_chain', 'Load a saved chain by name.', { name: S('Chain name') }, ['name']),
  T('continue_chain', 'In a chain run that is waiting, send renders on to the next step.', { takes: { type: 'array', items: { type: 'integer' }, description: 'Take numbers whose renders go on; leave out for all of them' } }),
  T('read_playbook', 'Read a model\'s playbook: its instructions for the Brain, description, aspect ratios, resolutions, durations, length targets and example prompts.', { model: S('Model name; default: the current model') }),
  T('edit_playbook', 'Change a model\'s playbook and save it (the user can undo). Only the fields given change. Use it when the user asks you to write, fix or fill in a playbook.', {
    model: S('Model name; default: the current model'),
    instructions: S('The full new instructions (markdown), replacing the old ones'),
    description: S('One line shown under the model picker'),
    aspect_ratios: { type: 'array', items: { type: 'string' }, description: 'e.g. ["1:1", "16:9", "9:16"]' },
    resolutions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["1024×1024", "1920×1080"]' },
    durations: { type: 'array', items: { type: 'string' }, description: 'Video only, e.g. ["5s", "10s"]' },
    length_guide: { type: 'object', properties: { short: S('e.g. "≈40–70 words"'), medium: S('…'), long: S('…') }, description: 'What short, medium and long mean' },
    add_examples: { type: 'array', items: { type: 'string' }, description: 'Complete example prompts to add' },
  }),
  T('undo_playbook_edit', 'Put back the playbook as it was before your last edit_playbook.'),
  T('go_to', 'Open a page of the app.', { page: E(['create', 'history', 'gallery', 'models', 'settings'], 'The page') }, ['page']),
  T('open_history', 'Open an earlier prompt from History on the Create page.', { query: S('Words from its theme or text') }, ['query']),
  T('look_at', 'See renders (images, or frames of videos) or the input image with your own eyes. Use it whenever the user asks about how something looks, which one is better, what to change. Renders are numbered per take, 1 = newest.', {
    what: E(['takes', 'lightbox', 'input_image', 'earlier_runs', 'gallery'], 'takes (default): renders of the takes on screen; lightbox: what is open full screen; input_image: the image in step 3; earlier_runs: the runs above the new one; gallery: the newest renders anywhere'),
    take: I('Only this take'),
    renders: { type: 'array', items: { type: 'integer' }, description: 'Only these renders of the take (1 = newest)' },
    limit: I('At most this many pictures, up to 8; default 6'),
  }),
  T('show_render', 'Open a render full screen in the lightbox for the user.', { take: I('Take number; default 1'), render: I('1 = newest render of that take') }),
  T('close_lightbox', 'Close the full-screen lightbox.'),
  T('favorite_render', 'Mark a render as a favorite (♥, shown in Gallery → Favorites), or unmark it. Default: the one in the lightbox.', { take: I('Take number'), render: I('1 = newest render of that take'), on: B('true = favorite (default), false = not') }),
  T('favorite_entry', 'Star (★) the prompt on screen in History, or unstar it.', { on: B('true = star (default), false = unstar') }),
  T('delete_render', 'Delete a render for good (asks the user to confirm on screen). Default: the one in the lightbox. Only when the user asked.', { take: I('Take number'), render: I('1 = newest render of that take') }),
  T('delete_entry', 'Delete a prompt from History for good, with its renders (asks the user to confirm on screen). Default: the one on screen. Only when the user asked.', { query: S('Words from its theme or text; default: the one on screen') }),
  T('cancel_renders', 'Cancel renders in progress (🎨 Rendering): those of one take on screen, or all.', { take: I('Take number on screen; leave out for every render') }),
  T('set_brain', 'Switch the Brain (the LLM in the top bar) that writes prompts and runs you. A ☁️ cloud Brain asks the user first.', { name: S('Brain name or part of it') }, ['name']),
  T('list_folder', 'List the pictures (and videos) in a folder on this computer (for a job, use_image or use_motion_video). A bare name is looked for in the home folder, Pictures, Desktop, Downloads and Documents.', { folder: S('Full path, ~/…, or just the folder name') }, ['folder']),
  T('use_image', 'Put a picture from a folder into step 3.', { folder: S('The folder, as list_folder took it'), file: S('The file name, from list_folder') }, ['folder', 'file']),
  T('start_job', `Start a long task that runs on its own, step by step, while the user does other things: "for each picture in folder X…", many variations, "skip problems and log them". Use it instead of doing many steps in chat. A job is runs × pictures: with a folder, every run is done for every picture (the picture is put in step 3 first); without one, each run is done once. A run is a list of steps; a step is one of these tools with the same arguments: ${[...JOB_TOOLS].join(', ')}. Steps work on the Create page as it is, and what a step doesn't set carries over (the theme too: set_theme with "" clears it; clear_chain if a chain is built). If a step fails, the rest of that run for that picture is skipped and logged, and the job goes on. Example, "the pictures in ABC, 2 takes each: low then high temperature": folder "ABC", runs [{label:"low temp", steps:[{tool:"set_dials",args:{takes:1,temperature:0.3}},{tool:"generate"}]}, {label:"high temp", steps:[{tool:"set_dials",args:{takes:1,temperature:1.4}},{tool:"generate"}]}].`, {
    title: S('A short name for the job'),
    folder: S('Optional: the folder of pictures to work through'),
    limit: I('Optional: only the first N pictures'),
    runs: { type: 'array', description: 'What to do (for each picture)', items: { type: 'object', properties: { label: S('e.g. "low temp"'), steps: { type: 'array', items: { type: 'object', properties: { tool: E([...JOB_TOOLS], 'The tool'), args: { type: 'object', description: 'Its arguments' } }, required: ['tool'] } } }, required: ['steps'] } },
  }, ['title', 'runs']),
  T('job_status', 'How a job is going, or how it went: done, skipped (with why) and left. Default: the newest job.', { title: S('Words from its title') }),
  T('control_job', 'Pause, resume or stop a job, retry what it skipped, or show the user the Jobs window.', { action: E(['pause', 'resume', 'stop', 'retry_skipped', 'show'], 'pause = after the current item; stop = now'), title: S('Words from its title; default: the newest job') }, ['action']),
  T('change_setting', 'Change a setting.', { setting: E(['adult_content', 'thinking', 'top_p', 'max_tokens', 'comfy_cleanup'], 'adult_content: on/off; thinking: off/low/medium/high/default; top_p: 0–1; max_tokens: 256–32768; comfy_cleanup: delete ComfyUI\'s copy after copying a render'), value: S('The new value, e.g. "on", "off", "high", "0.9"') }, ['setting', 'value']),
];

// What the assistant shows while a tool runs.
const TOOL_RUNNING = {
  generate: 'Writing the takes…', refine_take: 'Refining…', render: 'Rendering…', continue_chain: 'Continuing the chain…', read_guide: 'Reading the guide…',
  search_history: 'Looking through History…', list_loras: 'Looking at the LoRAs…', animate_render: 'Setting up the video…',
  look_at: 'Looking…', cancel_renders: 'Cancelling…', list_folder: 'Looking in the folder…', use_image: 'Opening the picture…', use_motion_video: 'Opening the video…', start_job: 'Starting the job…',
};

// ---- what the assistant can see ----

const THINKING = ['off', 'low', 'medium', 'high', 'default']; // as the server's THINKING_LEVELS
const lightboxItem = () => ($('#lightbox').hidden ? null : lb.items[lb.index] || null);
function describeItem(it) {
  const renders = (it.entry.variations?.[it.index]?.renders || []).slice().reverse();
  const n = renders.findIndex(r => r.id === it.render.id) + 1;
  return { take: it.index + 1, render: n || null, kind: it.file.kind, model: it.entry.modelName, theme: it.entry.theme, seed: it.render.seed ?? null, favorite: Boolean(it.render.favorite) };
}
// A take's renders as lightbox items, newest first (render 1 = newest).
const takeItems = card => takeRenders(card).slice().reverse().flatMap(r => r.files.map(f => ({ entry: state.entry, index: card.index, render: r, file: f })));
function needRender({ take, render }) {
  if (take == null && lightboxItem()) return lightboxItem();
  const card = needCard(take || 1);
  const it = takeItems(card)[(render || 1) - 1];
  if (!it) throw new Error(`Take ${take || 1} has no render ${render || 1}.`);
  return it;
}

// A picture for the Brain: JPEG, at most 768 px. Videos give two frames (start and middle).
function loadInto(el, src) {
  return new Promise((resolve, reject) => {
    el.onerror = () => reject(new Error('Couldn\'t load it.'));
    if (el.tagName === 'IMG') { el.onload = () => resolve(el); el.src = src; return; }
    el.onloadeddata = () => resolve(el);
    el.muted = true;
    el.preload = 'auto';
    el.src = src;
  });
}
function snapshot(el, w, h) {
  const scale = Math.min(1, 768 / Math.max(w, h));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(w * scale) || 1, height: Math.round(h * scale) || 1 });
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
async function picturesOf(src, kind) {
  if (kind !== 'video') {
    const img = await loadInto(new Image(), src);
    return [snapshot(img, img.naturalWidth, img.naturalHeight)];
  }
  const v = await loadInto(document.createElement('video'), src);
  const out = [];
  for (const t of [Math.min(0.1, v.duration / 2), v.duration / 2]) {
    await new Promise(r => { v.onseeked = r; v.currentTime = t; });
    out.push(snapshot(v, v.videoWidth, v.videoHeight));
  }
  v.removeAttribute('src');
  v.load();
  return out;
}

// After a delete, pictures of it the assistant was shown are dropped from the conversation too.
function forgetSeenImages() {
  for (const m of as.messages) {
    if (Array.isArray(m.content)) m.content = m.content.map(p => (p.type === 'image_url' ? { type: 'text', text: '(an image shown earlier)' } : p));
  }
}

// Asks the user on screen, in the conversation (for what can't be undone).
function confirmInChat(question, yes) {
  return new Promise(resolve => {
    as.confirm = { question, yes, resolve };
    renderAssistantLog();
  });
}

function findModel(q) {
  if (!q) return currentModel();
  const s = squash(q);
  return state.models.find(m => m.id === q || squash(m.name) === s)
    || state.models.find(m => squash(m.name).includes(s) || squash(m.id).includes(s) || s.includes(squash(m.id))) || null;
}
function needModel(q) {
  const m = findModel(q);
  if (!m) throw new Error(`There's no model called “${q}”. The models are: ${state.models.map(x => x.name).join(', ')}.`);
  return m;
}
function needCard(n) {
  const card = state.cards[Number(n) - 1];
  if (!card || card.interrupted) throw new Error(state.cards.length ? `There's no take ${n}. There ${state.cards.length === 1 ? 'is 1 take' : `are ${state.cards.length} takes`} on screen.` : 'There are no takes on screen. Generate first.');
  return card;
}
function notBusy() {
  if (lineBusy()) throw new Error(`Something is still running${line.orders.length ? `, with ${line.orders.length} more in line` : ''}. Wait for it, or press Stop.`);
}
const pick = (options, q) => {
  const s = squash(q);
  return options.find(o => o === q) || options.find(o => squash(o) === s) || options.find(o => ratioOf(o) && ratioOf(q) && Math.abs(ratioOf(o) - ratioOf(q)) < 0.01) || null;
};
const stageError = () => (!$('#stageError').hidden && $('#stageError p')?.textContent) || '';

function assistantState() {
  const m = currentModel();
  const flow = activeFlow();
  return {
    page: VIEWS.find(isView),
    brain: selectedLlm()?.name || null,
    model: m && { name: m.name, kind: m.kind, ...(m.motionVideo ? { characterAnimation: true } : {}) },
    theme: $('#theme').value,
    image: state.image ? { role: effectiveRole(), from: state.image.source ? takeLabel(state.image.source) : 'uploaded' } : null,
    ...(m?.motionVideo ? { motion_video: state.video ? { seconds: state.video.seconds, size: `${state.video.width}×${state.video.height}`, fps: state.video.fps || null, ready: Boolean(state.video.file), ...(state.video.bars ? { black_bars: `picture is ${state.video.bars.width}×${state.video.bars.height}` } : {}), workflow_animates: activeFlow()?.motionFrames === 'all' ? 'the whole video' : typeof activeFlow()?.motionFrames === 'number' ? `${activeFlow().motionFrames} frames` : 'unknown' } : null } : {}),
    dials: m && {
      aspect: $('#aspect').value, aspects: m.aspectRatios,
      resolution: $('#resolution').value, resolutions: m.resolutions,
      ...(m.kind === 'video' ? { duration: $('#duration').value, durations: m.durations } : {}),
      length: state.length, takes: state.variations, temperature: Number($('#temperature').value),
    },
    comfyui: state.comfy ? (state.comfy.ok ? 'ready' : 'offline') : 'unknown',
    workflow: flow && { name: flow.name, takesImage: flow.maps.image, ...(flow.maps.video ? { takesMotionVideo: true } : {}), others: workflowsFor(m.id).filter(f => f.id !== flow.id).map(f => f.name), autoRender: saved.get(autoRenderKey(m.id), false) },
    loras: flow ? [...flowLoras(flow).own.map(l => ({ name: loraShort(l.name), strength: l.strength, on: l.on, inWorkflow: true })), ...flowLoras(flow).added.map(l => ({ name: loraShort(l.name), strength: l.strength, on: l.on }))] : [],
    batches: batches().map(b => ({ name: b.name, count: b.count, prompts: b.mode })),
    batch_runs: pickedBatches().map(b => b.name), // what Generate runs: none, one batch, or all in order
    chain: state.chain.steps.length ? state.chain.steps.map(s => ({ model: modelById(s.modelId)?.name, use: s.use, whatHappens: s.direction, gate: s.gate, takes: s.takes })) : null,
    chainRun: state.run ? { status: state.run.status, steps: state.run.entries.length } : null,
    takes: state.entry?.id ? state.cards.filter(c => !c.interrupted).map(c => ({ take: c.index + 1, words: countWords($('.prompt-text', c.el).value), renders: takeRenders(c).length, favorites: takeRenders(c).filter(r => r.favorite).length, text: $('.prompt-text', c.el).value.slice(0, 1500) })) : [],
    lightbox: lightboxItem() ? describeItem(lightboxItem()) : null, // what the user is looking at, full screen
    earlier_runs: state.prev.filter(e => e.id !== state.entry?.id).map(e => ({ theme: e.theme, model: e.modelName, renders: e.variations.reduce((n, v) => n + (v.renders?.length || 0), 0) })),
    rendering_now: rendersNow.map(j => ({ theme: j.theme, model: j.modelName, take: j.index + 1, left: j.count - j.finished, stage: j.stage, pct: j.pct })),
    settings: { adult_content: Boolean(state.settings?.adultContent), thinking: state.settings?.thinking },
    busy: lineBusy(),
    in_line: line.orders.map(o => ({ theme: o.body.theme, model: o.model.name })), // queued Generates, waiting their turn
    line_on_hold: line.held,
    jobs: jobs.list.slice(0, 3).map(j => ({ title: j.title, status: j.status, ...jobCounts(j), ...(j.why ? { why: j.why } : {}) })),
  };
}

async function ensureLoraList() {
  if (!state.loraList || state.loraError) await loadLoraList();
  if (state.loraError) throw new Error(`Couldn't get the LoRA list from ComfyUI: ${state.loraError}`);
}
function findLora(flow, q) {
  const s = squash(q);
  const { own, added } = flowLoras(flow);
  const all = [...own.map(l => ({ l, key: l.key })), ...added.map((l, i) => ({ l, key: `+${i}` }))];
  return all.find(x => squash(loraShort(x.l.name)) === s) || all.find(x => squash(x.l.name).includes(s)) || null;
}

// Saves a playbook the way the Models editor does, and refreshes what's on screen.
async function savePlaybook(model) {
  const saved = await api(`/api/models/${model.id}`, { method: 'PUT', body: model });
  await loadModels();
  if (state.editId === saved.id && !state.dirty) fillModelForm(saved, false);
  return saved;
}

const TOOL_IMPL = {
  look_at: async ({ what = 'takes', take, renders, limit }) => {
    const llm = selectedLlm();
    if (llm && llm.vision === false) throw new Error(`${llm.name} can't see images. Switch the Brain (top bar) to a 👁 vision model, then ask again.`);
    const max = clampInt(limit ?? 6, 1, 8);
    let items = [];
    if (what === 'lightbox') {
      if (!lightboxItem()) throw new Error('Nothing is open in the lightbox.');
      items = [{ it: lightboxItem(), label: 'the render open in the lightbox' }];
    } else if (what === 'input_image') {
      if (!state.image) throw new Error('There\'s no image in step 3.');
      const pics = await picturesOf(state.image.dataUrl || `/images/${encodeURIComponent(state.image.file)}`, 'image');
      return { summary: 'Looked at the input image', pictures: ['the input image (step 3)'], _images: pics.map(url => ({ label: 'the input image', url })) };
    } else if (what === 'earlier_runs') {
      items = state.prev.filter(e => e.id !== state.entry?.id).flatMap((e, run) => e.variations.flatMap((v, index) => (v.renders || []).slice().reverse().flatMap(r => r.files.map(f => ({ it: { entry: e, index, render: r, file: f }, label: `earlier run ${run + 1} (“${(e.theme || 'from an image').slice(0, 40)}”), take ${index + 1}` })))));
    } else if (what === 'gallery') {
      if (!state.history.length) state.history = await api('/api/history');
      items = galleryItems().map(it => ({ it, label: `“${(it.entry.theme || 'from an image').slice(0, 40)}” (${it.entry.modelName})` }));
    } else {
      const cards = take ? [needCard(take)] : state.cards.filter(c => !c.interrupted);
      for (const card of cards) {
        takeItems(card).forEach((it, i) => { if (!renders?.length || renders.includes(i + 1)) items.push({ it, label: `take ${card.index + 1}, render ${i + 1}` }); });
      }
      if (!items.length) throw new Error(take ? `Take ${take} has no renders yet.` : 'There are no renders on screen yet. Render first.');
    }
    const images = [];
    const seen = [];
    for (const { it, label } of items) {
      if (images.length >= max || it.file.kind === 'audio') continue;
      const pics = await picturesOf(`/renders/${encodeURIComponent(it.file.file)}`, it.file.kind).catch(() => []);
      const name = `${label}${it.render.seed != null ? `, seed ${it.render.seed}` : ''}${it.render.favorite ? ', ♥ favorite' : ''}${it.file.kind === 'video' ? ' (video: its start and middle)' : ''}`;
      pics.slice(0, max - images.length).forEach(url => images.push({ label: name, url }));
      seen.push(name);
    }
    if (!images.length) throw new Error('Couldn\'t load any of those.');
    return { summary: `Looked at ${seen.length === 1 ? seen[0] : `${seen.length} renders`}`, pictures: seen, ...(items.length > seen.length ? { not_shown: items.length - seen.length } : {}), _images: images };
  },
  show_render: ({ take, render }) => {
    const card = needCard(take || 1);
    const items = takeItems(card);
    const n = (render || 1) - 1;
    if (!items[n]) throw new Error(`Take ${take || 1} has no render ${render || 1}.`);
    showView('create');
    openLightbox(items, n);
    return { summary: `Showing take ${card.index + 1}, render ${n + 1}` };
  },
  close_lightbox: () => { if (!$('#lightbox').hidden) closeLightbox(); return { summary: 'Closed the lightbox' }; },
  favorite_render: async ({ take, render, on }) => {
    const it = needRender({ take, render });
    const want = on !== false;
    const updated = await api(`/api/history/${it.entry.id}/renders/${it.render.id}`, { method: 'PATCH', body: { favorite: want } });
    forgetRender(updated);
    if (lightboxItem()?.render.id === it.render.id) { lightboxItem().render = updated.variations[it.index].renders.find(r => r.id === it.render.id) || it.render; lbRender(); }
    return { summary: want ? '♥ Marked as a favorite' : 'No longer a favorite' };
  },
  favorite_entry: async ({ on }) => {
    if (!state.entry?.id) throw new Error('There\'s no prompt on screen.');
    const want = on !== false;
    const updated = await api(`/api/history/${state.entry.id}`, { method: 'PATCH', body: { favorite: want } });
    state.entry.favorite = updated.favorite;
    const h = state.history.find(x => x.id === state.entry.id);
    if (h) h.favorite = updated.favorite;
    if (isView('history')) renderHistory();
    return { summary: want ? '★ Starred in History' : 'Unstarred' };
  },
  delete_render: async ({ take, render }) => {
    const it = needRender({ take, render });
    const d = describeItem(it);
    if (!(await confirmInChat(`Delete take ${d.take}'s render ${d.render} for good? Its file goes, here and in ComfyUI.`, '🗑 Delete it'))) return { summary: 'Kept it: the user said no', declined: true };
    await deleteRenderNow(it.entry, it.render);
    return { summary: `Deleted take ${d.take}'s render ${d.render}` };
  },
  delete_entry: async ({ query }) => {
    let entry = state.entry?.id ? state.history.find(e => e.id === state.entry.id) || state.entry : null;
    if (query) {
      const all = await api('/api/history');
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      entry = all.find(x => [x.theme, x.modelName, ...x.variations.map(v => v.versions.at(-1).text)].join(' ').toLowerCase().includes(words.join(' '))) || all.find(x => { const t = [x.theme, x.modelName, ...x.variations.map(v => v.versions.at(-1).text)].join(' ').toLowerCase(); return words.every(w => t.includes(w)); });
    }
    if (!entry) throw new Error(query ? `Nothing in History matches “${query}”.` : 'There\'s no prompt on screen to delete.');
    notBusy();
    const renders = entry.variations.reduce((n, v) => n + (v.renders?.length || 0), 0);
    if (!(await confirmInChat(`Delete “${entry.theme || 'from an image'}” (${entry.modelName}) for good? Its prompts${renders ? ` and ${renders} render${renders > 1 ? 's' : ''}` : ''} go, here and in ComfyUI.`, '🗑 Delete for good'))) return { summary: 'Kept it: the user said no', declined: true };
    const left = await deleteEntryNow(entry);
    return { summary: `Deleted “${entry.theme || 'from an image'}”${left ? `. ${left}` : ''}` };
  },
  cancel_renders: async ({ take }) => {
    const jobs = (await api('/api/renders')).filter(j => take == null || (j.historyId === state.entry?.id && j.index === take - 1));
    if (!jobs.length) throw new Error(take ? `Take ${take} isn't rendering.` : 'Nothing is rendering.');
    await Promise.all(jobs.map(j => api(`/api/runs/${j.runId}/cancel`, { method: 'POST' })));
    pollRenders();
    const n = jobs.reduce((k, j) => k + j.count - j.finished, 0);
    return { summary: `Cancelled ${n} render${n === 1 ? '' : 's'}` };
  },
  set_brain: async ({ name }) => {
    const s = squash(name);
    const m = state.llms.find(x => squash(x.name) === s || x.id === name) || state.llms.find(x => squash(x.name).includes(s) || squash(x.id).includes(s));
    if (!m) throw new Error(`No Brain like “${name}”. The Brains are: ${state.llms.map(x => x.name).slice(0, 20).join(', ')}.`);
    await setBrain(m.id);
    if (state.settings?.llmModel !== m.id) throw new Error(m.cloud ? 'The user didn\'t allow that cloud Brain.' : `Couldn't switch to ${m.name}.`);
    return { summary: `Brain → ${m.cloud ? '☁️ ' : ''}${m.name}`, vision: m.vision !== false };
  },
  change_setting: async ({ setting, value }) => {
    const v = String(value ?? '').trim().toLowerCase();
    const onOff = () => { if (['on', 'true', 'yes', '1'].includes(v)) return true; if (['off', 'false', 'no', '0'].includes(v)) return false; throw new Error(`Say on or off for ${setting}.`); };
    const num = (lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${setting} goes from ${lo} to ${hi}.`); return n; };
    const body = setting === 'adult_content' ? { adultContent: onOff() }
      : setting === 'comfy_cleanup' ? { comfyCleanup: onOff() }
      : setting === 'top_p' ? { topP: num(0, 1) }
      : setting === 'max_tokens' ? { maxTokens: Math.round(num(256, 32768)) }
      : setting === 'thinking' ? (THINKING.includes(v) ? { thinking: v } : (() => { throw new Error(`Thinking is one of: ${THINKING.join(', ')}.`); })())
      : null;
    if (!body) throw new Error(`I can't change “${setting}”.`);
    state.settings = await api('/api/settings', { method: 'PUT', body });
    if (isView('settings') && !state.settingsDirty) renderSettings();
    return { summary: `${setting.replace(/_/g, ' ')} → ${Object.values(body)[0] === true ? 'on' : Object.values(body)[0] === false ? 'off' : Object.values(body)[0]}` };
  },
  read_playbook: async ({ model }) => {
    const m = await api(`/api/models/${needModel(model).id}`);
    return { summary: `Read the ${m.name} playbook`, name: m.name, kind: m.kind, description: m.description, instructions: m.instructions, aspect_ratios: m.aspectRatios, resolutions: m.resolutions, durations: m.durations, length_guide: m.lengthGuide, examples: m.examples };
  },
  edit_playbook: async ({ model, instructions, description, aspect_ratios: aspects, resolutions, durations, length_guide: lengths, add_examples: examples }) => {
    const before = await api(`/api/models/${needModel(model).id}`);
    const next = structuredClone(before);
    const changed = [];
    if (typeof instructions === 'string' && instructions.trim()) { next.instructions = instructions.trim(); changed.push('instructions'); }
    if (typeof description === 'string') { next.description = description.trim(); changed.push('description'); }
    if (Array.isArray(aspects)) { next.aspectRatios = aspects; changed.push('aspect ratios'); }
    if (Array.isArray(resolutions)) { next.resolutions = resolutions; changed.push('resolutions'); }
    if (Array.isArray(durations)) { next.durations = durations; changed.push('durations'); }
    if (lengths && typeof lengths === 'object') { next.lengthGuide = { ...next.lengthGuide, ...lengths }; changed.push('lengths'); }
    if (Array.isArray(examples) && examples.length) { next.examples = [...(next.examples || []), ...examples]; changed.push(`${examples.length} example${examples.length > 1 ? 's' : ''}`); }
    if (!changed.length) throw new Error('Nothing to change: give the new instructions, description, sizes or examples.');
    const saved = await savePlaybook(next);
    as.undoPlaybook = before;
    return { summary: `Saved the ${saved.name} playbook: ${changed.join(', ')}`, saved: changed };
  },
  undo_playbook_edit: async () => {
    if (!as.undoPlaybook) throw new Error('There is no playbook edit to undo.');
    const saved = await savePlaybook(as.undoPlaybook);
    as.undoPlaybook = null;
    return { summary: `Put the ${saved.name} playbook back as it was` };
  },
  list_folder: async ({ folder }) => {
    const f = await api(`/api/folder?path=${encodeURIComponent(folder || '')}`);
    return { summary: `${f.images.length}${f.more ? '+' : ''} picture${f.images.length === 1 ? '' : 's'}${f.videos?.length ? ` and ${f.videos.length} video${f.videos.length === 1 ? '' : 's'}` : ''} in ${f.shown}`, folder: f.shown, pictures: f.images.slice(0, 200).map(i => i.name), ...(f.images.length > 200 || f.more ? { more: f.images.length - 200 + f.more } : {}), ...(f.videos?.length ? { videos: f.videos } : {}), subfolders: f.folders };
  },
  use_image: async ({ folder, file, path }) => {
    const q = path ? `path=${encodeURIComponent(path)}` : `folder=${encodeURIComponent(folder || '')}&name=${encodeURIComponent(file || '')}`;
    const res = await fetch(`/api/folder/image?${q}`).catch(err => { throw new Error(friendly(err)); });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Couldn't open ${file || path}.`);
    const name = file || String(path).split(/[/\\]/).pop();
    const blob = await res.blob();
    const before = state.image;
    await loadImageFile(new File([blob], name, { type: blob.type || 'image/png' }), { quiet: true });
    if (state.image === before || !state.image?.file) throw new Error(`Couldn't use ${name}: it didn't open as a picture.`);
    return { summary: `Image → ${name}` };
  },
  start_job: async ({ title, folder, limit, runs }) => {
    const list = (Array.isArray(runs) ? runs : []).slice(0, 12).map((r, i) => {
      const steps = (Array.isArray(r?.steps) ? r.steps : []).slice(0, 24).map(st => {
        const tool = String(st?.tool || '');
        if (!JOB_TOOLS.has(tool)) throw new Error(`A job step can't use “${tool}”. Steps can use: ${[...JOB_TOOLS].join(', ')}.`);
        let args = st.args ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
        if (tool === 'set_model') needModel(args.model);
        return { tool, args };
      });
      if (!steps.length) throw new Error(`Run ${i + 1} has no steps.`);
      return { label: String(r.label || `Run ${i + 1}`).slice(0, 80), steps };
    });
    if (!list.length) throw new Error('A job needs at least one run with steps.');
    let pics = [null];
    let where = null;
    if (folder) {
      const f = await api(`/api/folder?path=${encodeURIComponent(folder)}`);
      if (!f.images.length) throw new Error(`There are no pictures in ${f.shown}.`);
      pics = f.images.slice(0, limit ? clampInt(limit, 1, 500) : 500);
      where = { path: f.folder, shown: f.shown };
    }
    const units = pics.flatMap(img => list.map((r, run) => ({
      label: [img?.name, list.length > 1 || !img ? r.label : ''].filter(Boolean).join(' · '),
      image: img && { name: img.name, path: img.path }, run, status: 'pending', log: [], entries: [],
    })));
    if (units.length > 1000) throw new Error(`That's ${units.length} items: more than a job takes (1000). Use fewer pictures (limit) or runs.`);
    const asked = [...as.messages].reverse().find(m => m.role === 'user' && !m.auto && typeof m.content === 'string')?.content || '';
    const job = { id: crypto.randomUUID(), title: String(title || 'Job').slice(0, 80), request: asked.slice(0, 600), createdAt: new Date().toISOString(), status: 'queued', folder: where, runs: list, units };
    jobs.list.unshift(job);
    await saveJob(job);
    const waiting = jobs.current && jobs.current !== job;
    runJobs();
    return { summary: `Started the job “${job.title}”: ${units.length} item${units.length === 1 ? '' : 's'}${waiting ? ' (after the one running now)' : ''}. Follow it in 🗂 Jobs`, items: units.length, steps_each: list.map(r => r.steps.length) };
  },
  job_status: ({ title }) => {
    const job = needJob(title);
    const c = jobCounts(job);
    const skipped = job.units.filter(u => u.status === 'skipped');
    return {
      summary: `Job “${job.title}”: ${JOB_STATUS[job.status]}, ${c.done} done, ${c.skipped} skipped, ${c.left} left`,
      status: job.status, ...c, ...(job.why ? { why: job.why } : {}),
      skipped_items: skipped.slice(0, 40).map(u => ({ item: u.label, why: u.error })),
    };
  },
  control_job: ({ action, title }) => {
    const job = needJob(title);
    if (action === 'show') { openJobs(job.id); return { summary: 'Opened 🗂 Jobs' }; }
    jobAction(job, action === 'retry_skipped' ? 'retry' : action);
    return { summary: `Job “${job.title}” → ${action.replace('_', ' ')}` };
  },
  get_state: () => ({ summary: 'Looked at the Create page', ...assistantState() }),
  list_models: () => ({ summary: `${state.models.length} models`, models: state.models.map(m => ({ name: m.name, kind: m.kind, description: m.description, aspects: m.aspectRatios, resolutions: m.resolutions, durations: m.durations })) }),
  list_workflows: ({ model }) => {
    const m = needModel(model);
    const flows = workflowsFor(m.id);
    return { summary: `${flows.length} workflow${flows.length === 1 ? '' : 's'} for ${m.name}`, workflows: flows.map(f => ({ name: f.name, picked: f.id === activeWorkflowId(m.id), takesImage: f.maps.image, loras: loraCount(f) })) };
  },
  list_loras: async ({ model, search }) => {
    const m = needModel(model);
    await ensureLoraList();
    const { folder } = loraFolderFor(m);
    const q = squash(search);
    const available = state.loraList.filter(n => (!folder || loraFolderOf(n) === folder) && (!q || squash(n).includes(q))).map(loraShort);
    const flow = m.id === state.modelId ? activeFlow() : null;
    return { summary: `${available.length} LoRAs for ${m.name}${folder ? ` (${folder}/)` : ''}`, folder, available: available.slice(0, 80), inUse: flow ? assistantState().loras : [] };
  },
  read_guide: async ({ topic }) => {
    const found = await api(`/api/assistant/guide?q=${encodeURIComponent(topic || '')}`);
    return { summary: `Read the guide: ${found.map(f => f.title).join(', ') || 'nothing found'}`, sections: found };
  },
  search_history: async ({ query, limit }) => {
    const all = await api('/api/history');
    state.history = all;
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter(e => { const t = [e.theme, e.modelName, ...e.variations.map(v => v.versions.at(-1).text)].join(' ').toLowerCase(); return words.every(w => t.includes(w)); });
    return { summary: `${hits.length} match${hits.length === 1 ? '' : 'es'} in History`, results: hits.slice(0, Math.min(10, limit || 6)).map(e => ({ when: timeAgo(e.createdAt), model: e.modelName, theme: e.theme, takes: e.variations.length, renders: e.variations.reduce((n, v) => n + (v.renders?.length || 0), 0) })) };
  },
  read_take: ({ take }) => {
    const card = needCard(take);
    return { summary: `Read take ${take}`, text: $('.prompt-text', card.el).value, renders: takeRenders(card).length };
  },
  set_model: ({ model }) => {
    const m = needModel(model);
    showView('create');
    selectModel(m.id);
    return { summary: `Model → ${m.name}` };
  },
  set_theme: ({ text }) => {
    showView('create');
    replaceTheme(String(text || ''), { focus: false });
    return { summary: `Theme → “${String(text).slice(0, 80)}${String(text).length > 80 ? '…' : ''}”` };
  },
  set_dials: args => {
    const m = currentModel();
    const done = [];
    const choose = (key, sel, options, label) => {
      if (args[key] == null || args[key] === '') return;
      const v = pick(options, String(args[key]));
      if (!v) throw new Error(`${m.name} has no ${label} “${args[key]}”. It has: ${options.join(', ')}.`);
      $(sel).value = v;
      done.push(`${label} ${v}`);
    };
    const options = sel => [...$(sel).options].map(o => o.value); // includes the image's own ratio, if any
    choose('aspect', '#aspect', options('#aspect'), 'aspect');
    if (args.aspect) { $('#aspectNote').hidden = true; syncResolution(); }
    choose('resolution', '#resolution', options('#resolution'), 'resolution');
    if (m.kind === 'video') choose('duration', '#duration', m.durations, 'duration');
    if (args.batch) {
      const want = String(args.batch).trim().toLowerCase();
      if (want === 'off' || want === 'none') setBatchPick('');
      else {
        if (!workflowsFor(m.id).length) throw new Error(`A batch renders everything it makes, and ${m.name} has no workflow yet.`);
        if (want === 'all' && batches().length > 1) setBatchPick('*');
        else {
          const b = batches().find(x => x.name.toLowerCase() === want) || batches().find(x => x.name.toLowerCase().includes(want));
          if (!b) throw new Error(`There's no batch “${args.batch}”. ${batches().length ? `The batches are: ${batches().map(x => x.name).join(', ')}.` : 'None are saved yet: make one in step 5 → Batch.'}`);
          setBatchPick(b.id);
        }
      }
      const l = pickedBatches();
      done.push(!l.length ? 'no batch' : l.length > 1 ? `all ${l.length} batches` : `batch “${l[0].name}”`);
    }
    if (['short', 'medium', 'long'].includes(args.length)) { state.length = args.length; setActive($('#lengthSeg'), state.length); done.push(`${args.length} length`); }
    if (args.takes != null) { setVariations(clampInt(args.takes, 1, 4)); done.push(`${state.variations} take${state.variations > 1 ? 's' : ''}`); }
    if (args.temperature != null) { setTemperature(Math.min(2, Math.max(0, Number(args.temperature) || 0))); done.push(`temperature ${Number($('#temperature').value).toFixed(2)}`); }
    savePrefs();
    showView('create');
    return { summary: done.length ? done.join(', ') : 'Nothing to change' };
  },
  set_image_role: ({ role }) => {
    if (!state.image) throw new Error('There\'s no image in step 3.');
    if (role === 'animate' && currentModel()?.kind !== 'video') throw new Error('Animate only works with a video model.');
    if (!rolesFor(currentModel()).includes(role)) throw new Error(`${currentModel()?.name} uses the image only as: ${rolesFor(currentModel()).join(', ')}.`);
    state.imageRole = role;
    saved.set('imageRole', role);
    renderRole();
    return { summary: `Image used as ${USE_LABEL[role] || role}` };
  },
  clear_image: () => { setImage(null); return { summary: 'Image removed' }; },
  use_motion_video: async ({ folder, file, take, render }) => {
    let blob;
    let name;
    if (folder || file) {
      const res = await fetch(`/api/folder/video?folder=${encodeURIComponent(folder || '')}&name=${encodeURIComponent(file || '')}`).catch(err => { throw new Error(friendly(err)); });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Couldn't open ${file}.`);
      blob = await res.blob();
      name = file;
    } else {
      const it = needRender({ take, render });
      if (it.file.kind !== 'video') throw new Error('That render is a still, not a video. Pick a video render, or a video from a folder.');
      blob = await (await fetch(`/renders/${encodeURIComponent(it.file.file)}`)).blob();
      name = it.file.name || it.file.file;
    }
    const before = state.video;
    await loadVideoFile(new File([blob], name, { type: blob.type || '' }), { quiet: true });
    if (state.video === before || !state.video?.file) throw new Error(`Couldn't use ${name}: it didn't open as a video.`);
    return { summary: `Motion video → ${name} (${secsLabel(state.video.seconds || 0)})` };
  },
  clear_motion_video: () => { setVideo(null); return { summary: 'Motion video removed' }; },
  edit_motion_video: async ({ start, seconds, crop_bars: crop, fps24 }) => {
    if (!state.video?.file) throw new Error('There is no motion video in step 3 yet.');
    if (!state.video.ffmpeg) throw new Error('Changing the video needs ffmpeg, which isn\'t installed on this computer.');
    const done = [];
    if (crop) {
      if (!state.video.bars) throw new Error('This video has no black bars to crop.');
      await videoCopy(null, 'crop', null, { quiet: true });
      done.push(`black bars cropped (${state.video.width}×${state.video.height})`);
    }
    if (start != null || seconds != null) {
      const from = Math.max(0, Number(start) || 0);
      const length = Number(seconds) > 0 ? Number(seconds) : (state.video.seconds || 0) - from;
      await videoCopy(null, 'trim', { start: from, seconds: length }, { quiet: true });
      done.push(`${secsLabel(state.video.seconds || length)} from ${secsLabel(from)}`);
    }
    if (fps24) {
      await videoCopy(null, 'retime', null, { quiet: true });
      done.push('24 fps');
    }
    if (!done.length) throw new Error('Say what to change: start and seconds, crop_bars or fps24.');
    return { summary: `Motion video → ${done.join(', ')}` };
  },
  character_from_render: async ({ take, render }) => {
    notBusy();
    const card = needCard(take || 1);
    const items = takeRenders(card).slice().reverse().flatMap(r => r.files.filter(f => f.kind === 'image').map(f => ({ entry: state.entry, index: card.index, render: r, file: f })));
    const it = items[(render || 1) - 1];
    if (!it) throw new Error(`Take ${take || 1} has no still render${render > 1 ? ` number ${render}` : ''}. Render it first.`);
    await continueFrom(it, { animate: false, character: true });
    return { summary: `The still is now the character for ${currentModel()?.name}` };
  },
  pick_workflow: ({ name }) => {
    const m = currentModel();
    const flows = workflowsFor(m.id);
    const s = squash(name);
    const f = flows.find(x => squash(x.name) === s) || flows.find(x => squash(x.name).includes(s));
    if (!f) throw new Error(flows.length ? `${m.name} has no workflow like “${name}”. It has: ${flows.map(x => x.name).join(', ')}.` : `${m.name} has no workflows yet. Add one in step 5 (＋).`);
    pickWorkflow(m.id, f.id);
    return { summary: `Workflow → ${f.name}` };
  },
  add_lora: async ({ name, strength }) => {
    const flow = activeFlow();
    if (!flow) throw new Error('Pick a workflow in step 5 first: LoRAs belong to a workflow.');
    await ensureLoraList();
    const m = currentModel();
    const { folder } = loraFolderFor(m);
    const { own, added } = flowLoras(flow);
    const taken = new Set([...own, ...added].map(l => l.name));
    const pool = state.loraList.filter(n => (!folder || loraFolderOf(n) === folder) && !taken.has(n));
    const s = squash(name);
    const hit = pool.find(n => squash(loraShort(n)) === s) || pool.filter(n => squash(n).includes(s)).sort((a, b) => a.length - b.length)[0];
    if (!hit) {
      const close = pool.filter(n => s.split(/(?=[a-z]{3})/).some(part => squash(n).includes(part.slice(0, 4)))).slice(0, 8).map(loraShort);
      throw new Error(`No LoRA like “${name}” in ${folder ? `${folder}/` : 'ComfyUI'}${close.length ? `. Close ones: ${close.join(', ')}` : ''}.`);
    }
    const v = strengthOf(strength ?? 1);
    flow.loras.added.push({ name: hit, strength: v, on: true });
    saveLoras(flow, { now: true });
    renderLoraPanel();
    return { summary: `Added LoRA ${loraShort(hit)} at ${v.toFixed(2)}` };
  },
  set_lora: ({ name, strength, on }) => {
    const flow = activeFlow();
    const found = flow && findLora(flow, name);
    if (!found) throw new Error(`No LoRA like “${name}” on the picked workflow.`);
    const change = {};
    if (strength != null) change.strength = strengthOf(strength);
    if (on != null) change.on = Boolean(on);
    saveLoras(setLora(found.key, change), { now: true });
    renderLoraPanel();
    const l = found.key.startsWith('+') ? flow.loras.added[Number(found.key.slice(1))] : { ...found.l, ...flow.loras.tweaks[found.key] };
    return { summary: `${loraShort(found.l.name)} → ${l.on === false ? 'off' : Number(l.strength).toFixed(2)}` };
  },
  remove_lora: ({ name }) => {
    const flow = activeFlow();
    const found = flow && findLora(flow, name);
    if (!found) throw new Error(`No LoRA like “${name}” on the picked workflow.`);
    if (!found.key.startsWith('+')) throw new Error(`${loraShort(found.l.name)} is part of the workflow. It can be switched off (set_lora on=false), not removed.`);
    flow.loras.added.splice(Number(found.key.slice(1)), 1);
    saveLoras(flow, { now: true });
    renderLoraPanel();
    return { summary: `Removed LoRA ${loraShort(found.l.name)}` };
  },
  set_seed: async ({ mode, value }) => {
    const flow = activeFlow();
    if (!flow?.seed?.inputs) throw new Error('The picked workflow has no seed to set.');
    const change = {};
    if (['random', 'fixed', 'increment', 'decrement'].includes(mode)) change.mode = mode;
    if (value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0) change.value = Number(value);
    if (!Object.keys(change).length) throw new Error('Give a seed mode or a seed number.');
    await setSeed(flow, change);
    const s = flow.seed;
    return { summary: s.mode === 'random' ? 'Seed → random each render' : `Seed → ${SEED_ICON[s.mode]} ${s.value}` };
  },
  set_auto_render: ({ on }) => {
    const m = currentModel();
    if (!workflowsFor(m.id).length) throw new Error(`${m.name} has no workflow to render with yet.`);
    saved.set(autoRenderKey(m.id), Boolean(on));
    renderWorkflowPicker();
    return { summary: `Auto-render ${on ? 'on' : 'off'} for ${m.name}` };
  },
  new_session: async () => {
    notBusy();
    await newSession();
    return { summary: 'Started a new session' };
  },
  generate: async () => {
    notBusy();
    showView('create');
    const before = state.entry;
    await generate();
    if (!state.entry?.id || state.entry === before) throw new Error(stageError() || 'Nothing was generated.');
    const takes = state.cards.filter(c => !c.interrupted).map(c => ({ take: c.index + 1, text: $('.prompt-text', c.el).value }));
    if (state.run) return { summary: `Chain ${state.run.status === 'done' ? 'done' : state.run.status === 'waiting' ? 'waiting for picks' : 'ran'}`, run: state.run.status, takes };
    const rendered = state.cards.reduce((n, c) => n + takeRenders(c).length, 0);
    return { summary: `Wrote ${takes.length} take${takes.length > 1 ? 's' : ''} for ${state.entry.modelName}${state.entry.batch ? ` (batch “${state.entry.batch}”), rendered ${rendered}` : ''}`, takes };
  },
  refine_take: async ({ take, instruction }) => {
    notBusy();
    const card = needCard(take);
    const ok = await refineCard(card, String(instruction || ''));
    if (!ok) throw new Error(stageError() || 'The refine didn\'t go through.');
    return { summary: `Refined take ${take}: “${instruction}”`, text: $('.prompt-text', card.el).value };
  },
  render: async ({ take, count }) => {
    notBusy();
    const cards = take ? [needCard(take)] : state.cards.filter(c => !c.interrupted);
    if (!cards.length) throw new Error('There are no takes to render. Generate first.');
    if (!cards.every(c => c.rb)) throw new Error(`${currentModel()?.name || 'This model'} has no workflow to render with. Add one in step 5.`);
    const before = cards.reduce((n, c) => n + takeRenders(c).length, 0);
    await Promise.all(cards.map(c => { c.rb.count = clampInt(count ?? 1, 1, BATCH_MAX); return startRender(c); }));
    const made = cards.reduce((n, c) => n + takeRenders(c).length, 0) - before;
    if (!made) throw new Error(stageError() || 'The render didn\'t come back.');
    return { summary: `Rendered ${made} file${made > 1 ? 's' : ''}` };
  },
  animate_render: async ({ take, render }) => {
    notBusy();
    const card = needCard(take || 1);
    const items = takeRenders(card).slice().reverse().flatMap(r => r.files.filter(f => f.kind === 'image').map(f => ({ entry: state.entry, index: card.index, render: r, file: f })));
    const it = items[(render || 1) - 1];
    if (!it) throw new Error(`Take ${take || 1} has no still render${render > 1 ? ` number ${render}` : ''}. Render it first.`);
    await continueFrom(it, { animate: true });
    return { summary: `The still is now the first frame for ${currentModel()?.name}` };
  },
  build_chain: ({ steps }) => {
    const m0 = currentModel();
    if (m0?.kind === 'video') throw new Error('Chains start with an image model in step 1 (a video can\'t feed the next step yet).');
    const list = (Array.isArray(steps) ? steps : []).slice(0, 4).map(st => {
      const m = needModel(st.model);
      const flows = workflowsFor(m.id);
      const wf = st.workflow && (flows.find(f => squash(f.name) === squash(st.workflow)) || flows.find(f => squash(f.name).includes(squash(st.workflow))));
      return thenStep({ modelId: m.id, workflowId: wf?.id, use: st.use, direction: st.what_happens || '', takes: st.takes, renders: st.renders, duration: st.duration, gate: st.gate, open: false });
    });
    if (!list.length) throw new Error('A chain needs at least one step after step 1.');
    state.chain = { ...state.chain, recipeId: null, steps: list };
    saveChainState();
    renderChainEditor();
    showView('create');
    const problems = chainProblems();
    return { summary: `Chain: ${[m0.name, ...list.map(s => modelById(s.modelId).name)].join(' → ')}`, cost: chainCost(), problems: [problems.all, ...problems.steps].filter(Boolean) };
  },
  clear_chain: () => {
    state.chain = { ...state.chain, recipeId: null, steps: [] };
    saveChainState();
    renderChainEditor();
    return { summary: 'Chain cleared' };
  },
  load_chain: ({ name }) => {
    const s = squash(name);
    const r = state.recipes.find(x => squash(x.name) === s) || state.recipes.find(x => squash(x.name).includes(s));
    if (!r) throw new Error(`No saved chain like “${name}”. Saved chains: ${state.recipes.map(x => x.name).join(', ') || 'none'}.`);
    applyRecipe(r, { quiet: true });
    showView('create');
    return { summary: `Loaded the chain “${r.name}”`, cost: chainCost() };
  },
  continue_chain: async ({ takes }) => {
    notBusy();
    const run = state.run;
    if (!run || run.status === 'running') throw new Error('There\'s no chain waiting for picks.');
    const k = focusStep(run);
    if (!runStep(run, k + 1)) throw new Error('That chain has no next step.');
    const outputs = stepOutputs(run, k);
    const items = Array.isArray(takes) && takes.length ? outputs.filter(it => takes.includes(it.index + 1)) : outputs.filter(it => !continuedFrom(run, it));
    if (!items.length) throw new Error('No renders to send on from those takes.');
    await continueWith(run, k, items);
    return { summary: `Sent ${items.length} render${items.length > 1 ? 's' : ''} on: chain ${run.status === 'done' ? 'done' : run.status}` };
  },
  go_to: ({ page }) => { showView(page); return { summary: `Opened ${page[0].toUpperCase()}${page.slice(1)}` }; },
  open_history: async ({ query }) => {
    notBusy();
    const all = await api('/api/history');
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const e = all.find(x => { const t = [x.theme, x.modelName, ...x.variations.map(v => v.versions.at(-1).text)].join(' ').toLowerCase(); return words.every(w => t.includes(w)); });
    if (!e) throw new Error(`Nothing in History matches “${query}”.`);
    await openEntry(e);
    return { summary: `Opened “${e.theme || 'from an image'}” (${e.modelName})` };
  },
};

async function runTool(call) {
  let args = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { error: `The arguments for ${call.name} weren't valid JSON.` };
  }
  const fn = TOOL_IMPL[call.name];
  if (!fn) return { error: `There's no tool called ${call.name}.` };
  if (jobs.current && (JOB_TOOLS.has(call.name) || ['delete_entry', 'open_history'].includes(call.name))) {
    return { error: `The job “${jobs.current.title}” is using the Create page right now. Pause it (control_job) or wait for it.` };
  }
  as.running = TOOL_RUNNING[call.name] || null;
  renderAssistantLog();
  try {
    return { ok: true, ...(await fn(args || {})) };
  } catch (err) {
    return { error: friendly(err) };
  } finally {
    as.running = null;
  }
}

// The conversation as sent to the Brain: no display-only notes, and every tool call answered.
function wireMessages() {
  const out = [];
  for (const m of as.messages) {
    if (m.note) continue;
    out.push(m);
    for (const c of m.tool_calls || []) {
      if (!as.messages.some(x => x.role === 'tool' && x.tool_call_id === c.id)) out.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: 'Stopped by the user.' }) });
    }
  }
  return out;
}

async function askAssistant(text) {
  if (as.busy || !text.trim()) return;
  as.messages.push({ role: 'user', content: text.trim() });
  as.busy = true;
  as.stopped = false;
  syncAssistantBusy();
  renderAssistantLog();
  try {
    for (let round = 0; round < 16 && !as.stopped; round++) {
      let done = null;
      let failed = null;
      as.live = { text: '', thinking: false, status: '' };
      renderAssistantLog();
      as.controller = new AbortController();
      await streamApi('/api/assistant', { messages: wireMessages(), state: assistantState(), tools: TOOLS }, ev => {
        if (ev.type === 'delta') { as.live.text = ev.text; as.live.thinking = ev.thinking; updateLiveBubble(); }
        else if (ev.type === 'status') { as.live.status = ev.text; updateLiveBubble(); }
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') failed = ev.message;
      }, as.controller.signal);
      as.live = null;
      if (failed) throw new Error(failed);
      if (!done) break;
      const calls = done.toolCalls || [];
      as.messages.push({ role: 'assistant', content: done.text || '', ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) } : {}) });
      renderAssistantLog();
      if (!calls.length) break;
      const seen = [];
      for (const c of calls) {
        if (as.stopped) break;
        const { _images, ...result } = await runTool(c);
        if (_images) seen.push(..._images);
        as.messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
        renderAssistantLog();
      }
      // What look_at showed goes to the Brain as pictures (tool results can only be text).
      if (seen.length && !as.stopped) {
        as.messages.push({ role: 'user', auto: true, content: [
          { type: 'text', text: `(Prompt Maker) What you asked to see, in order: ${seen.map((x, i) => `${i + 1}) ${x.label}`).join('; ')}.` },
          ...seen.map(x => ({ type: 'image_url', image_url: { url: x.url } })),
        ] });
        renderAssistantLog();
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') as.messages.push({ role: 'assistant', content: '', note: `⚠️ ${friendly(err)}` });
  }
  as.live = null;
  as.running = null;
  as.busy = false;
  syncAssistantBusy();
  renderAssistantLog();
  api('/api/assistant/chat', { method: 'PUT', body: { messages: as.messages } }).catch(() => {});
}

function stopAssistant() {
  as.stopped = true;
  if (as.confirm) { as.confirm.resolve(false); as.confirm = null; }
  as.controller?.abort();
  if (state.busy || state.chainActive) stop();
}

// Short, safe formatting: paragraphs, bullet lists, **bold** and `code`.
function mdLite(text) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const line of String(text).split('\n')) {
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)/.exec(line);
    if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

const STARTERS = [
  ['👁 Which render is best?', 'Which of these renders do you like best, and why?', true],
  ['🎬 Set up a shot', 'Set up a 16:9 shot of '],
  ['🧬 Add a LoRA', 'Add the  LoRA at 0.6'],
  ['📽️ Animate my last still', 'Turn my newest still into a video'],
  ['❓ How do chains work?', 'How do chains work?', true],
];

function renderAssistantLog() {
  const log = $('#asLog');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const items = [];
  for (const m of as.messages) {
    if (m.role === 'user' && m.auto) {
      const pics = Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : [];
      items.push(`<div class="as-act as-seen">👁 ${pics.length ? pics.map(p => `<img src="${esc(p.image_url.url)}" alt="">`).join('') : 'Looked at the pictures'}</div>`);
    } else if (m.role === 'user') items.push(`<div class="as-msg me">${mdLite(m.content)}</div>`);
    else if (m.role === 'assistant') {
      if (m.note) items.push(`<div class="as-act bad">${esc(m.note)}</div>`);
      else if (m.content) items.push(`<div class="as-msg bot">${mdLite(m.content)}</div>`);
    } else if (m.role === 'tool') {
      let r = {};
      try { r = JSON.parse(m.content); } catch { /* shown as done */ }
      items.push(r.error ? `<div class="as-act bad">⚠️ ${esc(r.error)}</div>` : `<div class="as-act">✓ ${esc(r.summary || 'Done')}</div>`);
    }
  }
  if (!as.messages.length) {
    items.push(`<div class="as-hello"><b>Hi! I'm your creative partner.</b><p>Ask what I think (“which render do you like better?”, “tower or dungeon?”, “what aspect suits this?”), or tell me what to make and I'll run the app: “set up a 9:16 Krea shot of a surfer at golden hour, 2 takes, then render them”.</p>
      <div class="as-starters">${STARTERS.map(([label, text, send], i) => `<button type="button" class="chip-btn" data-starter="${i}">${esc(label)}</button>`).join('')}</div></div>`);
  }
  if (as.confirm) items.push(`<div class="as-confirm" role="group" aria-label="Confirm"><p>${esc(as.confirm.question)}</p><div class="row"><button type="button" class="btn small danger" data-confirm="yes">${esc(as.confirm.yes)}</button><button type="button" class="btn small" data-confirm="no">Keep it</button></div></div>`);
  if (as.running && !as.confirm) items.push(`<div class="as-act live">⏳ ${esc(as.running)}</div>`);
  if (as.live) items.push('<div class="as-msg bot live" id="asLive"></div>');
  log.innerHTML = items.join('');
  updateLiveBubble();
  if (atBottom || as.busy) log.scrollTop = log.scrollHeight;
}

function updateLiveBubble() {
  const el = $('#asLive');
  if (!el || !as.live) return;
  el.innerHTML = as.live.text ? mdLite(as.live.text) : `<p class="as-typing">${esc(as.live.status || (as.live.thinking ? 'Thinking…' : '…'))}</p>`;
  const log = $('#asLog');
  log.scrollTop = log.scrollHeight;
}

function syncAssistantBusy() {
  $('#asSend').hidden = as.busy;
  $('#asStop').hidden = !as.busy;
  $('#asBrain').textContent = selectedLlm()?.name ? `· ${selectedLlm().name}` : '';
}

// The assistant is on by default: its panel opens with the app (on a wide enough screen) and stays as you left it.
async function openAssistant(open = $('#assistant').hidden, { focus = true } = {}) {
  const panel = $('#assistant');
  panel.hidden = !open;
  saved.set('assistantOpen', open);
  document.body.classList.toggle('as-open', open);
  $('#askBtn').setAttribute('aria-expanded', open);
  document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`);
  if (!open) { if (focus) $('#askBtn').focus(); return; }
  syncAssistantBusy();
  if (!as.loaded) {
    as.loaded = true;
    as.messages = (await api('/api/assistant/chat').catch(() => ({ messages: [] }))).messages;
  }
  renderAssistantLog();
  if (focus) $('#asInput').focus();
}

function sendAssistant() {
  const input = $('#asInput');
  const text = input.value;
  if (!text.trim() || as.busy) return;
  input.value = '';
  askAssistant(text);
}

$('#askBtn').addEventListener('click', () => openAssistant());
$('#asClose').addEventListener('click', () => openAssistant(false));
$('#asSend').addEventListener('click', sendAssistant);
$('#asStop').addEventListener('click', stopAssistant);
$('#asClear').addEventListener('click', e => confirmClick(e.currentTarget, '✓?', () => {
  if (as.busy) return;
  as.messages = [];
  renderAssistantLog();
  api('/api/assistant/chat', { method: 'PUT', body: { messages: [] } }).catch(() => {});
}));
$('#asInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAssistant(); }
});
$('#asLog').addEventListener('click', e => {
  const c = e.target.closest('[data-confirm]');
  if (c && as.confirm) {
    const { resolve } = as.confirm;
    as.confirm = null;
    resolve(c.dataset.confirm === 'yes');
    return renderAssistantLog();
  }
  const b = e.target.closest('[data-starter]');
  if (!b) return;
  const [, text, send] = STARTERS[Number(b.dataset.starter)];
  if (send) return askAssistant(text);
  const input = $('#asInput');
  input.value = text;
  input.focus();
  const gap = text.indexOf('  ');
  input.setSelectionRange(gap >= 0 ? gap + 1 : text.length, gap >= 0 ? gap + 1 : text.length);
});
$('#assistant').addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if (as.busy) stopAssistant(); else openAssistant(false);
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openAssistant(); }
});
window.addEventListener('resize', () => document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`));

// ---------- jobs (the assistant's long tasks) ----------
// The assistant plans a job (start_job): runs × pictures, each a list of tool steps. The job runs here, on Create,
// one item after another, through the same tools. Whatever fails is skipped and logged, and the job goes on. The plan
// and log are saved after every step, so a reload loses nothing (the item it was on is marked to check).

const jobs = { list: [], current: null, pause: false, cancel: false, open: new Set(), onlySkipped: new Set() };
const JOB_STATUS = { queued: 'waiting to start', running: 'running', paused: 'paused', done: 'done' };
const JOB_ICON = { pending: '·', running: '⏳', done: '✓', skipped: '⏭' };

function jobCounts(job) {
  const c = { done: 0, skipped: 0, left: 0, total: job.units.length };
  for (const u of job.units) {
    if (u.status === 'done') c.done++;
    else if (u.status === 'skipped') c.skipped++;
    else c.left++;
  }
  return c;
}
function needJob(title) {
  const s = squash(title);
  const job = s ? jobs.list.find(j => squash(j.title).includes(s)) : jobs.list[0];
  if (!job) throw new Error(jobs.list.length ? `No job like “${title}”. The jobs are: ${jobs.list.map(j => j.title).join(', ')}.` : 'There are no jobs yet.');
  return job;
}

function saveJob(job) {
  job.beat = Date.now();
  return api(`/api/jobs/${job.id}`, { method: 'PUT', body: job }).catch(err => toast(`Couldn't save the job's log: ${friendly(err)}`, true));
}

// Boot: a job that was running when the page went away stops at the item it was on (marked to check).
async function loadJobs() {
  const list = await api('/api/jobs').catch(() => null);
  if (!list) return;
  jobs.list = list.map(j => (jobs.current?.id === j.id ? jobs.current : j));
  const stale = jobs.list.filter(j => j.status === 'running' && j !== jobs.current && Date.now() - (j.beat || 0) > 45e3);
  for (const j of stale) {
    for (const u of j.units) if (u.status === 'running') Object.assign(u, { status: 'skipped', error: 'Interrupted: the page was reloaded or closed while this ran. Check what it made, or retry it.', endedAt: new Date().toISOString() });
    j.status = 'paused';
    j.why = 'The page was reloaded or closed while this job ran.';
    saveJob(j);
    toast(`🗂 The job “${j.title}” was interrupted`, false, { label: 'Resume', run: () => jobAction(j, 'resume') });
  }
  // Running in another tab (or the reload was seconds ago): look again once its heartbeat should have come.
  if (jobs.list.some(j => j.status === 'running' && j !== jobs.current)) setTimeout(loadJobs, 50e3);
  drawJobs();
  if (jobs.list.some(j => j.status === 'queued')) runJobs();
}

// One job at a time, oldest first.
async function runJobs() {
  if (jobs.current) return;
  for (;;) {
    const job = jobs.list.filter(j => j.status === 'queued').at(-1);
    if (!job) break;
    jobs.current = job;
    jobs.pause = jobs.cancel = false;
    job.status = 'running';
    job.why = '';
    const beat = setInterval(() => saveJob(job), 15e3);
    try {
      await runJob(job);
    } finally {
      clearInterval(beat);
      jobs.current = null;
      jobs.pause = jobs.cancel = false;
      await saveJob(job);
      drawJobs();
    }
    if (job.status === 'done') {
      const c = jobCounts(job);
      toast(`🗂 Job “${job.title}” done: ${c.done} made${c.skipped ? `, ${c.skipped} skipped` : ''}`, Boolean(c.skipped), { label: 'See the log', run: () => openJobs(job.id) });
    }
  }
}

async function runJob(job) {
  let lastError = '';
  let sameErrors = 0;
  for (;;) {
    if (jobs.cancel || jobs.pause) {
      job.status = 'paused';
      job.why = jobs.cancel ? 'Stopped by you.' : 'Paused by you.';
      return;
    }
    const u = job.units.find(x => x.status === 'pending');
    if (!u) { job.status = 'done'; job.endedAt = new Date().toISOString(); return; }
    Object.assign(u, { status: 'running', error: '', log: [], startedAt: new Date().toISOString() });
    saveJob(job);
    drawJobs();
    try {
      if (u.image) await jobStep(job, u, 'use_image', { path: u.image.path });
      for (const st of job.runs[u.run]?.steps || []) await jobStep(job, u, st.tool, st.args);
      u.status = 'done';
      sameErrors = 0;
    } catch (err) {
      u.status = 'skipped';
      u.error = jobs.cancel ? 'Stopped by you.' : friendly(err);
      // The same failure three times in a row is something to fix (LM Studio down, ComfyUI off…), not to skip past.
      sameErrors = u.error === lastError ? sameErrors + 1 : 1;
      lastError = u.error;
      if (sameErrors >= 3 && !jobs.cancel) {
        u.endedAt = new Date().toISOString();
        job.status = 'paused';
        job.why = `The last 3 items failed the same way: ${u.error} Fix that, then Resume (and Retry the skipped ones).`;
        toast(`🗂 Job “${job.title}” paused: the same problem 3 times`, true, { label: 'See why', run: () => openJobs(job.id) });
        return;
      }
    }
    u.endedAt = new Date().toISOString();
    saveJob(job);
    drawJobs();
  }
}

async function jobStep(job, u, tool, args) {
  // Waits while Create is busy with something else (you, or the assistant, may be generating, or have a line).
  while (lineBusy()) {
    if (jobs.cancel) throw new Error('Stopped by you.');
    await new Promise(r => setTimeout(r, 1000));
  }
  if (jobs.cancel) throw new Error('Stopped by you.');
  u.now = tool;
  drawJobs();
  quietNav = true;
  try {
    const r = await TOOL_IMPL[tool]({ ...(args || {}) });
    u.log.push({ tool, text: r.summary || 'Done' });
    if (['generate', 'refine_take', 'render'].includes(tool) && state.entry?.id && !u.entries.includes(state.entry.id)) u.entries.push(state.entry.id);
  } catch (err) {
    u.log.push({ tool, error: friendly(err) });
    throw err;
  } finally {
    quietNav = false;
    u.now = null;
  }
}

function jobAction(job, action) {
  job = jobs.list.find(j => j.id === job.id) || job; // the list may have been reloaded since
  const mine = jobs.current === job;
  if (action === 'pause') {
    if (!mine) throw new Error('That job isn\'t running.');
    jobs.pause = true;
  } else if (action === 'stop') {
    if (!mine) throw new Error('That job isn\'t running.');
    jobs.cancel = true;
    stop(); // whatever is being written
    // And its renders: the ones of what this item made, and of what's on Create (the job put it there).
    const u = job.units.find(x => x.status === 'running');
    const ids = new Set([...(u?.entries || []), state.entry?.id].filter(Boolean));
    api('/api/renders').then(list => list.filter(j => ids.has(j.historyId)).forEach(j => api(`/api/runs/${j.runId}/cancel`, { method: 'POST' }).catch(() => {}))).catch(() => {});
  } else if (action === 'resume' || action === 'retry') {
    if (action === 'retry') {
      const skipped = job.units.filter(u => u.status === 'skipped');
      if (!skipped.length) throw new Error('Nothing was skipped.');
      for (const u of skipped) Object.assign(u, { status: 'pending', error: '', log: [] });
    }
    if (mine) return drawJobs();
    if (!job.units.some(u => u.status === 'pending')) throw new Error('That job has nothing left to do.');
    job.status = 'queued';
    job.why = '';
    saveJob(job);
    runJobs();
  }
  drawJobs();
}

// The pill (top bar) shows while a job is on, or has a log you haven't seen; the strip on Create while one runs.
function drawJobs() {
  const active = jobs.list.filter(j => j.status !== 'done');
  const unseen = jobs.list.filter(j => j.status === 'done' && !j.seen);
  const btn = $('#jobsBtn');
  btn.hidden = !active.length && !unseen.length;
  const run = jobs.current;
  const c = run && jobCounts(run);
  $('#jobsCount').textContent = run ? `${c.done + c.skipped}/${c.total}` : active.length ? '⏸' : '✓';
  btn.classList.toggle('on', Boolean(run));
  btn.setAttribute('aria-label', run ? `Job running: ${c.done + c.skipped} of ${c.total}. Show jobs` : 'Show jobs');
  $('#asJobs').hidden = !jobs.list.length;
  const bar = $('#jobBar');
  bar.hidden = !run;
  if (run) {
    const u = run.units.find(x => x.status === 'running');
    bar.innerHTML = `<span aria-hidden="true">🗂</span><span class="jb-text">The job <b>${esc(run.title)}</b> is using this page: item ${Math.min(c.total, c.done + c.skipped + 1)} of ${c.total}${u ? ` (${esc(u.label)}${u.now ? `, ${esc(u.now.replace(/_/g, ' '))}` : ''})` : ''}. Changes you make here go into it.</span>
      <button type="button" class="btn small" data-jb="show">Watch</button><button type="button" class="btn small" data-jb="pause"${jobs.pause ? ' disabled' : ''}>${jobs.pause ? 'Pausing after this one…' : '⏸ Pause'}</button>`;
  }
  if ($('#jobsDlg').open) renderJobsList();
}

function jobUnitHtml(job, u, n) {
  const last = u.error || (u.status === 'running' ? (u.now ? `${u.now.replace(/_/g, ' ')}…` : 'Starting…') : u.log.map(l => l.text).join(' · '));
  const thumb = u.image ? `<button type="button" class="ju-thumb" data-ju="view" data-n="${n}" title="Look at ${esc(u.image.name)}"><img src="/api/folder/image?path=${encodeURIComponent(u.image.path)}" alt="" loading="lazy"></button>` : '';
  return `<li class="ju s-${u.status}"><span class="ju-ico" aria-hidden="true">${JOB_ICON[u.status]}</span>${thumb}
    <div class="ju-main"><b>${esc(u.label)}</b>${last ? `<span>${esc(last)}</span>` : ''}</div>
    ${u.entries.length ? `<div class="ju-acts"><button type="button" class="btn small" data-ju="renders" data-n="${n}" title="See what it rendered">👁 View</button><button type="button" class="btn small" data-ju="open" data-n="${n}" title="Open it on Create">↗ Open</button></div>` : ''}</li>`;
}

// Redraws in place: only the log rows that changed are replaced, so pictures don't reload at every step.
function renderJobsList() {
  const box = $('#jobsList');
  if (!jobs.list.length) {
    box.innerHTML = '<p class="muted">No jobs yet. Ask the assistant for something long, for example “use the pictures in ~/Pictures/ABC: 2 takes each, the first at low temperature, the second at high. Skip any problems and log them.”</p>';
    return;
  }
  $$(':scope > :not(.job)', box).forEach(el => el.remove());
  const ids = new Set(jobs.list.map(j => j.id));
  $$('.job', box).forEach(el => { if (!ids.has(el.dataset.id)) el.remove(); });
  jobs.list.forEach((job, i) => {
    let el = $(`.job[data-id="${CSS.escape(job.id)}"]`, box);
    if (!el) {
      el = document.createElement('section');
      el.className = 'job';
      el.dataset.id = job.id;
      el.innerHTML = `<div class="job-top"></div><details data-job-log${jobs.open.has(job.id) ? ' open' : ''}><summary></summary><label class="job-only" hidden><input type="checkbox" data-job="only"> Only the skipped ones</label><ol class="job-log"></ol></details>`;
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    const c = jobCounts(job);
    const mine = jobs.current === job;
    const pct = c.total ? Math.round(((c.done + c.skipped) / c.total) * 100) : 0;
    const acts = [
      mine && `<button type="button" class="btn small" data-job="pause"${jobs.pause ? ' disabled' : ''}>${jobs.pause ? 'Pausing…' : '⏸ Pause'}</button>`,
      mine && '<button type="button" class="btn small danger" data-job="stop">■ Stop now</button>',
      !mine && job.status !== 'running' && c.left > 0 && `<button type="button" class="btn small primary" data-job="resume"${job.status === 'queued' ? ' disabled' : ''}>${job.status === 'queued' ? 'Waiting to start…' : '▶ Resume'}</button>`,
      c.skipped > 0 && job.status !== 'running' && `<button type="button" class="btn small" data-job="retry" title="Try the skipped items again">↻ Retry ${c.skipped} skipped</button>`,
      !mine && job.status !== 'running' && '<button type="button" class="btn small danger" data-job="remove" title="Remove this job and its log (what it made stays in History)">🗑 Remove</button>',
    ].filter(Boolean).join('');
    el.className = `job s-${job.status}`;
    $('.job-top', el).innerHTML = `<div class="job-head"><b>${esc(job.title)}</b><span class="job-chip">${job.status === 'running' && !mine ? 'running in another tab' : esc(JOB_STATUS[job.status])}</span><span class="spacer"></span><span class="muted small">${esc(timeAgo(job.createdAt))}</span></div>
      ${job.request ? `<p class="job-req">“${esc(job.request)}”</p>` : ''}
      <div class="job-progress" role="progressbar" aria-label="Progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      <p class="small">${c.done} done${c.skipped ? ` · <b class="job-skips">${c.skipped} skipped</b>` : ''}${c.left ? ` · ${c.left} to go` : ''}${job.folder ? ` · 📁 ${esc(job.folder.shown)}` : ''}</p>
      ${job.why ? `<p class="warn-line">${esc(job.why)}</p>` : ''}
      ${acts ? `<div class="job-acts">${acts}</div>` : ''}`;
    $('summary', el).textContent = `Log: ${c.total} item${c.total === 1 ? '' : 's'}`;
    const only = jobs.onlySkipped.has(job.id) && c.skipped > 0;
    $('.job-only', el).hidden = !c.skipped;
    $('.job-only input', el).checked = only;
    const ol = $('.job-log', el);
    const rows = job.units.map((u, n) => [u, n]).filter(([u]) => !only || u.status === 'skipped');
    while (ol.children.length > rows.length) ol.lastElementChild.remove();
    rows.forEach(([u, n], k) => {
      const html = jobUnitHtml(job, u, n);
      const li = ol.children[k];
      if (li?._html === html) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      fresh._html = html;
      if (li) li.replaceWith(fresh); else ol.append(fresh);
    });
  });
}

function openJobs(id) {
  if (id) jobs.open.add(id);
  else if (jobs.list[0]) jobs.open.add(jobs.list[0].id);
  for (const j of jobs.list) if (j.status === 'done' && !j.seen) { j.seen = true; saveJob(j); }
  if (!$('#jobsDlg').open) $('#jobsDlg').showModal();
  renderJobsList();
  drawJobs();
  if (id) $(`.job[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// What a job item made, as lightbox items.
async function jobItems(u) {
  const out = [];
  for (const id of u.entries) {
    const e = await api(`/api/history/${id}`).catch(() => null);
    if (e) e.variations.forEach((v, index) => (v.renders || []).slice().reverse().forEach(r => r.files.forEach(f => out.push({ entry: e, index, render: r, file: f }))));
  }
  return out;
}

$('#jobsBtn').addEventListener('click', () => openJobs());
$('#asJobs').addEventListener('click', () => openJobs());
$('#jobsClose').addEventListener('click', () => $('#jobsDlg').close());
$('#jobBar').addEventListener('click', e => {
  const b = e.target.closest('[data-jb]');
  if (!b || !jobs.current) return;
  if (b.dataset.jb === 'show') openJobs(jobs.current.id);
  else jobAction(jobs.current, 'pause');
});
$('#jobsList').addEventListener('toggle', e => {
  const d = e.target.closest?.('[data-job-log]');
  const id = d?.closest('.job')?.dataset.id;
  if (id) { if (d.open) jobs.open.add(id); else jobs.open.delete(id); }
}, true);
$('#jobsList').addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.closest('.ju-thumb')?.classList.add('broken'); }, true);
$('#jobsList').addEventListener('change', e => {
  if (e.target.dataset.job !== 'only') return;
  const id = e.target.closest('.job').dataset.id;
  if (e.target.checked) jobs.onlySkipped.add(id); else jobs.onlySkipped.delete(id);
  renderJobsList();
});
$('#jobsList').addEventListener('click', async e => {
  const b = e.target.closest('[data-job], [data-ju]');
  if (!b || b.dataset.job === 'only') return;
  const job = jobs.list.find(j => j.id === b.closest('.job').dataset.id);
  if (!job) return;
  if (b.dataset.job === 'remove') {
    return confirmClick(b, 'Sure?', async () => {
      await api(`/api/jobs/${job.id}`, { method: 'DELETE' }).catch(err => toast(friendly(err), true));
      jobs.list = jobs.list.filter(j => j !== job);
      drawJobs();
      renderJobsList();
    });
  }
  if (b.dataset.job) {
    try { jobAction(job, b.dataset.job); } catch (err) { toast(err.message, true); }
    return renderJobsList();
  }
  const u = job.units[Number(b.dataset.n)];
  if (!u) return;
  if (b.dataset.ju === 'view') return openImageView(`/api/folder/image?path=${encodeURIComponent(u.image.path)}`);
  if (b.dataset.ju === 'open') {
    if (jobs.current) return toast('The job is using Create right now. Pause it first, or use 👁 View.', true);
    const entry = await api(`/api/history/${u.entries.at(-1)}`).catch(() => null);
    if (!entry) return toast('That one is no longer in History.', true);
    $('#jobsDlg').close();
    return openEntry(entry);
  }
  const items = await jobItems(u);
  if (!items.length) return toast(`${u.label} wrote ${u.entries.length > 1 ? 'prompts' : 'a prompt'} but has no renders. Use ↗ Open to read ${u.entries.length > 1 ? 'them' : 'it'}.`);
  $('#jobsDlg').close();
  openLightbox(items, 0, { fromGallery: true });
});

// ---------- collapsible panels ----------
// Anything with data-panel="key" folds down to its header plus a one-line summary, by its ▾ button or a click on
// the header. Remembered per panel (takes aren't: they come and go). data-default="collapsed" starts folded.

const panelState = saved.get('panels', {});
const shorten = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const PANEL_SUMMARY = {
  'create-model': () => { const m = currentModel(); return m ? `${m.kind === 'video' ? '🎬' : '📷'} ${m.name}` : ''; },
  'create-theme': () => shorten($('#theme').value.trim()) || 'Nothing yet',
  'create-image': () => {
    const img = state.image ? `🖼️ Image attached · ${effectiveRole()}` : 'No image';
    if (!currentModel()?.motionVideo && !chainNeedsVideo()) return img;
    return `${state.image ? '🧍 Character attached' : 'No character'} · ${state.video ? `🕺 Motion video${state.video.seconds ? ` ${secsLabel(state.video.seconds)}` : ''}` : 'no motion video'}`;
  },
  'create-dials': () => [
    !$('#aspectField').hidden && $('#aspect').value, !$('#resolutionField').hidden && $('#resolution').value,
    !$('#durationField').hidden && $('#duration').value, `${$('#lengthSeg .active')?.textContent.toLowerCase() || ''} length`,
    `${state.variations} take${state.variations > 1 ? 's' : ''}`, `temp ${$('#temperature').value}`,
  ].filter(Boolean).join(' · '),
  'create-render': () => (workflowsFor(state.modelId).length ? `${activeFlow()?.name || ''}${$('#wfpAuto').checked ? ' · ⚡ auto-render' : ''}` : 'No workflow yet'),
  'create-render-adv': () => [
    !$('#wfpSeed').hidden && `🎲 ${$('#wfpSeed [role="radio"].active')?.textContent.trim() || 'seed'}`,
    !$('#wfpDenoise').hidden && `denoise ${$('#wfpDenoise .dn-val')?.textContent || ''}`,
    `🧬 ${$$('#wfpLoras .lora-row:not(.off)').length} LoRA${$$('#wfpLoras .lora-row:not(.off)').length === 1 ? '' : 's'} on`,
  ].filter(Boolean).join(' · '),
  'create-render-batch': () => {
    const l = pickedBatches();
    return !batches().length ? 'No batches yet' : l.length > 1 ? `🎞 All ${l.length} batches, in order` : l.length ? `🎞 ${l[0].name} · ${batchLine(l[0])}` : `Off · ${batches().length} saved`;
  },
  'create-chain': () => (state.chain?.steps?.length > 1 ? `⛓ ${state.chain.steps.length - 1} more step${state.chain.steps.length > 2 ? 's' : ''}` : 'No more steps'),
  take: el => shorten(($('.prompt-text', el)?.value || '').replace(/\s+/g, ' ').trim(), 140),
  'set-services': () => state.services ? `LM Studio ${state.services.lms.running ? 'on' : 'off'} · ComfyUI ${state.services.comfy.running ? 'on' : 'off'}` : '',
  'set-lmstudio': () => $('#sUrl').value,
  'set-cloud': () => (state.providers?.length ? state.providers.map(p => `☁️ ${p.name}`).join(' · ') : 'None: 100% offline'),
  'set-comfy': () => $('#sComfyUrl').value,
  'set-thinking': () => `Thinking ${THINKING_LABELS[$('#sThinking').value] || ''} · max ${$('#sMax').value} tokens`,
  'set-master': () => `${$('#sMaster').value.trim() === (state.settings?.defaultMasterPrompt || '').trim() ? 'Default' : 'Customized'}${$('#sAdult').checked ? ` · 🔞 adult content on${$('#sAdultPrompt').value.trim() === (state.settings?.defaultAdultPrompt || '').trim() ? '' : ' (customized)'}` : ''}`,
  'models-workflows': () => { const n = workflowsFor(state.editId).length; return `${n} workflow${n === 1 ? '' : 's'}`; },
  'models-form': () => `${$('#mKind').value === 'video' ? '🎬' : '📷'} ${$('#mName').value || 'New model'}`,
  'model-basics': () => [$('#mName').value, $('#mKind').value, $('#mDesc').value].filter(Boolean).join(' · '),
  'model-instructions': () => { const t = $('#mInstr').value.trim(); return t ? `${(t.match(/\S+/g) || []).length} words · ${(t.match(/^#{1,3} .*/gm) || []).length} sections` : 'Empty: the Brain writes without a guide'; },
  'model-examples': () => { const n = $$('#examplesList textarea').filter(t => t.value.trim()).length; return n ? `${n} example${n > 1 ? 's' : ''}` : 'None yet'; },
  'model-adult': () => { const n = $$('#adultExamplesList textarea').filter(t => t.value.trim()).length; return n ? `${n} adult example${n > 1 ? 's' : ''}` : 'None'; },
  'model-sizes': () => [$('#mAspects').value, $('#mRes').value, $('#mKind').value === 'video' && $('#mDur').value].filter(Boolean).join(' · ') || 'None set',
  'model-sources': () => { const n = $('#mSources').value.split('\n').filter(x => x.trim()).length; return n ? `${n} source${n > 1 ? 's' : ''}` : 'None'; },
  'models-defaults': () => [$('#dAspect').value, $('#dRes').value, $('#dLen').value, $('#dTemp').value && `temp ${$('#dTemp').value}`].filter(Boolean).join(' · '),
  'models-lengths': () => [$('#lShort').value, $('#lMed').value, $('#lLong').value].filter(Boolean).join(' · '),
};

function decoratePanel(el) {
  if (el._sum) return;
  const head = el.querySelector(':scope > .step-head, :scope > .panel-head, :scope > .take-head, :scope > .wf-head, :scope > .form-head, :scope > h2, :scope > legend');
  if (!head) return;
  head.classList.add('panel-toggle');
  el._btn = Object.assign(document.createElement('button'), { type: 'button', className: 'collapse-btn' });
  (head.querySelector(':scope > .head-actions, :scope > .take-actions, :scope > .form-actions') || head).append(el._btn); // with the header's buttons, so it never wraps alone
  el._sum = Object.assign(document.createElement('p'), { className: 'panel-summary' });
  head.after(el._sum);
  const key = el.dataset.panel;
  setPanel(el, key in panelState ? panelState[key] : el.dataset.default === 'collapsed', false);
}

function setPanel(el, collapsed, remember = true) {
  el.classList.toggle('collapsed', collapsed);
  el._btn.setAttribute('aria-expanded', String(!collapsed));
  el._btn.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
  el._btn.title = collapsed ? 'Expand' : 'Collapse';
  if (remember && el.dataset.panel !== 'take') {
    panelState[el.dataset.panel] = collapsed;
    saved.set('panels', panelState);
  }
  updatePanelSummary(el);
}

function updatePanelSummary(el) {
  if (!el.classList.contains('collapsed')) return;
  try { el._sum.textContent = PANEL_SUMMARY[el.dataset.panel]?.(el) || ''; } catch { el._sum.textContent = ''; }
}
const refreshPanelSummaries = () => $$('[data-panel].collapsed').forEach(updatePanelSummary);
let summaryTimer = null;
const soonRefreshSummaries = () => { clearTimeout(summaryTimer); summaryTimer = setTimeout(refreshPanelSummaries, 120); };
for (const type of ['input', 'change', 'click']) document.addEventListener(type, soonRefreshSummaries, true);

document.addEventListener('click', e => {
  const head = e.target.closest('.panel-toggle');
  if (!head) return;
  // Buttons and fields in a header do their own thing; only the ▾ button or the header itself folds.
  if (!e.target.closest('.collapse-btn') && e.target.closest('button, a, input, select, textarea, label, [role="radio"], [contenteditable]')) return;
  const el = head.parentElement;
  setPanel(el, !el.classList.contains('collapsed'));
});

// ---------- boot ----------

async function loadModels() {
  state.models = await api('/api/models');
  if (!modelById(state.modelId)) state.modelId = state.models[0]?.id || null;
  selectModel(state.modelId);
  renderModelList();
  await refreshHiddenBuiltins();
}

(async function boot() {
  $$('[data-panel]').forEach(decoratePanel);
  try {
    [state.settings, state.models] = await Promise.all([api('/api/settings'), api('/api/models')]);
    state.imageRole = saved.get('imageRole', 'reference');
    const chain = saved.get('chain', null);
    state.batchPick = String(saved.get('batchPick', '') || '');
    if (chain && Array.isArray(chain.steps)) state.chain = { steps: chain.steps.filter(x => x && typeof x === 'object'), renders: clampInt(chain.renders ?? 1, 1, 4), recipeId: chain.recipeId || null };
    selectModel(saved.get('modelId', null));
    renderModelList();
    setVariations(saved.get('variations', 1));
    $('#theme').value = saved.get('theme', '');
    const img = saved.get('image', null);
    if (img && (await api(`/api/images/${encodeURIComponent(img)}`).catch(() => ({}))).exists) setImage({ file: img, source: saved.get('imageSource', null) });
    else saved.set('image', null);
    const vid = saved.get('video', null);
    if (vid?.file && (await api(`/api/videos/${encodeURIComponent(vid.file)}`).catch(() => ({}))).exists) restoreVideo(vid);
    else saved.set('video', null);
    renderRole();
    renderResults(null);
    showView(location.hash.slice(1) || 'create', { push: false });
    history.replaceState(null, '', `#${VIEWS.find(v => isView(v))}`);
    requestAnimationFrame(sizeTheme);
    state.booted = true;
  } catch (err) {
    showError(`Could not start: ${friendly(err)}`);
  }
  api('/api/history').then(h => { state.history = h; restorePrev(h); $('#historyBadge').textContent = h.length; $('#historyBadge').hidden = !h.length; }).catch(() => {});
  loadAutostart();
  loadProviders();
  await Promise.all([loadLlms(), loadWorkflows(), refreshHiddenBuiltins(), loadRecipes()]);
  if (state.workflows.length) await loadComfyStatus();
  await resumeAfterReload();
  pollRenders();
  pollDownloads(); // model downloads keep going through a reload
  loadJobs();
  if (saved.get('assistantOpen', true) && innerWidth >= 1100) await openAssistant(true, { focus: false });
  document.documentElement.dataset.ready = '1';
})();

// Keeps a copy of the page, so it still opens (with a Start button) when Prompt Maker's server is off.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
