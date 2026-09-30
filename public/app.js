// Prompt Maker front end. Plain ES module, no dependencies, talks only to the local server.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// Smooth scrolling, unless the user asked their system for reduced motion.
const scrollMode = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

const state = {
  models: [],
  settings: null,
  llms: [],
  llmOk: null,
  llmError: '',
  modelId: null,
  image: null, // { file } once stored on the server; { dataUrl } while it uploads
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
  workflows: [],
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
    throw new Error(friendly(err));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

// POSTs and reads the server's newline-delimited JSON event stream.
async function streamApi(path, body, onEvent, signal) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${res.status} ${res.statusText}`);
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
function toast(msg, bad = false) {
  const t = $('#toast');
  t.hidden = true;
  void t.offsetWidth; // restart the pop-in animation
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2400);
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

// Sets Aspect to the model's option closest to the attached image's shape.
function matchImageAspect() {
  const m = currentModel();
  const r = state.image?.ratio;
  if (!m || !r) return null;
  let best = null;
  for (const a of m.aspectRatios) {
    const ar = ratioOf(a);
    if (ar && (!best || ratioDist(ar, r) < ratioDist(ratioOf(best), r))) best = a;
  }
  if (!best) return null;
  $('#aspect').value = best;
  syncResolution();
  $('#aspectNote').hidden = false;
  savePrefs();
  return best;
}

// Keeps a W×H resolution in step with the aspect ratio (e.g. 9:16 → 1080×1920, not 1920×1080).
function syncResolution() {
  const m = currentModel();
  const ar = ratioOf($('#aspect').value);
  const sel = $('#resolution');
  if (!m || !ar) return;
  const current = ratioOf(sel.value);
  if (current && ratioDist(current, ar) < 0.05) return;
  const pixels = s => s.split(/[×x]/).reduce((a, b) => a * Number(b), 1);
  const matches = m.resolutions.filter(r => ratioOf(r) && ratioDist(ratioOf(r), ar) < 0.05);
  if (!matches.length) return;
  const target = current ? pixels(sel.value) : pixels(matches[0]);
  matches.sort((a, b) => Math.abs(pixels(a) - target) - Math.abs(pixels(b) - target));
  sel.value = matches[0];
}

// The role actually used: "animate" only exists for video models.
const effectiveRole = () => (state.imageRole === 'animate' && currentModel()?.kind !== 'video' ? 'reference' : state.imageRole);

// ---------- navigation ----------

const VIEWS = ['create', 'history', 'gallery', 'models', 'settings'];
const isView = name => $(`#view-${name}`).classList.contains('active');

// Textareas measured while hidden (or at another width) need re-measuring.
function resizeTextareas() {
  $$('.view.active .prompt-text:not([hidden]), .view.active .example textarea').forEach(autosize);
}
window.addEventListener('resize', resizeTextareas);

function showView(name, { push = true } = {}) {
  if (!VIEWS.includes(name)) name = 'create';
  $$('.tabs button').forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (push && location.hash !== `#${name}`) history.pushState(null, '', `#${name}`);
  if (name === 'history') loadHistory();
  if (name === 'gallery') loadGallery();
  if (name === 'settings' && !state.settingsDirty) renderSettings();
  if (name === 'models' && !state.dirty && (!state.editId || !modelById(state.editId))) {
    if (state.models.length) editModel(state.modelId || state.models[0].id); else newModel();
  }
  requestAnimationFrame(resizeTextareas);
}
window.addEventListener('popstate', () => showView(location.hash.slice(1), { push: false }));
$$('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- LM Studio ("Brain") ----------

let llmLoading = null;
function loadLlms() {
  llmLoading ??= (async () => {
    const res = await api('/api/llms').catch(err => ({ ok: false, error: err.message, models: [] }));
    const cameBack = state.llmOk === false && res.ok;
    state.llmOk = res.ok;
    state.llmError = res.error || '';
    if (res.ok) state.llms = res.models; // offline: keep last-known names for the picker
    renderLlmSelect();
    renderBanner();
    renderVisionWarning();
    if (cameBack) {
      toast('🔌 LM Studio is back');
      if (/LM Studio/.test($('#stageError').textContent)) showError('');
    }
    llmLoading = null;
  })();
  return llmLoading;
}

// While LM Studio is down (or still indexing its models), keep checking so the app catches up on its own.
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
  if (down) $('#bannerLong').textContent = `Nothing is answering at ${state.settings?.lmStudioUrl || 'localhost:1234'}. Start it here, or in LM Studio → Developer. It reconnects on its own.`;
}

function renderLlmSelect() {
  const sel = $('#llmSelect');
  const current = state.settings?.llmModel || '';
  if (!state.llmOk) {
    const known = state.llms.find(m => m.id === current);
    sel.innerHTML = `<option value="${esc(current)}">${current ? esc(known?.name || current) : 'LM Studio offline'}</option>`;
    updateLlmDot();
    return;
  }
  const label = m => `${m.vision ? '👁 ' : ''}${m.name}${m.loaded ? '  · loaded' : ''}`;
  const group = (title, list) => (list.length
    ? `<optgroup label="${esc(title)}">${list.map(m => `<option value="${esc(m.id)}">${esc(label(m))}</option>`).join('')}</optgroup>`
    : '');
  const known = state.llms.some(m => m.id === current);
  sel.innerHTML =
    '<option value="">Auto: whatever is loaded</option>' +
    (current && !known ? `<option value="${esc(current)}">${esc(current)} (missing)</option>` : '') +
    group('Loaded now', state.llms.filter(m => m.loaded)) +
    group('Vision models 👁 (can see images)', state.llms.filter(m => !m.loaded && m.vision)) +
    group('Text-only models', state.llms.filter(m => !m.loaded && !m.vision));
  sel.value = current;
  updateLlmDot();
}

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
}

function renderVisionWarning() {
  const llm = selectedLlm();
  const blind = Boolean(state.image && llm && llm.vision === false);
  const warn = $('#visionWarn');
  warn.hidden = !blind;
  if (blind) warn.textContent = `🙈 ${llm.name} can't see images. Switch the Brain (top right) to a 👁 vision model.`;
}

$('#llmSelect').addEventListener('change', async e => {
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: { llmModel: e.target.value } });
    updateLlmDot();
    renderVisionWarning();
    const m = selectedLlm();
    toast(e.target.value ? `🧠 Brain: ${m?.name || e.target.value}` : '🧠 Brain: auto (uses whatever is loaded)');
  } catch (err) {
    toast(err.message, true);
  }
});
$('#llmRefresh').addEventListener('click', async () => {
  await loadLlms();
  toast(state.llmOk ? `🔄 ${state.llms.length} models found in LM Studio` : '🔌 LM Studio is not reachable', !state.llmOk);
});
$('#bannerRetry').addEventListener('click', async () => {
  await loadLlms();
  if (!state.llmOk) toast('🔌 Still no answer from LM Studio', true);
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
  if (!document.execCommand('insertText', false, text)) {
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
let phIdx = 0;
$('#theme').placeholder = `e.g. ${SURPRISES[0]}…`;
setInterval(() => {
  const t = $('#theme');
  if (t.value) return;
  phIdx = (phIdx + 1) % SURPRISES.length;
  t.placeholder = `e.g. ${SURPRISES[phIdx]}…`;
}, 3500);

function renderModelChips() {
  const grid = $('#modelChips');
  $('#createForm').classList.toggle('no-models', !state.models.length);
  if (!state.models.length) {
    grid.innerHTML = '<div class="model-empty"><p>No target models yet. Add one (or import a <code>.json</code>) to get going.</p><button type="button" class="btn primary small" data-go="models">＋ Add a model</button></div>';
    $('[data-go]', grid).addEventListener('click', () => { showView('models'); newModel(); });
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
  saved.set(prefsKey(m.id), {
    aspectRatio: $('#aspect').value,
    resolution: $('#resolution').value,
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
  if (!m) return;
  const v = { ...m.defaults, ...(values || saved.get(prefsKey(m.id), {})) };
  fillSelect($('#aspect'), m.aspectRatios, v.aspectRatio);
  fillSelect($('#resolution'), m.resolutions, v.resolution);
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
};

function renderRole() {
  const m = currentModel();
  const hasImage = Boolean(state.image);
  const role = effectiveRole();
  $('#roleBlock').hidden = !hasImage;
  $('#roleHint').hidden = !hasImage;
  $('[data-value="animate"]', $('#roleBlock')).hidden = m?.kind !== 'video';
  setActive($('#roleBlock'), role);
  const hasTheme = Boolean($('#theme').value.trim());
  $('#roleHint').textContent = ROLE_HINTS[role][hasTheme ? 0 : 1];
  $('#themeOpt').textContent = hasImage ? 'optional' : '';
  renderVisionWarning();
}

function setVariations(n, { persist = true } = {}) {
  state.variations = n;
  setActive($('#varSeg'), n);
  if (!state.busy) $('#genLabel').textContent = n > 1 ? `Generate ${n} takes` : 'Generate';
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
  saved.set('theme', $('#theme').value);
  if (themeUndo !== null) {
    // Typing after a replacement retires the undo chip (replaceTheme re-arms it right after its own edit).
    themeUndo = null;
    $('#themeUndo').hidden = true;
  }
});

// ---------- create: image ----------

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('🤔 That file isn\'t an image.', true);
  let dataUrl;
  let ratio;
  try {
    const bitmap = await createImageBitmap(file);
    ratio = bitmap.width / bitmap.height;
    const max = 1536;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  } catch {
    return toast('Could not read that image.', true);
  }
  setImage({ dataUrl, ratio });
  const aspect = matchImageAspect();
  // Store it right away: survives reloads and never has to be re-sent.
  try {
    const { file: name } = await api('/api/images', { method: 'POST', body: { image: dataUrl } });
    if (state.image?.dataUrl === dataUrl) {
      state.image = { file: name, dataUrl, ratio };
      saved.set('image', name);
    }
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
    preview.onload = () => { if (state.image === img && !img.ratio) img.ratio = preview.naturalWidth / preview.naturalHeight; };
    preview.src = img.dataUrl || `/images/${img.file}`;
  } else {
    preview.removeAttribute('src');
    $('#aspectNote').hidden = true;
  }
  $('.dz-empty').hidden = Boolean(img);
  $('.dz-preview').hidden = !img;
  $('#dropzone').setAttribute('aria-label', img ? 'Image added' : 'Add an image: drop, paste or browse');
  if (!img) saved.set('image', null);
  else if (img.file) saved.set('image', img.file);
  renderRole();
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
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (file) loadImageFile(file); else toast('🤔 That file isn\'t an image.', true);
});
document.addEventListener('paste', e => {
  if (!isView('create')) return;
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); loadImageFile(file); }
});

// ---------- create: takes (results) ----------

const REFINE_CHIPS = {
  common: [['✂️', 'Shorter'], ['🔍', 'More detailed'], ['🎞️', 'More cinematic'], ['📸', 'More natural & candid'], ['💡', 'Different lighting'], ['📐', 'Different camera angle']],
  video: [['⚡', 'More dynamic motion'], ['🐢', 'Calmer, slower motion'], ['🚁', 'Add camera movement']],
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
  head.innerHTML = `<span class="tag model">${kindIcon(entry.modelKind)} ${esc(entry.modelName)}</span>${tags}
    ${via ? `<span class="via">${running ? 'rolling on' : 'written by'} ${esc(via)}${totalSecs ? ` in ${totalSecs.toFixed(1)}s` : ''}</span>` : ''}
    ${!running && takes > 1 && entry.id && workflowsFor(entry.modelId).length ? `<button type="button" class="btn small" id="renderAllBtn">🎨 Render all ${takes}</button>` : ''}
    ${!running && takes > 1 ? `<button type="button" class="btn small" id="copyAllBtn">📋 Copy all ${takes} takes</button>` : ''}`;
  head.hidden = false;
  $('#renderAllBtn')?.addEventListener('click', () => state.cards.forEach(c => { if (c.rb && !c.interrupted) startRender(c); }));
  $('#copyAllBtn')?.addEventListener('click', e => copyText(takesText(state.cards.filter(c => !c.interrupted).map(c => $('.prompt-text', c.el).value.trim())), e.currentTarget));
}

function createTake(index, count, model) {
  const chips = [...REFINE_CHIPS.common, ...(model?.kind === 'video' ? REFINE_CHIPS.video : [])];
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
  const list = $('#resultsList');
  list.innerHTML = '';
  state.cards = [];
  $('#resultsEmpty').hidden = Boolean(entry);
  renderStageHead(entry, { totalSecs });
  if (!entry) return;
  const model = modelById(entry.modelId);
  entry.variations.forEach((v, i) => {
    const card = createTake(i, entry.variations.length, model);
    state.cards.push(card);
    list.append(card.el);
    showVersion(card, v.versions.length - 1);
  });
  setBusy(state.busy);
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
  $('#generateBtn').disabled = busy;
  $('#genLabel').textContent = busy ? 'Cooking…' : state.variations > 1 ? `Generate ${state.variations} takes` : 'Generate';
  $('#stopBtn').hidden = !busy;
  $$('.take .refine button, .take .refine input, .take .chips button, .take .save-edit, .take .versions button').forEach(el => { el.disabled = busy; });
  if (!busy) state.cards.forEach(c => { if (!c.interrupted && versionsOf(c).length) { $('.prev', c.el).disabled = c.view === 0; $('.next', c.el).disabled = c.view === versionsOf(c).length - 1; } });
  $('#draftBtn').disabled = busy;
}

// Stop asks the server to cancel, so takes that already finished still arrive and are kept.
function stop() {
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

async function generate() {
  if (state.busy) return;
  const m = currentModel();
  const theme = $('#theme').value.trim();
  showError('');
  if (!m) return showError('Pick a target model first. No models? Add one in the Models tab.');
  if (!theme && !state.image) {
    $('#theme').focus();
    return showError('Give me something to work with: type a theme, add an image, or both.');
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
  };

  // Placeholder entry so the stage header and meters work while streaming.
  state.entry = { ...body, modelName: m.name, modelKind: m.kind, variations: [] };
  state.timings = {};
  state.runId = null;
  state.stopping = false;
  $('#resultsEmpty').hidden = true;
  const list = $('#resultsList');
  list.innerHTML = '';
  const count = state.variations;
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
  else if (stopped) toast(savedEntry ? `■ Stopped. Kept ${savedEntry.variations.length} finished take${savedEntry.variations.length > 1 ? 's' : ''}` : '■ Stopped');
  setTitle(failed ? '⚠️ Failed' : document.hidden && savedEntry ? '✓ Done' : '');
  loadLlms(); // a run can load a model or reveal that LM Studio went away
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
    state.timings[card.index] = (performance.now() - t0) / 1000;
    showVersion(card, savedEntry.variations[card.index].versions.length - 1);
    announce(`Refined: ${instruction}`);
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
    showVersion(card, entry.variations[card.index].versions.length - 1);
    if (!quiet) toast('💾 Saved as a new version');
  } catch (err) {
    toast(err.message, true);
  }
}

$('#createForm').addEventListener('submit', e => { e.preventDefault(); generate(); });
$('#stopBtn').addEventListener('click', stop);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && isView('create') && !e.target.closest?.('.take')) {
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
  if (e.key === 'Escape' && state.busy) stop();
});

// ---------- history ----------

function bumpHistoryBadge(delta) {
  const badge = $('#historyBadge');
  const n = Math.max(0, (Number(badge.textContent) || 0) + delta);
  badge.textContent = n;
  badge.hidden = !n;
}

async function loadHistory() {
  try {
    state.history = await api('/api/history');
  } catch (err) {
    toast(err.message, true);
  }
  $('#historyBadge').textContent = state.history.length;
  $('#historyBadge').hidden = !state.history.length;
  renderHistoryFilters();
  renderHistory();
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
    (!q || [e.theme, e.modelName, ...e.variations.flatMap(v => v.versions.map(x => x.text))].join('\n').toLowerCase().includes(q)));
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
      <article class="hcard" data-id="${esc(e.id)}" style="--m:${color}">
        <div class="hthumb hopen${cover || e.imageFile ? '' : ' textonly'}" data-act="open" aria-hidden="true">
          ${cover ? mediaTag(cover, { hover: true }) : e.imageFile ? `<img src="/images/${esc(e.imageFile)}" alt="" loading="lazy">` : kindIcon(e.modelKind)}
          ${cover ? `<span class="tag kind">🎨 ${renderCount} render${renderCount > 1 ? 's' : ''}</span>` : e.imageFile ? `<span class="tag kind">${{ reference: '🎯 reference', recreate: '🪞 recreate', animate: '🎬 animate' }[e.imageRole] || ''}</span>` : ''}
        </div>
        <button type="button" class="hstar${e.favorite ? ' on' : ''}" data-act="fav" aria-pressed="${Boolean(e.favorite)}" aria-label="Favorite: ${esc(title)}" title="${e.favorite ? 'Unfavorite' : 'Favorite'}">${e.favorite ? '★' : '☆'}</button>
        <div class="hbody">
          <div class="hmeta"><span class="tag model">${kindIcon(e.modelKind)} ${esc(e.modelName)}</span><span>${esc(bits.join(' · '))}</span><span>· ${esc(timeAgo(e.createdAt))}</span></div>
          <div class="htheme hopen${e.theme ? '' : ' none'}" data-act="open">${esc(title)}</div>
          <p class="hprompt">${esc(first)}</p>
          <div class="hactions">
            <button type="button" class="btn small" data-act="copy" aria-label="Copy ${takes > 1 ? `all ${takes} takes` : 'prompt'}: ${esc(title)}">${takes > 1 ? `Copy all ${takes}` : 'Copy'}</button>
            <button type="button" class="btn small danger" data-act="delete" aria-label="Delete: ${esc(title)}">Delete</button>
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
      confirmClick(btn, 'Sure?', async () => {
        await api(`/api/history/${id}`, { method: 'DELETE' });
        state.history = state.history.filter(x => x.id !== id);
        if (state.entry?.id === id) renderResults(null);
        bumpHistoryBadge(-1);
        renderHistoryFilters();
        renderHistory();
        toast('🗑️ Deleted');
      });
    } else if (btn.dataset.act === 'open') {
      await openEntry(entry);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

async function openEntry(entry) {
  if (state.busy) return toast('Hold on, a prompt is still cooking. Stop it or wait.', true);
  await flushEdits();
  if (modelById(entry.modelId)) {
    selectModel(entry.modelId, { values: entry });
  } else {
    toast(`Model "${entry.modelName}" no longer exists, so refining is off.`, true);
  }
  if (($('#theme').value || '') !== (entry.theme || '')) replaceTheme(entry.theme || '', { focus: false });
  if (entry.imageRole) state.imageRole = entry.imageRole;
  setImage(entry.imageFile ? { file: entry.imageFile } : null);
  setVariations(entry.variations.length, { persist: false });
  showError('');
  state.timings = {};
  showView('create');
  renderResults(entry);
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

function addExample(text = '') {
  const row = document.createElement('div');
  row.className = 'example';
  row.innerHTML = '<textarea rows="3" aria-label="Example prompt" placeholder="A complete example prompt in this model\'s ideal style"></textarea><button type="button" class="icon-btn" title="Remove example" aria-label="Remove example">✕</button>';
  const ta = $('textarea', row);
  ta.value = text;
  $('button', row).addEventListener('click', () => { row.remove(); markDirty(); });
  ta.addEventListener('input', () => autosize(ta));
  $('#examplesList').append(row);
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
  $('#mAspects').value = m.aspectRatios.join(', ');
  $('#mRes').value = m.resolutions.join(', ');
  $('#mDur').value = m.durations.join(', ');
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
  $('#draftResultWrap').hidden = true;
  $('#draftStatus').textContent = '';
  formMessage('');
  setDirty(isNew && Boolean(m.name));
}

function readModelForm() {
  return {
    id: state.editId || undefined,
    name: $('#mName').value.trim(),
    kind: $('#mKind').value,
    color: $('#mColor').value,
    description: $('#mDesc').value.trim(),
    instructions: $('#mInstr').value,
    examples: $$('#examplesList textarea').map(t => t.value.trim()).filter(Boolean),
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

$('#dupModelBtn').addEventListener('click', () => {
  const copy = readModelForm();
  copy.name = `${copy.name} copy`;
  delete copy.id;
  newModel(copy);
});

$('#exportModelBtn').addEventListener('click', () => {
  const m = modelById(state.editId);
  if (m) { download(`${m.id}.json`, m); toast(`⤒ Exported ${m.id}.json`); }
});
$('#exportAllBtn').addEventListener('click', () => {
  download(`prompt-maker-models-${new Date().toISOString().slice(0, 10)}.json`, state.models);
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
  if (state.dirty || state.settingsDirty || state.busy || state.renderRuns.size || state.cards.some(cardDirty)) e.preventDefault();
});

// ---------- settings ----------

function setSettingsDirty(d) {
  state.settingsDirty = d;
  $('#settingsDirty').hidden = !d;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('#sUrl').value = s.lmStudioUrl;
  $('#sTopP').value = s.topP;
  $('#sMax').value = s.maxTokens;
  $('#sComfyUrl').value = s.comfyUrl || '';
  $('#sComfyResult').hidden = true;
  $('#sThinking').value = s.thinking;
  $('#sMaster').value = s.masterPrompt;
  $('#sDataDir').textContent = s.dataDir ? `📁 Your data lives in ${s.dataDir}` : '';
  $('#sTestResult').hidden = true;
  setSettingsDirty(false);
}

$('#settingsForm').addEventListener('input', () => setSettingsDirty(true));
$('#settingsForm').addEventListener('change', () => setSettingsDirty(true));
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
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: { lmStudioUrl: $('#sUrl').value, comfyUrl: $('#sComfyUrl').value, topP: $('#sTopP').value, maxTokens: $('#sMax').value, thinking: $('#sThinking').value, masterPrompt: $('#sMaster').value },
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

async function loadWorkflows() {
  state.workflows = await api('/api/workflows').catch(() => []);
  renderModelList();
  if (isView('models')) renderWorkflowList();
  state.cards.forEach(c => { if (!c.interrupted && state.entry?.id) renderZone(c); });
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
      if (cameBack) toast('🎨 ComfyUI is connected');
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
  if (file.kind === 'video') return `<video src="${src}" muted loop playsinline preload="metadata"${controls ? ' controls autoplay' : ''}${hover ? ' data-hover' : ''}></video>`;
  if (file.kind === 'audio') return controls ? `<audio src="${src}" controls autoplay></audio>` : '<span aria-hidden="true">🔊</span>';
  return `<img src="${src}" alt="" loading="lazy">`;
}

// Hovering a video tile plays it.
document.addEventListener('mouseover', e => { const v = e.target.closest?.('[data-hover]') || e.target.closest?.('.rtile, .gtile, .hthumb')?.querySelector('video[data-hover]'); if (v) v.play().catch(() => {}); });
document.addEventListener('mouseout', e => { const host = e.target.closest?.('.rtile, .gtile, .hthumb'); const v = host?.querySelector('video[data-hover]'); if (v && !host.contains(e.relatedTarget)) { v.pause(); } });

function renderZone(card) {
  const zone = $('.render-zone', card.el);
  const entry = state.entry;
  if (!zone || !entry?.id || card.interrupted) { if (zone) zone.hidden = true; return; }
  const model = card.model;
  const flows = model ? workflowsFor(model.id) : [];
  zone.hidden = false;
  let bar = '';
  if (flows.length) {
    const remembered = saved.get(`wf.${model.id}`, null);
    card.rb ??= { count: 1, lockSeed: false, lastSeed: null };
    if (!flows.some(f => f.id === card.rb.workflowId)) card.rb.workflowId = flows.some(f => f.id === remembered) ? remembered : flows[0].id;
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
    $('.rb-wf', bar$).addEventListener('change', e => { card.rb.workflowId = e.target.value; saved.set(`wf.${model.id}`, e.target.value); updateSettingsLine(card); });
    $('.rb-tune', bar$).addEventListener('click', async () => {
      try {
        openWorkflowDialog({ edit: await api(`/api/workflows/${card.rb.workflowId}`), focusSampler: true });
      } catch (err) {
        toast(err.message, true);
      }
    });
    updateSettingsLine(card);
    $('.rb-count', bar$).addEventListener('click', e => { const b = e.target.closest('button'); if (b) { card.rb.count = Number(b.dataset.value); setActive($('.rb-count', bar$), card.rb.count); } });
    $('.rb-seed', bar$).addEventListener('click', () => {
      if (!card.rb.lastSeed) return toast('Render once first. Then you can reuse its seed.', true);
      card.rb.lockSeed = !card.rb.lockSeed;
      updateSeedChip(card);
    });
    $('.rb-go', bar$).addEventListener('click', () => startRender(card));
  }
  $('.rh-add', zone)?.addEventListener('click', () => { showView('models'); guardDirty(model.id, () => { editModel(model.id); openWorkflowDialog(); }); });
  $('.rh-x', zone)?.addEventListener('click', () => { saved.set('hideRenderHint', true); state.cards.forEach(renderZone); toast('Tip hidden. Add workflows any time in Models.'); });
  renderTiles(card);
  updateRenderStatus(card);
}

// One line under the render bar: what this workflow will actually use.
function updateSettingsLine(card) {
  const line = $('.rb-settings', card.el);
  const flow = state.workflows.find(f => f.id === card.rb?.workflowId);
  if (!line || !flow) return;
  const s = flow.settings || {};
  const bits = [
    s.sampler && `${s.sampler}${s.scheduler ? ` · ${s.scheduler}` : ''}`,
    s.steps != null && `${s.steps} steps`,
    s.cfg != null && `CFG ${s.cfg}${Number(s.cfg) === 1 ? ' 🔒' : ''}`,
    s.seed != null && (s.seed === 'random' ? 'seed 🎲 random' : `seed ${s.seed}`),
  ].filter(Boolean);
  line.innerHTML = bits.length ? bits.map(b => `<span>${esc(b)}</span>`).join('') : '<span>workflow defaults</span>';
}

function updateSeedChip(card) {
  const chip = $('.rb-seed', card.el);
  if (!chip) return;
  chip.setAttribute('aria-pressed', card.rb.lockSeed);
  chip.textContent = card.rb.lockSeed ? `🔒 Seed ${card.rb.lastSeed}` : '🎲 New seed';
  chip.title = card.rb.lockSeed ? 'Reusing the last seed. Click for a new random seed each render.' : 'A fresh random seed each render. Click to reuse the last one.';
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
  const tiles = items.map((it, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rtile${it.file.kind === 'audio' ? ' audio' : ''}`;
    b.style.setProperty('--ar', ar);
    b.setAttribute('aria-label', `Open render ${n + 1}${it.render.seed != null ? `, seed ${it.render.seed}` : ''}`);
    b.innerHTML = `${mediaTag(it.file, { hover: true })}${it.file.kind === 'video' ? '<span class="rt-kind">▶ video</span>' : ''}<span class="rt-meta">${it.render.seed != null ? `seed ${it.render.seed}` : ''}${it.render.secs ? ` · ${it.render.secs}s` : ''}</span>`;
    b.addEventListener('click', () => openLightbox(items, n));
    return b;
  });
  box.replaceChildren(...card.running.values(), ...tiles);
  box.hidden = !box.children.length;
}

function runningTile(card) {
  const t = document.createElement('div');
  t.className = 'rtile running';
  t.style.setProperty('--ar', ASPECT_CSS(state.entry?.aspectRatio));
  t.innerHTML = '<div class="rt-shimmer"></div><div class="rt-live"><span class="rt-pct">…</span><span class="rt-stage">Waiting for ComfyUI…</span></div><div class="rt-bar"></div><button type="button" class="rt-cancel" aria-label="Cancel render" title="Cancel">✕</button>';
  return t;
}

async function startRender(card) {
  const flow = state.workflows.find(f => f.id === card.rb?.workflowId);
  if (!flow || !state.entry?.id) return;
  if (cardDirty(card)) await saveEdit(card, { quiet: true });
  if (!state.comfy?.ok) await loadComfyStatus();
  if (!state.comfy?.ok) return showError(state.comfy?.error || 'ComfyUI is not reachable.');
  saved.set(`wf.${card.model.id}`, flow.id);
  const count = card.rb.count;
  const controller = new AbortController();
  const run = { controller, runId: null };
  state.renderRuns.add(run);
  const keys = Array.from({ length: count }, (_, i) => `${Date.now()}-${i}`);
  const tiles = keys.map(() => runningTile(card));
  keys.forEach((k, i) => card.running.set(k, tiles[i]));
  // Newest first: the tile for render 1 goes first.
  renderTiles(card);
  const cancelRun = () => {
    if (run.runId) api(`/api/runs/${run.runId}/cancel`, { method: 'POST' }).catch(() => controller.abort());
    else controller.abort();
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
  announce(`Rendering with ${flow.name}`);
  setTitle('🎨 Rendering');
  try {
    await streamApi('/api/render', {
      historyId: state.entry.id,
      index: card.index,
      versionIndex: card.view,
      workflowId: flow.id,
      count,
      seed: card.rb.lockSeed ? card.rb.lastSeed : undefined,
    }, ev => {
      const i = ev.i ?? 0;
      if (ev.type === 'start') run.runId = ev.runId;
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
        const pct = ev.max ? (ev.value / ev.max) * 100 : 0;
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
        const v = state.entry?.variations?.[card.index];
        if (v) (v.renders ||= []).push(ev.render);
        if (ev.render.seed != null) card.rb.lastSeed = ev.render.seed;
        updateSeedChip(card);
        renderTiles(card);
        announce(`Render ${i + 1} of ${count} done`);
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
  // Clear tiles that never finished (stopped); keep failed ones briefly so the reason is visible.
  keys.forEach((k, i) => {
    if (done.has(i)) return;
    const t = card.running.get(k);
    card.running.delete(k);
    if (t?.classList.contains('failed')) setTimeout(() => t.remove(), 12000);
  });
  renderTiles(card);
  if (failed) {
    showError(failed);
    const box = $('.renders', card.el);
    if (box) {
      tiles.filter(t => t.classList.contains('failed')).forEach(t => box.prepend(t));
      box.hidden = !box.children.length;
    }
  } else if (!done.size) toast('■ Render stopped');
  else toast(`🎨 ${done.size} render${done.size > 1 ? 's' : ''} ready`);
  setTitle(document.hidden && done.size ? '✓ Rendered' : '');
  loadComfyStatus();
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
  lb.returnFocus?.focus?.();
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
    ['Workflow', render.workflowName],
    ['Seed', render.seed ?? '—'],
    render.sampler ? ['Sampler', `${render.sampler}${render.steps ? ` · ${render.steps} steps` : ''}${render.cfg != null ? ` · CFG ${render.cfg}` : ''}`] : null,
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
      ${file.kind === 'image' ? '<button type="button" class="btn small" data-lb="use" title="Use this render as the input image for your next prompt, e.g. to animate it">🖼️ Use as input image</button>' : ''}
      ${lb.fromGallery ? '<button type="button" class="btn small" data-lb="open">↗ Open in Create</button>' : '<button type="button" class="btn small" data-lb="again">🎲 Render again</button>'}
      <button type="button" class="btn small danger" data-lb="delete">🗑 Delete</button>
    </div>
    <p class="muted small">${lb.index + 1} of ${lb.items.length} · ← → to browse · Esc to close</p>`;
  $('[data-lb="copy"]', $('#lbInfo')).addEventListener('click', e => copyText(render.text, e.currentTarget));
  $('[data-lb="open"]', $('#lbInfo'))?.addEventListener('click', () => { closeLightbox(); openEntry(entry); });
  $('[data-lb="use"]', $('#lbInfo'))?.addEventListener('click', async () => {
    try {
      const blob = await (await fetch(`/renders/${encodeURIComponent(file.file)}`)).blob();
      closeLightbox();
      showView('create');
      await loadImageFile(new File([blob], file.name || file.file, { type: blob.type || 'image/png' }));
      const video = state.models.find(m => m.kind === 'video');
      toast(video ? `🖼️ Render set as your image. Pick ${video.name} and 🎬 Animate to bring it to life` : '🖼️ Render set as your input image');
      $('#dropzone').scrollIntoView({ block: 'center', behavior: scrollMode() });
    } catch (err) {
      toast(`Couldn't use that render: ${err.message}`, true);
    }
  });
  $('[data-lb="again"]', $('#lbInfo'))?.addEventListener('click', () => {
    const card = state.cards.find(c => c.index === it.index);
    if (!card || !card.rb) return;
    if (state.workflows.some(f => f.id === render.workflowId)) card.rb.workflowId = render.workflowId;
    card.rb.lockSeed = false;
    closeLightbox();
    renderZone(card);
    startRender(card);
  });
  $('[data-lb="delete"]', $('#lbInfo')).addEventListener('click', e => confirmClick(e.currentTarget, 'Sure?', async () => {
    try {
      const updated = await api(`/api/history/${entry.id}/renders/${render.id}`, { method: 'DELETE' });
      if (state.entry?.id === entry.id) {
        state.entry.variations.forEach((v, i) => { v.renders = updated.variations[i].renders; });
        state.cards.forEach(renderTiles);
      }
      const h = state.history.find(x => x.id === entry.id);
      if (h) h.variations.forEach((v, i) => { v.renders = updated.variations[i].renders; });
      lb.items = lb.items.filter(x => x.render.id !== render.id);
      lb.index = Math.min(lb.index, lb.items.length - 1);
      if (isView('gallery')) renderGallery();
      toast('🗑️ Render deleted');
      if (lb.items.length) lbRender(); else closeLightbox();
    } catch (err) {
      toast(err.message, true);
    }
  }));
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
  const items = all.filter(it => (!state.galleryKind || it.file.kind === state.galleryKind) && (!state.galleryModel || it.entry.modelId === state.galleryModel));
  $('#galleryCount').textContent = all.length ? all.length : '';
  const grid = $('#galleryGrid');
  if (!items.length) {
    const none = !all.length;
    grid.innerHTML = `<div class="empty">
      <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>${none ? 'No renders yet' : 'Nothing matches'}</h3>
      <p>${none ? 'Attach a ComfyUI workflow to a model (Models tab), then hit <b>▶ Render</b> on any take. Every image and video lands here.' : 'Try another filter.'}</p>
      ${none ? '<div class="try"><button type="button" class="btn primary" data-go="models">🎨 Set up a workflow</button></div>' : ''}</div>`;
    $('[data-go]', grid)?.addEventListener('click', () => showView('models'));
    return;
  }
  grid.innerHTML = '';
  items.forEach((it, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gtile';
    b.style.setProperty('--m', modelColor(modelById(it.entry.modelId) || { id: it.entry.modelId }));
    b.setAttribute('aria-label', `Open render: ${it.entry.theme || 'from an image'}`);
    b.innerHTML = `${it.file.kind === 'audio' ? '<div class="rtile audio" style="aspect-ratio:1">🔊</div>' : mediaTag(it.file, { hover: true })}${it.file.kind === 'video' ? '<span class="rt-kind">▶ video</span>' : ''}<span class="g-cap"><b>${esc(it.entry.theme || 'From an image')}</b><span>${esc(it.entry.modelName)} · ${esc(it.render.workflowName)}</span></span>`;
    b.addEventListener('click', () => openLightbox(items, n, { fromGallery: true }));
    grid.append(b);
  });
}

$('#galleryKinds').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.galleryKind = b.dataset.kind; renderGallery(); } });
$('#galleryModels').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.galleryModel = b.dataset.id; renderGallery(); } });

// ---------- models → workflows ----------

const MAP_CHIPS = [['prompt', '✍️ Prompt'], ['image', '🖼️ Image'], ['size', '📐 Size'], ['duration', '⏱️ Duration'], ['seed', '🎲 Seed']];

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
      <div><div class="wf-name">${esc(f.name)}</div><div class="wf-src">${f.source.startsWith('comfyui:') ? 'from your ComfyUI library' : 'uploaded file'} · ${f.nodes} nodes</div></div>
      <div class="wf-maps">${MAP_CHIPS.map(([k, label]) => `<span class="${f.maps[k] ? 'on' : ''}" title="${f.maps[k] ? 'Set by Prompt Maker' : 'Left as the workflow has it'}">${label}</span>`).join('')}</div>
      <div class="wf-actions">
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
    if (btn.dataset.act === 'setup') {
      const data = await api(`/api/workflows/${id}`);
      openWorkflowDialog({ edit: data });
    } else if (btn.dataset.act === 'export') {
      const w = await api(`/api/workflows/${id}`);
      download(`${slug(w.name) || 'workflow'}.prompt-maker.json`, { format: 'prompt-maker-workflow', version: 1, name: w.name, prompt: w.prompt, mapping: w.mapping, options: w.options });
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

const dlg = { editId: null, prepared: null, saved: [] };

function openWorkflowDialog({ edit = null, focusSampler = false } = {}) {
  const d = $('#wfDialog');
  const m = modelById(edit?.modelId || state.editId);
  d.style.setProperty('--m', m ? modelColor(m) : 'var(--hot)');
  dlg.editId = edit?.id || null;
  $('#wfPickMsg').hidden = true;
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
  try {
    dlg.saved = await api('/api/comfy/workflows');
  } catch (err) {
    list.innerHTML = `<li class="wf-empty">${esc(err.message)}</li>`;
    return;
  }
  renderSavedList();
}

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
$('#wfBack').addEventListener('click', () => openWorkflowDialog());
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

const PARAM_LABEL = { seed: 'Seed', steps: 'Steps', cfg: 'CFG', sampler: 'Sampler', scheduler: 'Scheduler' };
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
      const current = overrides[key] ?? p.value;
      const field = document.createElement('label');
      field.className = 'sp-field';
      field.dataset.key = key;
      field.dataset.kind = p.kind;
      field.dataset.original = String(p.value);
      const control = p.options
        ? `<select>${p.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`
        : `<input type="${p.kind === 'sampler' || p.kind === 'scheduler' ? 'text' : 'number'}" ${p.kind === 'cfg' ? 'step="0.1" min="0"' : p.kind === 'steps' ? 'step="1" min="1"' : 'step="1" min="0"'}>`;
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

// Seed fields only matter when the seed isn't randomized.
function syncSeedFields() {
  const random = $('#optSeed').checked;
  $$('#samplerCtl .sp-field[data-kind="seed"]').forEach(f => {
    const input = $('input', f);
    input.disabled = random;
    f.title = random ? 'A new random seed is used every render' : '';
    f.classList.toggle('edited', !random && input.value !== f.dataset.original);
  });
}
$('#optSeed').addEventListener('change', syncSeedFields);

function readOverrides() {
  const out = {};
  for (const f of $$('#samplerCtl .sp-field')) {
    const input = $('input, select', f);
    if (input.disabled) continue;
    if (String(input.value) === f.dataset.original && f.dataset.kind !== 'seed') continue;
    if (f.dataset.kind === 'seed' && String(input.value) === f.dataset.original) continue;
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
  fillMap($('#mapWidth'), c.width, m.width);
  fillMap($('#mapHeight'), c.height, m.height);
  fillMap($('#mapAspect'), c.aspect, m.aspect);
  fillMap($('#mapSeconds'), c.seconds, m.seconds);
  fillMap($('#mapFrames'), c.frames, m.frames);
  fillMap($('#mapFps'), c.fps, m.fps);
  $('#optSnap').value = String(data.options.snap);
  $('#optFps').value = data.options.fps;
  $('#optFrameRule').value = data.options.frameRule;
  $('#optSeed').checked = data.options.randomizeSeed !== false;
  $('#optSeedLabel').textContent = c.seed.length
    ? `New random seed every render (${c.seed.length} seed input${c.seed.length > 1 ? 's' : ''})`
    : 'This workflow has no seed input';
  $('#optSeed').disabled = !c.seed.length;
  renderSamplerControls(data);
  // Only show what this workflow can actually take; name the rest.
  const rows = [
    ['#rowImage', 'an input image', c.image.length || m.image],
    ['#rowSize', 'a size', c.width.length || c.height.length || c.aspect.length || m.width || m.aspect],
    ['#rowDuration', 'a duration', c.seconds.length || c.frames.length || m.seconds || m.frames],
    ['#rowSeed', 'sampler settings', c.seed.length || (c.params || []).length],
  ];
  const missing = [];
  for (const [sel, what, has] of rows) {
    $(sel).classList.toggle('unused', !has);
    if (!has) missing.push(what);
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
    image: parseTarget($('#mapImage').value),
    width: parseTarget($('#mapWidth').value),
    height: parseTarget($('#mapHeight').value),
    aspect: parseTarget($('#mapAspect').value),
    seconds: parseTarget($('#mapSeconds').value),
    frames: parseTarget($('#mapFrames').value),
    fps: parseTarget($('#mapFps').value),
    seed: $('#optSeed').checked ? data.candidates.seed.map(t => ({ node: t.node, input: t.input })) : [],
  };
  const options = { snap: Number($('#optSnap').value), fps: Number($('#optFps').value) || 24, frameRule: $('#optFrameRule').value, randomizeSeed: $('#optSeed').checked };
  const name = $('#wfName').value.trim() || data.name;
  try {
    const overrides = readOverrides();
    if (dlg.editId) await api(`/api/workflows/${dlg.editId}`, { method: 'PUT', body: { name, mapping, options, overrides } });
    else await api('/api/workflows', { method: 'POST', body: { modelId: state.editId, name, source: data.source, prompt: data.prompt, mapping, options, overrides } });
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

$('#addWorkflowBtn').addEventListener('click', () => openWorkflowDialog());

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

// ---------- boot ----------

async function loadModels() {
  state.models = await api('/api/models');
  if (!modelById(state.modelId)) state.modelId = state.models[0]?.id || null;
  selectModel(state.modelId);
  renderModelList();
}

(async function boot() {
  try {
    [state.settings, state.models] = await Promise.all([api('/api/settings'), api('/api/models')]);
    state.imageRole = saved.get('imageRole', 'reference');
    selectModel(saved.get('modelId', null));
    renderModelList();
    setVariations(saved.get('variations', 1));
    $('#theme').value = saved.get('theme', '');
    const img = saved.get('image', null);
    if (img && (await api(`/api/images/${encodeURIComponent(img)}`).catch(() => ({}))).exists) setImage({ file: img });
    else saved.set('image', null);
    renderRole();
    renderResults(null);
    showView(location.hash.slice(1) || 'create', { push: false });
    history.replaceState(null, '', `#${VIEWS.find(v => isView(v))}`);
    requestAnimationFrame(sizeTheme);
  } catch (err) {
    showError(`Could not start: ${friendly(err)}`);
  }
  api('/api/history').then(h => { state.history = h; $('#historyBadge').textContent = h.length; $('#historyBadge').hidden = !h.length; }).catch(() => {});
  await Promise.all([loadLlms(), loadWorkflows()]);
  if (state.workflows.length) await loadComfyStatus();
  document.documentElement.dataset.ready = '1';
})();
