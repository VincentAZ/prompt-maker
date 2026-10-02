// End-to-end UI test: the real app server + a mock LM Studio + headless Chrome driven over the
// DevTools protocol. Clicks are real mouse events, so a button hidden under something else fails.
// Usage: node tests/ui.test.mjs [name-filter]   Screenshots go to $SHOTS (default: /tmp/prompt-maker-ui).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { startMock } from './mock-lmstudio.mjs';
import { startMockComfy, SAVED_WORKFLOW, OBJECT_INFO } from './mock-comfyui.mjs';
import { convertUiWorkflow, pruneToOutputs } from '../lib/comfy-convert.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_PORT = Number(process.env.APP_PORT) || 5399;
const MOCK_PORT = Number(process.env.MOCK_PORT) || 12399;
const CDP_PORT = Number(process.env.CDP_PORT) || 9333;
const COMFY_PORT = Number(process.env.COMFY_PORT) || 12488;
const APP = `http://127.0.0.1:${APP_PORT}`;
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'prompt-maker-ui');
const FILTER = process.argv[2] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fixtures ----------

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x / w) * 255;
      raw[o + 1] = 60 + (y / h) * 120;
      raw[o + 2] = 200;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- DevTools protocol ----------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      } else (this.handlers.get(msg.method) || []).forEach(fn => fn(msg.params));
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', reject);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

let cdp;
const problems = [];

// If the page stops answering (stuck in a loop), pause it and report where, instead of hanging the run.
async function frozenAt() {
  const within = p => Promise.race([p, sleep(4000).then(() => null)]);
  await within(cdp.send('Debugger.enable'));
  const paused = new Promise(r => cdp.on('Debugger.paused', r));
  await within(cdp.send('Debugger.pause'));
  const p = await within(paused);
  const where = p ? p.callFrames.slice(0, 8).map(f => `${f.functionName || '(anonymous)'}:${f.location.lineNumber + 1}`).join(' ← ') : 'not in JavaScript (the renderer is blocked)';
  await within(cdp.send('Debugger.resume').catch(() => {}));
  return where;
}

async function js(expr) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(30000).then(async () => { throw new Error(`The page froze. Stuck in: ${await frozenAt()}`); }),
  ]);
  if (r.exceptionDetails) throw new Error(`JS error in test expression: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  ${expr.slice(0, 200)}`);
  return r.result.value;
}
const q = sel => JSON.stringify(sel);

async function waitFor(expr, label, timeout = 8000) {
  const t = Date.now();
  let last;
  for (;;) {
    last = await js(expr).catch(e => { last = e.message; return null; });
    if (last) return last;
    if (Date.now() - t > timeout) throw new Error(`Timed out (${timeout}ms) waiting for ${label || expr}`);
    await sleep(50);
  }
}

const visible = sel => js(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })()`);
const text = sel => js(`document.querySelector(${q(sel)})?.textContent.trim() ?? null`);
const count = sel => js(`document.querySelectorAll(${q(sel)}).length`);
const value = sel => js(`document.querySelector(${q(sel)})?.value ?? null`);

async function click(sel) {
  // Like a person: wait until the element holds still (async updates can move things for a moment).
  let box;
  for (let tries = 0; tries < 20; tries++) {
    box = await locate(sel);
    if (box.err) break;
    await sleep(30);
    const again = await locate(sel);
    if (!again.err && Math.abs(again.x - box.x) < 1 && Math.abs(again.y - box.y) < 1) { box = again; break; }
  }
  if (box.err) throw new Error(`click(${sel}): ${box.err}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(40);
}

// Where to click an element (its center), after scrolling it into view; or why it can't be clicked.
function locate(sel) {
  return js(`(() => {
    const el = document.querySelector(${q(sel)});
    if (!el) return { err: 'element not found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { err: 'element is not visible' };
    if (el.disabled) return { err: 'element is disabled' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!(hit === el || el.contains(hit))) {
      const d = hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') : 'nothing';
      return { err: 'covered by ' + d };
    }
    return { x, y };
  })()`);
}

async function type(sel, str, { clear = true } = {}) {
  await click(sel);
  if (clear) await js(`(() => { const el = document.querySelector(${q(sel)}); el.select?.(); })()`);
  else await js(`(() => { const el = document.querySelector(${q(sel)}); el.selectionStart = el.selectionEnd = el.value.length; })()`);
  if (clear && !str) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  } else {
    await cdp.send('Input.insertText', { text: str });
  }
  await sleep(30);
}

async function press(key, { ctrl = false } = {}) {
  const codes = { Enter: 13, Escape: 27, ' ': 32, ArrowDown: 40, ArrowUp: 38 };
  const base = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key], modifiers: ctrl ? 2 : 0 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if ((key === 'Enter' || key === ' ') && !ctrl) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key === ' ' ? ' ' : '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(40);
}

async function choose(sel, val) {
  await js(`(() => { const el = document.querySelector(${q(sel)}); el.value = ${q(val)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(80);
}

async function setFiles(sel, files) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files });
}

async function viewport(width, height, mobile = false) {
  vp = { width, height, mobile };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await sleep(150);
}

let vp = { width: 1440, height: 900, mobile: false };
async function shot(name, { full = false } = {}) {
  if (full) {
    // Grow the viewport to the page height so sticky elements render where they really sit.
    const scrollY = await js('scrollY');
    await js('scrollTo(0, 0)');
    const h = await js('document.documentElement.scrollHeight');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: Math.min(h, 5000), deviceScaleFactor: 1, mobile: vp.mobile });
    await sleep(200);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await js(`scrollTo(0, ${scrollY})`);
    await sleep(100);
    return;
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

async function goto(url) {
  const here = await js('location.href').catch(() => '');
  await js('document.documentElement.dataset.ready = ""').catch(() => {});
  // Only the #hash differs = no page load at all; go via a blank page so "after a reload" really means it.
  if (here.split('#')[0] === url.split('#')[0]) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await waitFor('location.href === "about:blank"', 'left the page');
  }
  await cdp.send('Page.navigate', { url });
  await sleep(150);
  await waitFor('document.documentElement.dataset.ready === "1"', 'app boot', 10000);
}

async function toastText(expected = '') {
  return waitFor(`(() => { const t = document.querySelector("#toast"); return !t.hidden && t.textContent.includes(${q(expected)}) && t.textContent; })()`, `toast "${expected}"`);
}

const fileExists = p => fs.access(p).then(() => true, () => false);
// Unfolds a collapsible panel (data-panel="key") if it's folded.
const openPanel = key => js(`(() => { const el = document.querySelector('[data-panel="${key}"]'); if (el?.classList.contains('collapsed')) el._btn.click(); })()`);

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function eq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }

// ---------- harness ----------

const results = [];
async function test(name, fn) {
  if (FILTER && !name.includes(FILTER) && !['boot'].includes(name)) return;
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name} (${Date.now() - t}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
    await shot(`FAIL-${name}`).catch(() => {});
  }
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-test-'));
  const dataDir = path.join(tmp, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  // The app must never write into its own folder: remember how it looks now.
  const shipped = {};
  for (const f of await fs.readdir(path.join(ROOT, 'playbooks'))) shipped[f] = await fs.readFile(path.join(ROOT, 'playbooks', f), 'utf8');
  const hadLegacyData = await fileExists(path.join(ROOT, 'data'));
  const shippedChains = {};
  for (const f of await fs.readdir(path.join(ROOT, 'chains'))) shippedChains[f] = await fs.readFile(path.join(ROOT, 'chains', f), 'utf8');
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ lmStudioUrl: `http://127.0.0.1:${MOCK_PORT}`, comfyUrl: `http://127.0.0.1:${COMFY_PORT}`, llmModel: 'mock/vision-8b' }));
  const lmsMarker = path.join(tmp, 'lms-called');
  const fakeLms = path.join(tmp, 'fake-lms');
  await fs.writeFile(fakeLms, `#!/bin/sh\necho "$@" > ${JSON.stringify(lmsMarker)}\n`, { mode: 0o755 });
  // Start-up setup goes to temp folders and a fake systemctl, never to your real app menu or services.
  const xdgConfig = path.join(tmp, 'xdg-config');
  const xdgData = path.join(tmp, 'xdg-data');
  const systemctlLog = path.join(tmp, 'systemctl.log');
  const fakeSystemctl = path.join(tmp, 'fake-systemctl');
  await fs.writeFile(fakeSystemctl, `#!/bin/sh
echo "$@" >> ${JSON.stringify(systemctlLog)}
case "$*" in
  *is-active*prompt-maker-comfyui*) if [ -f ${JSON.stringify(path.join(tmp, 'comfy-active'))} ]; then echo active; else echo inactive; exit 3; fi ;;
  *"stop prompt-maker-comfyui"*) rm -f ${JSON.stringify(path.join(tmp, 'comfy-active'))} ;;
  *--version*) echo "systemd 255" ;;
  *is-enabled*) if [ -f ${JSON.stringify(path.join(tmp, 'enabled'))} ]; then echo enabled; else echo disabled; exit 1; fi ;;
  *" enable "*) touch ${JSON.stringify(path.join(tmp, 'enabled'))} ;;
  *disable*) rm -f ${JSON.stringify(path.join(tmp, 'enabled'))} ;;
esac
`, { mode: 0o755 });
  const systemdRunLog = path.join(tmp, 'systemd-run.log');
  const fakeSystemdRun = path.join(tmp, 'fake-systemd-run');
  await fs.writeFile(fakeSystemdRun, `#!/bin/sh\n[ "$1" = --version ] && exit 0\necho "$@" >> ${JSON.stringify(systemdRunLog)}\ntouch ${JSON.stringify(path.join(tmp, 'comfy-active'))}\n`, { mode: 0o755 });
  const fixture = path.join(tmp, 'fixture.png');
  await fs.writeFile(fixture, makePng(640, 400));
  const portrait = path.join(tmp, 'portrait.png');
  await fs.writeFile(portrait, makePng(400, 700));

  const mock = startMock(MOCK_PORT);
  await mock.start();
  const comfyRoot = path.join(tmp, 'ComfyUI');
  for (const d of ['output', 'custom_nodes']) await fs.mkdir(path.join(comfyRoot, d), { recursive: true });
  const comfy = startMockComfy(COMFY_PORT, { png: makePng(96, 96), root: comfyRoot });
  await comfy.start();
  const apiWorkflowFile = path.join(tmp, 'mock-api.json');
  const turbo = pruneToOutputs(convertUiWorkflow(SAVED_WORKFLOW, OBJECT_INFO), OBJECT_INFO);
  turbo['3'].inputs.cfg = 1; // a distilled/turbo-style workflow: CFG must stay 1
  await fs.writeFile(apiWorkflowFile, JSON.stringify(turbo));
  // A workflow that loads a LoRA of its own between the checkpoint and the sampler.
  const loraWorkflowFile = path.join(tmp, 'mock-lora.json');
  const withLora = pruneToOutputs(convertUiWorkflow(SAVED_WORKFLOW, OBJECT_INFO), OBJECT_INFO);
  withLora['20'] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'krea2/baked_in.safetensors', strength_model: 0.5, model: ['4', 0] }, _meta: { title: 'Baked-in LoRA' } };
  withLora['3'].inputs.model = ['20', 0];
  await fs.writeFile(loraWorkflowFile, JSON.stringify(withLora));
  // An image-to-video style workflow: same graph plus a Load Image node for the first frame.
  const i2vWorkflowFile = path.join(tmp, 'mock-i2v.json');
  await fs.writeFile(i2vWorkflowFile, JSON.stringify({ ...pruneToOutputs(convertUiWorkflow(SAVED_WORKFLOW, OBJECT_INFO), OBJECT_INFO), 11: { class_type: 'LoadImage', inputs: { image: 'example.png' }, _meta: { title: 'First frame' } } }));

  const app = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT), PROMPT_MAKER_DATA: dataDir, LMS_BIN: fakeLms, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData, SYSTEMCTL_BIN: fakeSystemctl, SYSTEMD_RUN_BIN: fakeSystemdRun, XDG_MIME_BIN: '/bin/true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let appLog = '';
  app.stdout.on('data', d => { appLog += d; });
  app.stderr.on('data', d => { appLog += d; });
  for (let i = 0; i < 50 && !appLog.includes('running at'); i++) await sleep(100);
  if (!appLog.includes('running at')) throw new Error(`App did not start:\n${appLog}`);

  const chrome = spawn('google-chrome', [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*',
    '--window-size=1440,900', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(150);
    target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json()).then(l => l.find(t => t.type === 'page')).catch(() => null);
  }
  if (!target) throw new Error('Chrome did not start');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable'].map(m => cdp.send(m)));
  // Reloading with unsaved Settings asks "Leave site?" (on purpose); the tests always leave.
  cdp.on('Page.javascriptDialogOpening', () => cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));
  cdp.on('Runtime.exceptionThrown', p => problems.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`));
  cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'warning') problems.push(`console.${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ')}`); });
  cdp.on('Log.entryAdded', ({ entry }) => {
    // Deliberate negative tests produce 4xx/5xx from our own API; anything else is a real problem.
    if (entry.level === 'error' && !(entry.source === 'network' && /\/api\//.test(entry.url || ''))) problems.push(`log: ${entry.text} ${entry.url || ''}`);
  });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); // stable screenshots
  await cdp.send('Browser.grantPermissions', { origin: APP, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  await viewport(1440, 900);

  const mockCalls = () => mock.log.length;
  const loadAgain = async () => {
    await js('document.querySelector("#llmRefresh").click()');
    await waitFor('document.querySelector("#banner").hidden && document.querySelector("#llmDot").classList.contains("ok")', 'reconnected');
  };
  const lastCall = () => mock.log.at(-1);
  const genDone = () => waitFor('!document.querySelector("#generateBtn").disabled && document.querySelector("#stopBtn").hidden', 'generation to finish', 15000);

  console.log(`\nPrompt Maker UI tests → screenshots in ${OUT}\n`);

  await test('boot', async () => {
    await goto(`${APP}/`);
    assert(await js('document.querySelector("#view-create").classList.contains("active")'), 'Create view is active');
    eq(await count('.model-card'), 3, 'model cards');
    await waitFor('document.querySelector("#llmDot").classList.contains("ok")', 'LLM status dot to be green');
    eq(await value('#llmSelect'), 'mock/vision-8b', 'selected brain');
    assert(!(await visible('#banner')), 'offline banner hidden');
    assert(await visible('#resultsEmpty'), 'empty state visible');
    eq(await js('document.fonts.check("16px Bricolage")'), true, 'bundled display font loaded');
    await shot('01-create-empty');
  });

  await test('validation: nothing to work with', async () => {
    await type('#theme', '');
    await click('#generateBtn');
    assert(await visible('#stageError'), 'error card shown');
    assert((await text('#stageError')).includes('Give me something'), 'friendly validation message');
    await click('#stageError .x');
    assert(!(await visible('#stageError')), 'error dismissed');
  });

  await test('surprise me and try chips fill the theme', async () => {
    await click('#surpriseBtn');
    assert((await value('#theme')).length > 10, 'surprise filled theme');
    await click('#tryChips button');
    assert((await value('#theme')).includes('beach'), 'try chip filled beach theme');
  });

  await test('generate 2 takes (theme only)', async () => {
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="2"]');
    eq(await text('#genLabel'), 'Generate 2 takes', 'button label');
    await type('#theme', 'woman at beach with soda in her hand');
    const before = mockCalls();
    await click('#generateBtn');
    await waitFor('document.querySelector("#generateBtn").disabled', 'busy state');
    eq(await text('#genLabel'), 'Cooking…', 'busy label');
    await waitFor('[...document.querySelectorAll(".take .prompt-view")].some(v => !v.hidden)', 'streaming text');
    await shot('02-streaming');
    await genDone();
    eq(await count('.take'), 2, 'two takes');
    eq(await count('.take .prompt-text:not([hidden])'), 2, 'both takes finished');
    eq(await text('.take:nth-child(1) .take-title'), 'Take 1', 'take title');
    assert((await text('.take:nth-child(1) .meter')).includes('target'), 'word meter shows target');
    assert((await text('#stageHead')).includes('Mock Vision 8B'), 'stage head names the brain');
    eq(await text('#historyBadge'), '1', 'history badge');
    eq(mockCalls() - before, 2, 'two LLM calls');
    eq(mock.log.at(-1).reasoning_effort, 'none', 'thinking is off by default');
    assert(JSON.stringify(mock.log.at(-1).messages).includes('VARIATION 2 OF 2'), 'second take asked for a different variation');
    assert((await value('.take:nth-child(2) .prompt-text')).startsWith('Alternate take 2'), 'take 2 text');
    await shot('03-two-takes', { full: true });
  });

  await test('refine with a quick chip + version paging', async () => {
    await click('.take:nth-child(1) .refine input');
    await click('.take:nth-child(1) .chips button[data-instr="Shorter"]');
    await waitFor('document.querySelector(".take:nth-child(1) .vlabel")?.textContent === "v2/2"', 'v2/2');
    assert((await value('.take:nth-child(1) .prompt-text')).startsWith('Revised to be shorter'), 'refined text shown');
    assert((await text('.take:nth-child(1) .change')).includes('Shorter'), 'change label');
    await click('.take:nth-child(1) .versions .prev');
    eq(await text('.take:nth-child(1) .vlabel'), 'v1/2', 'paged back');
    assert((await value('.take:nth-child(1) .prompt-text')).startsWith('A candid'), 'original text');
    await click('.take:nth-child(1) .versions .next');
    eq(await text('.take:nth-child(1) .vlabel'), 'v2/2', 'paged forward');
  });

  await test('refine an older version (no fake manual edit)', async () => {
    await click('.take:nth-child(1) .versions .prev');
    eq(await text('.take:nth-child(1) .vlabel'), 'v1/2', 'viewing v1');
    await click('.take:nth-child(1) .refine input');
    await click('.take:nth-child(1) .chips button[data-instr="More detailed"]');
    await waitFor('document.querySelector(".take:nth-child(1) .vlabel")?.textContent === "v3/3"', 'v3/3 (not v4/4)');
    assert((await text('.take:nth-child(1) .change')).includes('More detailed'), 'latest is the refine');
  });

  await test('refine by typing + Enter keeps focus', async () => {
    await type('.take:nth-child(2) .refine input', 'make it golden hour');
    await press('Enter');
    await waitFor('document.querySelector(".take:nth-child(2) .vlabel")?.textContent === "v2/2"', 'take 2 v2/2');
    eq(await value('.take:nth-child(2) .refine input'), '', 'refine input cleared');
    assert(await js('document.activeElement === document.querySelector(".take:nth-child(2) .refine input")'), 'focus back in the tweak box');
  });

  await test('manual edit + save as version', async () => {
    await type('.take:nth-child(1) .prompt-text', ' Extra sparkle.', { clear: false });
    assert(await visible('.take:nth-child(1) .save-edit'), 'save edit button appears');
    await click('.take:nth-child(1) .save-edit');
    await waitFor('document.querySelector(".take:nth-child(1) .vlabel")?.textContent === "v4/4"', 'v4/4 after save');
    assert((await text('.take:nth-child(1) .change')).includes('manual edit'), 'labelled as manual edit');
  });

  await test('unsaved edit survives paging', async () => {
    await type('.take:nth-child(1) .prompt-text', ' Another line.', { clear: false });
    await click('.take:nth-child(1) .versions .prev');
    await waitFor('document.querySelector(".take:nth-child(1) .vlabel")?.textContent === "v4/5"', 'edit auto-saved as v5, now viewing v4');
    await click('.take:nth-child(1) .versions .next');
    assert((await value('.take:nth-child(1) .prompt-text')).endsWith('Another line.'), 'edit kept');
  });

  await test('copy + copy all', async () => {
    await click('.take:nth-child(1) .copy');
    await waitFor('document.querySelector(".take:nth-child(1) .copy").textContent.includes("Copied")', 'copied feedback');
    const clip = await js('navigator.clipboard.readText().catch(() => null)');
    if (clip !== null) assert(clip.endsWith('Another line.'), 'clipboard has take 1');
    await click('#copyAllBtn');
    await waitFor('document.querySelector("#copyAllBtn").textContent.includes("Copied")', 'copy all feedback');
    const all = await js('navigator.clipboard.readText().catch(() => null)');
    if (all !== null) assert(all.includes('--- Take 2 ---'), 'takes are clearly separated');
  });

  await test('image upload + animate on a video model', async () => {
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector(".dz-preview").hidden', 'image preview');
    assert(await visible('#roleBlock'), 'role picker visible');
    assert(!(await visible('#roleBlock [data-value="animate"]')), 'no animate for image model');
    // 640×400 (1.6) → Krea's closest ratio is 3:2, and the resolution follows.
    eq(await value('#aspect'), '3:2', 'aspect matched to the image');
    eq(await value('#resolution'), '1216×832', 'resolution matches the aspect');
    assert(await visible('#aspectNote'), '"from image" note');
    await toastText('aspect set to 3:2');
    await click('.model-card[data-id="ltx-2-3"]');
    eq(await value('#aspect'), '16:9', 'LTX follows the image too');
    eq(await value('#resolution'), '1920×1080', 'LTX resolution is landscape');
    assert(await visible('#roleBlock [data-value="animate"]'), 'animate for video model');
    assert(await visible('#durationField'), 'duration shown for video');
    await click('#roleBlock [data-value="animate"]');
    assert((await text('#roleHint')).includes('frame one'), 'animate hint');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a gust of wind blows through');
    await click('#generateBtn');
    await waitFor('[...document.querySelectorAll(".take .status")].some(s => s.textContent.includes("Studying"))', '"Studying your image" status');
    await genDone();
    assert(JSON.stringify(lastCall().messages).includes('image_url'), 'image sent to the LLM');
    assert(JSON.stringify(lastCall().messages).includes('role = \\"animate\\"'), 'animate role sent');
    eq(await text('#historyBadge'), '2', 'history badge 2');
    await shot('04-image-animate', { full: true });
  });

  await test('portrait image flips to 9:16; manual change wins', async () => {
    await setFiles('#imageInput', [portrait]);
    await waitFor('document.querySelector("#aspect").value === "9:16"', 'portrait aspect');
    eq(await value('#resolution'), '1080×1920', 'portrait resolution of the same size');
    await choose('#aspect', '1:1');
    eq(await value('#resolution'), '1024×1024', 'resolution follows a manual aspect change');
    assert(!(await visible('#aspectNote')), 'note cleared after a manual change');
    await choose('#aspect', '9:16');
  });

  await test('text-only brain warns and blocks images', async () => {
    await choose('#llmSelect', 'mock/text-only');
    await waitFor('!document.querySelector("#visionWarn").hidden', 'vision warning');
    const before = mockCalls();
    await click('#generateBtn');
    assert((await text('#stageError')).includes("can't see images"), 'blocked with explanation');
    eq(mockCalls(), before, 'no LLM call made');
    await click('#imageClear');
    assert(!(await visible('#visionWarn')), 'warning gone without image');
    await click('#generateBtn');
    await genDone();
    eq(mockCalls(), before + 1, 'text-only generation works');
    await choose('#llmSelect', 'mock/vision-8b');
  });

  await test('thinking model: loading + thinking statuses', async () => {
    await click('.tabs button[data-view="settings"]');
    await choose('#sThinking', 'default');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
    await choose('#llmSelect', 'mock/thinker');
    await type('#theme', 'a tiny dragon napping in a teacup');
    await click('#generateBtn');
    await waitFor('[...document.querySelectorAll(".take .status")].some(s => s.textContent.includes("Loading Mock Thinker"))', 'model loading status');
    await waitFor('[...document.querySelectorAll(".take .status")].some(s => s.textContent.includes("Thinking"))', 'thinking status');
    await shot('05-thinking');
    await genDone();
    eq(await count('.take .prompt-text:not([hidden])'), 1, 'thinking model finished');
    await click('.tabs button[data-view="settings"]');
    await choose('#sThinking', 'off');
    await click('#settingsForm button[type="submit"]');
    await click('.tabs button[data-view="create"]');
    await choose('#llmSelect', 'mock/vision-8b');
  });

  await test('brain that ignores Thinking: Off is switched off another way, and remembered', async () => {
    await choose('#llmSelect', 'mock/fable');
    await type('#theme', 'a lighthouse in a storm');
    const before = mockCalls();
    await click('#generateBtn');
    await genDone();
    eq(await count('.take .prompt-text:not([hidden])'), 1, 'prompt written');
    eq(mockCalls(), before + 2, 'stopped once it started thinking, then asked again');
    eq(mock.log.at(-2).messages.at(-1).role, 'user', 'first ask as usual');
    assert(/^<think>\s*<\/think>/.test(lastCall().messages.at(-1).content), 'second ask starts with its thinking over');
    await click('#generateBtn');
    await genDone();
    eq(mockCalls(), before + 3, 'next time it goes straight to the trick');
    assert(/^<think>/.test(lastCall().messages.at(-1).content), 'remembered');
    await waitFor('document.querySelector("#llmBox").title.includes("switches it off another way")', 'tooltip says how thinking is switched off');
    await choose('#llmSelect', 'mock/vision-8b');
    await click('#generateBtn');
    await genDone();
    eq(lastCall().messages.at(-1).role, 'user', 'a Brain that behaves gets no trick');
  });

  await test('empty output → clear error', async () => {
    await type('#theme', 'EMPTYTEST scene');
    await click('#generateBtn');
    await genDone();
    assert((await text('#stageError')).includes('ran out of room'), 'token-limit error title');
    assert(await visible('#resultsEmpty'), 'empty state restored');
  });

  await test('server error → clear error', async () => {
    await type('#theme', 'FAILTEST scene');
    await click('#generateBtn');
    await genDone();
    assert((await text('#stageError')).includes('Mock failure'), 'server error surfaced');
  });

  await test('stop mid-stream (button and Esc)', async () => {
    await type('#theme', 'SLOWTEST scene');
    await click('#generateBtn');
    await waitFor('[...document.querySelectorAll(".take .prompt-view")].some(v => !v.hidden)', 'streaming started', 8000);
    await click('#stopBtn');
    await genDone();
    await toastText('Stopped');
    assert(await visible('#resultsEmpty'), 'empty state after stop');
    await click('#generateBtn');
    await waitFor('document.querySelector("#generateBtn").disabled', 'busy again');
    await press('Escape');
    await genDone();
  });

  await test('stop keeps takes that already finished', async () => {
    await click('#varSeg button[data-value="3"]');
    await type('#theme', 'SLOWSECOND stop test');
    const badge = Number(await text('#historyBadge'));
    await click('#generateBtn');
    await waitFor('document.querySelector(".take:nth-child(1) .status")?.textContent.includes("Done")', 'take 1 done', 8000);
    await waitFor('!document.querySelector(".take:nth-child(2) .prompt-view").hidden', 'take 2 streaming', 8000);
    await click('#stopBtn');
    await genDone();
    eq(await count('.take'), 1, 'finished take kept, unfinished removed');
    assert(await visible('.take .prompt-text'), 'kept take is editable');
    await toastText('Kept 1');
    eq(Number(await text('#historyBadge')), badge + 1, 'saved to history');
    await click('#varSeg button[data-value="1"]');
  });

  await test('LM Studio dies mid-answer → friendly error, partial kept', async () => {
    await type('#theme', 'SLOWTEST dropout');
    await click('#generateBtn');
    await waitFor('[...document.querySelectorAll(".take .prompt-view")].some(v => !v.hidden)', 'streaming', 8000);
    await mock.stop();
    await genDone();
    assert((await text('#stageError')).includes('dropped out'), 'friendly mid-answer error');
    assert(await visible('.take.interrupted .prompt-text'), 'partial text kept');
    assert((await text('.take.interrupted .status')).includes('Cut off'), 'marked as cut off');
    await mock.start();
    await loadAgain();
  });

  await test('Ctrl+Enter generates (and the tab title shows progress)', async () => {
    await type('#theme', 'keyboard warrior portrait');
    await press('Enter', { ctrl: true });
    await waitFor('document.querySelector("#generateBtn").disabled', 'started by Ctrl+Enter');
    await waitFor('document.title.startsWith("✍️")', 'title shows progress');
    await genDone();
    eq(await count('.take .prompt-text:not([hidden])'), 1, 'result from Ctrl+Enter');
  });

  await test('LM Studio offline → banner, error, recovery', async () => {
    await mock.stop();
    await click('#llmRefresh');
    await waitFor('!document.querySelector("#banner").hidden', 'offline banner');
    assert(await js('document.querySelector("#llmDot").classList.contains("bad")'), 'red dot');
    await click('#generateBtn');
    await waitFor('document.querySelector("#stageError") && !document.querySelector("#stageError").hidden', 'error card');
    assert((await text('#stageError')).includes('LM Studio'), 'offline error');
    await shot('06-offline');
    // "Start it" runs `lms server start`; the fake lms records the call and we bring the mock back.
    await click('#bannerStart');
    for (let i = 0; i < 50 && !(await fs.stat(lmsMarker).catch(() => null)); i++) await sleep(100);
    eq((await fs.readFile(lmsMarker, 'utf8')).trim(), `server start --port ${MOCK_PORT}`, 'lms called with the right port');
    await mock.start();
    await waitFor('document.querySelector("#banner").hidden', 'banner cleared after start', 12000);
    assert(await js('document.querySelector("#llmDot").classList.contains("ok")'), 'green dot again');
    await toastText('LM Studio is back');
  });

  await test('reconnects on its own when LM Studio comes back', async () => {
    await mock.stop();
    await click('#llmRefresh');
    await waitFor('!document.querySelector("#banner").hidden', 'offline banner');
    await mock.start();
    await waitFor('document.querySelector("#banner").hidden', 'auto-reconnected without clicking', 9000);
  });

  await test("app server gone → its own banner, no LM Studio button, reconnects on its own", async () => {
    // The page can't reach Prompt Maker's server (stopped, or the computer restarted).
    await js('window.realFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError("Failed to fetch"))');
    await click('#llmRefresh');
    await waitFor('!document.querySelector("#banner").hidden', 'banner');
    eq(await text('#bannerTitle'), "Prompt Maker's server isn't running.", 'says what is really down');
    assert((await text('#bannerLong')).includes('./start.sh'), 'says how to start it');
    assert(!(await visible('#bannerStart')), "no Start button: there's nothing to ask");
    await js('window.fetch = window.realFetch');
    await toastText('Prompt Maker is back');
    assert(await js('document.querySelector("#banner").hidden'), 'banner gone without clicking');
    assert(await js('!document.querySelector("#bannerStart").hidden'), 'the LM Studio button is back for next time');
  });

  await test('start-up: start with the computer from Settings; the offline banner can start the app', async () => {
    await click('.tabs button[data-view="settings"]');
    await waitFor('!document.querySelector("#startupOpts").hidden', 'start-up switches');
    assert(!(await js('document.querySelector("#sAutostart").checked')), 'off at first');
    await click('#sAutostart');
    await toastText('starts with your computer');
    const unit = await fs.readFile(path.join(xdgConfig, 'systemd', 'user', 'prompt-maker.service'), 'utf8');
    assert(unit.includes(`ExecStart="${process.execPath}"`) && unit.includes('server.js') && unit.includes('Restart=on-failure') && unit.includes('server start'), 'service: runs the app, restarts it, turns on LM Studio');
    const desktop = await fs.readFile(path.join(xdgData, 'applications', 'prompt-maker.desktop'), 'utf8');
    assert(desktop.includes('Name=Prompt Maker') && desktop.includes('MimeType=x-scheme-handler/promptmaker;') && desktop.includes('start.sh" %u'), 'app-menu entry and the start link');
    assert((await fs.readFile(systemctlLog, 'utf8')).includes('--user enable prompt-maker.service'), 'starts at login');
    assert(!(await visible('#settingsDirty')), 'the switch saves on its own');
    assert((await text('#sAutostartHint')).includes('comes back on its own'), 'says what it does');

    // With the server gone, the banner now has a button that starts it.
    await js('window.realFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError("Failed to fetch"))');
    await click('#llmRefresh');
    await waitFor('!document.querySelector("#banner").hidden', 'banner');
    assert(await visible('#bannerLaunch'), 'Start Prompt Maker button');
    eq(await js('document.querySelector("#bannerLaunch").getAttribute("href")'), 'promptmaker://start', 'opens the start link');
    assert((await text('#bannerLong')).includes('Click Start'), 'tells you to click it');
    await js('window.fetch = window.realFetch');
    await toastText('Prompt Maker is back');

    await click('#sAutostart');
    await toastText("won't start with your computer");
    assert((await fs.readFile(systemctlLog, 'utf8')).includes('--user disable prompt-maker.service'), 'off at login');
    await click('.tabs button[data-view="create"]');
  });

  await test('services: see what runs; start and stop ComfyUI and LM Studio from Settings', async () => {
    await click('.tabs button[data-view="settings"]');
    await waitFor('document.querySelector(\'.svc[data-svc="comfy"] .svc-state\').textContent.startsWith("Running")', 'ComfyUI shown running');
    assert((await text('.svc[data-svc="lms"] .svc-state')).includes('1 model loaded'), 'LM Studio running, with what it has loaded');

    // ComfyUI's folder (normally found on its own)
    const comfyDir = path.join(tmp, 'ComfyUI');
    await fs.mkdir(path.join(comfyDir, 'comfy'), { recursive: true });
    await fs.writeFile(path.join(comfyDir, 'main.py'), '');
    await type('#sComfyFolder', comfyDir);
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');

    // Started some other way (here: not a ComfyUI process at all), it's left alone, with a clear message.
    await click('.svc[data-svc="comfy"] [data-act="comfy-stop"]');
    await toastText('not as a program Prompt Maker can stop');

    // Off → ▶ Start runs it from its folder, in the background, and the page waits for it to answer.
    await comfy.stop();
    await click('.tabs button[data-view="create"]');
    await click('.tabs button[data-view="settings"]');
    await waitFor('!document.querySelector(\'[data-act="comfy-start"]\').hidden', 'Start button when off');
    assert((await text('#svcComfyHow')).includes(comfyDir), 'says where it starts from');
    await click('[data-act="comfy-start"]');
    await toastText('Starting ComfyUI');
    const started = await fs.readFile(systemdRunLog, 'utf8');
    assert(started.includes('--unit=prompt-maker-comfyui.service') && started.includes(`--working-directory=${comfyDir}`) && started.includes('main.py') && started.includes(`--port ${COMFY_PORT}`), `runs main.py in its folder on the right port: ${started}`);
    await waitFor('document.querySelector(\'.svc[data-svc="comfy"] .svc-state\').textContent.startsWith("Starting")', 'shown starting');
    await comfy.start(); // ComfyUI answers
    await toastText('ComfyUI is running');
    await waitFor('document.querySelector(\'.svc[data-svc="comfy"] .svc-state\').textContent.startsWith("Running")', 'shown running');

    // ■ Stop stops what Prompt Maker started.
    await click('[data-act="comfy-stop"]');
    await comfy.stop(); // it goes away
    await toastText('ComfyUI is off');
    assert((await fs.readFile(systemctlLog, 'utf8')).includes('--user stop prompt-maker-comfyui.service'), 'stopped its service');
    await comfy.start();

    // LM Studio: unload everything, server off.
    await click('[data-act="lms-stop"]');
    for (let i = 0; i < 80 && (await fs.readFile(lmsMarker, 'utf8').catch(() => '')).trim() !== 'server stop'; i++) await sleep(100);
    eq((await fs.readFile(lmsMarker, 'utf8')).trim(), 'server stop', 'lms server stop, after unloading');

    // Stopping Prompt Maker (or everything) asks for a second click first.
    await click('#stopAllBtn');
    eq(await text('#stopAllBtn'), 'Click again to stop everything', 'asks to confirm');
    await type('#sComfyFolder', '');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
  });

  await test('cloud Brains: none until you add one; asks before sending prompts; key never shown again', async () => {
    eq(await js('[...document.querySelectorAll("#llmSelect option")].filter(o => o.value.startsWith("cloud:")).length'), 0, 'ships with no cloud Brains');
    await click('.tabs button[data-view="settings"]');
    await waitFor('document.querySelectorAll("#cpPreset option").length > 5', 'provider list');
    await choose('#cpPreset', 'custom');
    assert(await visible('#cpUrl'), 'custom asks for the address');
    await type('#cpUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
    await type('#cpName', 'Test Cloud');
    await type('#cpKey', 'wrong-key');
    await click('#cpAdd');
    await toastText("didn't accept that API key");
    await type('#cpKey', 'sk-test-12345678');
    await click('#cpAdd');
    await toastText('Added Test Cloud');
    assert((await text('#providerList')).includes('key …5678'), 'key shown masked');
    assert(!(await js('JSON.stringify(document.body.innerHTML)')).includes('sk-test-12345678'), 'the key is never on the page');
    eq(((await fs.stat(path.join(dataDir, 'providers.json'))).mode & 0o777).toString(8), '600', 'key file readable by you only');
    assert(!(await visible('#settingsDirty')), 'adding a provider is not an unsaved setting');
    const cloudId = await js('[...document.querySelectorAll("#llmSelect option")].find(o => o.value.endsWith(":mock/text-only"))?.value');
    assert(cloudId?.startsWith('cloud:'), 'its models are Brains now');

    // Switching to it asks first. Nope keeps the local Brain.
    await click('.tabs button[data-view="create"]');
    await choose('#llmSelect', cloudId);
    await waitFor('document.querySelector("#cloudDialog").open', 'are-you-sure dialog');
    assert((await text('#cloudDialog')).includes('leaves your computer'), 'says what leaves');
    await click('#cloudDialog button[value="no"]');
    eq(await value('#llmSelect'), 'mock/vision-8b', 'Nope: still the local Brain');

    // OK + don't ask again → cloud Brain, prompts go with the key, no thinking switch forced on it.
    await choose('#llmSelect', cloudId);
    await waitFor('document.querySelector("#cloudDialog").open', 'asked again');
    await click('#cdTrust');
    await click('#cloudDialog button[value="ok"]');
    await toastText('Brain: ☁️');
    eq(await text("#llmPickName"), `☁️ mock/text-only · Test Cloud`, 'top bar marks it ☁️');
    await type('#theme', 'a lighthouse keeper making tea');
    await click('#generateBtn');
    await genDone();
    eq(lastCall()._auth, 'Bearer sk-test-12345678', 'sent with your key');
    eq(lastCall().model, 'mock/text-only', 'the provider\'s own model name');
    eq(lastCall().reasoning_effort, undefined, 'Thinking: Off asks for nothing');
    await choose('#llmSelect', 'mock/vision-8b');
    await choose('#llmSelect', cloudId);
    assert(!(await js('document.querySelector("#cloudDialog").open')), "doesn't ask again");
    await toastText('Brain: ☁️');
    await choose('#llmSelect', 'mock/vision-8b');

    // Remove: gone from the menu, key deleted.
    await click('.tabs button[data-view="settings"]');
    await click('#providerList [data-act="remove"]');
    await click('#providerList [data-act="remove"]');
    await toastText('Provider removed');
    eq(JSON.parse(await fs.readFile(path.join(dataDir, 'providers.json'), 'utf8')).length, 0, 'key deleted');
    await waitFor('![...document.querySelectorAll("#llmSelect option")].some(o => o.value.startsWith("cloud:"))', 'gone from the Brain menu');
    await click('.tabs button[data-view="create"]');
  });

  await test('adult content: off by default; when on, its section goes with every prompt', async () => {
    const sent = () => lastCall().messages[0].content;
    await type('#theme', 'a quiet harbor at dawn');
    await click('#generateBtn');
    await genDone();
    assert(!sent().includes('ADULT CONTENT'), 'off by default');
    await click('.tabs button[data-view="settings"]');
    assert(!(await js('document.querySelector("#sAdult").checked')), 'switch off');
    await js('document.querySelector("#sAdultText").open = true');
    assert((await text('#sAdultText pre')).includes('18 or older'), 'you can read what it adds');
    assert((await text('#settingsForm')).includes('none come with the app'), 'says where adult examples go');
    await click('#sAdult');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
    await click('#generateBtn');
    await genDone();
    assert(sent().includes('ADULT CONTENT') && sent().indexOf('ADULT CONTENT') < sent().indexOf('# TARGET MODEL'), 'sent after the master instructions, before the playbook');
    await click('.tabs button[data-view="settings"]');
    await click('#sAdult');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
  });

  await test('panels fold to a one-line summary, and stay folded after a reload', async () => {
    await click('.tabs button[data-view="create"]');
    await type('#theme', 'a lighthouse keeper making tea at dawn');
    await click('[data-panel="create-theme"] .collapse-btn');
    assert(!(await visible('#theme')), 'step 2 folded');
    eq(await text('[data-panel="create-theme"] .panel-summary'), 'a lighthouse keeper making tea at dawn', 'shows what it holds');
    await click('[data-panel="create-dials"] .step-head h2'); // the header itself folds too
    assert((await text('[data-panel="create-dials"] .panel-summary')).includes('temp'), 'dials summary');
    await goto(`${APP}/#create`);
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded');
    assert(await js('document.querySelector(\'[data-panel="create-theme"]\').classList.contains("collapsed")'), 'remembered after a reload');
    assert(await js('!document.querySelector(\'[data-panel="create-model"]\').classList.contains("collapsed")'), 'the others as you left them');
    await click('[data-panel="create-theme"] .collapse-btn');
    await click('[data-panel="create-dials"] .collapse-btn');
    assert(await visible('#theme'), 'unfolded');
    // The model card and its sections fold too.
    await click('.tabs button[data-view="models"]');
    await waitFor('document.querySelector("#mName").value', 'a model open');
    await click('[data-panel="model-instructions"] .collapse-btn');
    assert(!(await visible('#mInstr')), 'instructions folded');
    assert(/\d+ words · \d+ sections/.test(await text('[data-panel="model-instructions"] .panel-summary')), 'says how long they are');
    assert(await js('document.querySelector(\'[data-panel="model-adult"]\').classList.contains("collapsed")'), 'adult examples start folded');
    await click('#modelForm .form-head .collapse-btn');
    assert(!(await visible('#mName')) && (await text('[data-panel="models-form"] > .panel-summary')).length > 0, 'the whole card folds to its name');
    await click('#modelForm .form-head .collapse-btn');
    await click('[data-panel="model-instructions"] .collapse-btn');
    assert(await visible('#mInstr'), 'unfolded');
    // Settings cards fold too.
    await click('.tabs button[data-view="settings"]');
    await click('[data-panel="set-thinking"] h2');
    assert((await text('[data-panel="set-thinking"] .panel-summary')).startsWith('Thinking'), 'Settings card summary');
    await click('[data-panel="set-thinking"] .collapse-btn');
    await click('.tabs button[data-view="create"]');
  });

  await test('offline copy: with the server off, the page still opens, then loads for real when it is back', async () => {
    await waitFor('navigator.serviceWorker.controller !== null', 'the page copy is kept', 10000);
    const conditions = offline => cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.send('Network.enable');
    await conditions(true);
    await js('document.documentElement.dataset.ready = ""');
    await cdp.send('Page.reload', {});
    await waitFor('document.querySelector("#bannerTitle")?.textContent === "Prompt Maker\'s server isn\'t running." && !document.querySelector("#banner").hidden', 'the offline page, with its banner', 10000);
    await shot('offline-page');
    await conditions(false);
    await waitFor('document.documentElement.dataset.ready === "1" && document.querySelector("#banner").hidden && document.querySelectorAll(".model-card").length > 0', 'reloaded for real once the server answers', 15000);
  });

  await test('history: list, search, filter, favorite, open', async () => {
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length >= 4', 'history cards');
    const total = await count('.hcard');
    await shot('07-history', { full: true });
    await type('#historySearch', 'teacup');
    eq(await count('.hcard'), 1, 'search narrows to 1');
    await type('#historySearch', '');
    eq(await count('.hcard'), total, 'search cleared');
    await click('#historyFilters button[data-id="krea2-raw"]');
    eq(await count('.hcard'), 1, 'filter to Krea');
    await click('#historyFilters button[data-id=""]');
    await click('.hcard:nth-of-type(1) .hstar');
    await waitFor('document.querySelector(".hcard:nth-of-type(1) .hstar").classList.contains("on")', 'starred');
    assert(await js('document.activeElement === document.querySelector(".hcard:nth-of-type(1) .hstar")'), 'focus stays on the star');
    await click('#historyFav');
    eq(await count('.hcard'), 1, 'favorites only');
    await click('#historyFav');
    const gust = await js('[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("gust") && c.querySelector(".hthumb img")) + 1');
    assert(gust > 0, 'found the image entry');
    await click(`.hcard:nth-of-type(${gust}) .htheme`);
    await waitFor('document.querySelector("#view-create").classList.contains("active")', 'back on Create');
    assert(await visible('.dz-preview img'), 'image restored');
    assert(await js('document.querySelector(\'#roleBlock [data-value="animate"]\').classList.contains("active")'), 'animate role restored');
    eq(await value('#theme'), 'a gust of wind blows through', 'theme restored');
    assert(await visible('.take .prompt-text'), 'take restored');
    await shot('08-opened-from-history', { full: true });
  });

  await test('history: delete with confirm', async () => {
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'cards');
    const before = await count('.hcard');
    const badge = Number(await text('#historyBadge'));
    await click('.hcard:last-of-type [data-act="delete"]');
    eq(await text('.hcard:last-of-type [data-act="delete"]'), 'Sure?', 'asks to confirm');
    await click('.hcard:last-of-type [data-act="delete"]');
    await waitFor(`document.querySelectorAll(".hcard").length === ${before - 1}`, 'card removed');
    eq(Number(await text('#historyBadge')), badge - 1, 'badge decremented');
  });

  await test('models: edit, dirty guard, switch', async () => {
    await click('.tabs button[data-view="models"]');
    await click('#modelList button[data-id="ltx-2-3"]');
    eq(await value('#mName'), 'LTX 2.3', 'LTX loaded in editor');
    assert(await visible('#mDur'), 'durations visible for video');
    await type('#mDesc', 'changed description');
    assert(await visible('#dirtyFlag'), 'unsaved flag');
    await click('#modelList button[data-id="krea2-raw"]');
    assert(await visible('#modelFormMsg'), 'guard message');
    eq(await value('#mName'), 'LTX 2.3', 'did not switch yet');
    await click('#modelList button[data-id="krea2-raw"]');
    eq(await value('#mName'), 'Krea 2 RAW', 'switched after second click');
    assert(!(await visible('#dirtyFlag')), 'clean after switching');
    assert(!(await visible('#mDur')), 'durations hidden for image model');
    await shot('09-models', { full: true });
  });

  await test('models: create, duplicate, delete', async () => {
    await click('#newModelBtn');
    await type('#mName', 'Test Wizard 9');
    eq(await text('#mId'), 'test-wizard-9', 'id preview');
    await choose('#mKind', 'video');
    assert(await visible('#mDur'), 'durations for video');
    await type('#mDur', '5s, 10s');
    eq(await count('#dDur option'), 2, 'duration defaults follow the list');
    await click('#saveModelBtn');
    await toastText('Saved');
    eq(await count('#modelList li'), 4, 'four models');
    eq(await count('.model-card'), 4, 'new model on Create');
    await click('#dupModelBtn');
    eq(await value('#mName'), 'Test Wizard 9 copy', 'duplicate name');
    await click('#saveModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 5', 'five models');
    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 4', 'copy deleted');
    await click('#modelList button[data-id="test-wizard-9"]');
    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 3', 'test model deleted');
  });

  await test('models: import JSON', async () => {
    const file = path.join(tmp, 'imported.json');
    await fs.writeFile(file, JSON.stringify({ name: 'Imported Model', kind: 'image', instructions: '## Hi', aspectRatios: ['1:1'] }));
    await setFiles('#importInput', [file]);
    await toastText('1 new');
    await waitFor('document.querySelectorAll("#modelList li").length === 4', 'imported model listed');
    await click('#modelList button[data-id="imported-model"]');
    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 3', 'imported model deleted');
  });

  await test('models: AI draft from docs', async () => {
    await click('#modelList button[data-id="krea2-raw"]');
    await click('#assist summary');
    await type('#draftDocs', 'Official docs: write subject first, then setting.');
    await click('#draftBtn');
    await waitFor('document.querySelector("#draftResult").value.includes("What this model is")', 'draft streaming');
    await waitFor('!document.querySelector("#draftUse").disabled', 'draft finished');
    await click('#draftUse');
    assert((await value('#mInstr')).includes('A mock model'), 'draft placed in instructions');
    assert(await visible('#dirtyFlag'), 'marked unsaved');
    await click('#modelList button[data-id="ltx-2-3"]');
    await click('#modelList button[data-id="ltx-2-3"]');
    eq(await value('#mName'), 'LTX 2.3', 'discarded draft by switching');
  });

  await test('models: edits go to your data folder; built-ins reset and come back', async () => {
    await click('#modelList button[data-id="minimax-h3"]');
    assert((await text('#mOrigin')).includes('built-in'), 'marked as built-in');
    assert(!(await visible('#resetModelBtn')), 'nothing to reset on an untouched built-in');
    await type('#mDesc', 'my private tweak');
    await click('#saveModelBtn');
    await toastText('Saved');
    const mine = path.join(dataDir, 'models', 'minimax-h3.json');
    eq(JSON.parse(await fs.readFile(mine, 'utf8')).description, 'my private tweak', 'your copy is in your data folder');
    eq(await fs.readFile(path.join(ROOT, 'playbooks', 'minimax-h3.json'), 'utf8'), shipped['minimax-h3.json'], 'the shipped playbook is untouched');
    assert((await text('#mOrigin')).includes('edited copy'), 'marked as your copy');
    await click('#resetModelBtn');
    await click('#resetModelBtn');
    await toastText('back to the built-in');
    assert((await value('#mDesc')) !== 'my private tweak', 'built-in text is back');
    assert(!(await fileExists(mine)), 'your copy is gone');
    assert(!(await visible('#resetModelBtn')), 'nothing left to reset');

    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('!document.querySelector(\'#modelList button[data-id="minimax-h3"]\')', 'gone from the list');
    eq(await count('.model-card'), 2, 'gone from Create');
    await waitFor('!document.querySelector("#restoreBuiltinsBtn").hidden', 'bring-back offered');
    assert((await text('#restoreBuiltinsBtn')).includes('MiniMax'), 'names it');
    await click('#restoreBuiltinsBtn');
    await toastText('Brought back');
    eq(await count('#modelList li'), 3, 'back in the list');
    eq(await count('.model-card'), 3, 'back on Create');
    assert(!(await visible('#restoreBuiltinsBtn')), 'nothing left to bring back');
  });

  await test('keyboard: Space on a model card keeps focus', async () => {
    await click('.tabs button[data-view="create"]');
    await js('document.querySelector(\'.model-card[data-id="krea2-raw"]\').focus()');
    await press(' ');
    assert(await js('document.activeElement?.dataset.id === "krea2-raw" && document.activeElement.classList.contains("active")'), 'focused card selected and still focused');
  });

  await test('surprise me can be undone', async () => {
    await type('#theme', 'my very own theme');
    await click('#surpriseBtn');
    assert((await value('#theme')) !== 'my very own theme', 'theme replaced');
    await click('#themeUndo');
    eq(await value('#theme'), 'my very own theme', 'undo restored it');
    assert(!(await visible('#themeUndo')), 'undo chip gone');
  });

  await test('opening history keeps your takes preference and offers undo', async () => {
    await click('#varSeg button[data-value="3"]');
    await type('#theme', 'my draft theme');
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'cards');
    const idx = await js('[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("teacup")) + 1');
    await click(`.hcard:nth-of-type(${idx}) button.open`);
    eq(await value('#theme'), 'a tiny dragon napping in a teacup', 'entry theme loaded');
    eq(await js('localStorage.getItem("pm.variations")'), '3', 'saved takes preference untouched');
    await click('#themeUndo');
    eq(await value('#theme'), 'my draft theme', 'draft restored');
    await click('#varSeg button[data-value="1"]');
  });

  await test('new session: clears theme, image and takes; undo brings them back', async () => {
    await click('.model-card[data-id="krea2-raw"]');
    await type('#theme', 'SLOWTEST owl');
    await click('#generateBtn');
    await waitFor('document.querySelector("#newBtn").hidden && !document.querySelector("#stopBtn").hidden', 'Stop takes New\'s place while cooking');
    await click('#stopBtn');
    await genDone();
    await type('#theme', 'a fox in a phone booth');
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector(".dz-preview").hidden && JSON.parse(localStorage.getItem("pm.image"))', 'image stored');
    await click('#generateBtn');
    await genDone();
    eq(await count('.take'), 1, 'one take');
    await click('#newBtn');
    await toastText('Fresh start');
    eq(await value('#theme'), '', 'theme cleared');
    assert(await js('document.querySelector(".dz-preview").hidden'), 'image removed');
    eq(await count('.take'), 0, 'takes cleared');
    assert(await visible('#resultsEmpty'), 'empty stage is back');
    assert(await js('document.activeElement === document.querySelector("#theme")'), 'ready to type');
    eq(await js('document.querySelector(".model-card.active")?.dataset.id'), 'krea2-raw', 'model kept');
    assert(await js('document.querySelector("#newBtn").disabled'), 'nothing left to clear');
    await shot('30-new-session');
    await click('#toast .toast-act');
    await toastText('Back where you were');
    eq(await value('#theme'), 'a fox in a phone booth', 'theme back');
    assert(!(await js('document.querySelector(".dz-preview").hidden')), 'image back');
    eq(await count('.take'), 1, 'take back');
    await click('#newBtn');
    await goto(`${APP}/#create`);
    eq(await value('#theme'), '', 'still clear after a reload');
    assert(await js('document.querySelector(".dz-preview").hidden'), 'no image after a reload');
  });

  await test('settings: unsaved edits survive a tab switch', async () => {
    await click('.tabs button[data-view="settings"]');
    await type('#sMax', '8192');
    assert(await visible('#settingsDirty'), 'unsaved tag');
    await click('.tabs button[data-view="create"]');
    await click('.tabs button[data-view="settings"]');
    eq(await value('#sMax'), '8192', 'edit kept');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    assert(!(await visible('#settingsDirty')), 'clean after save');
  });

  await test('models: duplicate names are rejected', async () => {
    await click('.tabs button[data-view="models"]');
    await click('#newModelBtn');
    await type('#mName', 'Krea 2 RAW');
    await click('#saveModelBtn');
    await waitFor('document.querySelector("#modelFormMsg").textContent.includes("already called")', 'duplicate rejected');
    await click('#modelList button[data-id="krea2-raw"]');
    await click('#modelList button[data-id="krea2-raw"]');
    eq(await value('#mName'), 'Krea 2 RAW', 'back on the real model');
  });

  await test('settings: test connection, reject internet URL', async () => {
    await click('.tabs button[data-view="settings"]');
    await click('#sTest');
    await waitFor('document.querySelector("#sTestResult").textContent.includes("Connected")', 'connection ok');
    await type('#sUrl', 'http://example.com');
    await click('#settingsForm button[type="submit"]');
    await toastText('Offline mode');
    await type('#sUrl', `http://127.0.0.1:${MOCK_PORT}`);
    await click('#sResetMaster');
    assert((await value('#sMaster')).startsWith('You are an expert prompt engineer'), 'master prompt reset');
    await shot('10-settings', { full: true });
  });

  // ---------------- ComfyUI renders ----------------

  await test('converter: saved workflow → API format', async () => {
    const api = convertUiWorkflow(SAVED_WORKFLOW, OBJECT_INFO);
    eq(Object.keys(api).sort().join(','), '3,4,5,6,7,8,9', 'runnable nodes (note dropped)');
    eq(JSON.stringify(api['3'].inputs), JSON.stringify({ seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }), 'KSampler inputs (control value skipped)');
    eq(api['6']._meta.title, 'Positive Prompt', 'titles kept');
  });

  await test('settings: ComfyUI connection', async () => {
    await click('.tabs button[data-view="settings"]');
    await click('#sComfyTest');
    await waitFor('document.querySelector("#sComfyResult").textContent.includes("Connected to ComfyUI 0.38.0-mock")', 'ComfyUI connected');
    assert((await text('#sComfyResult')).includes('Mock GPU (8 GB)'), 'GPU shown');
  });

  await test('workflows: add from the ComfyUI library (auto setup)', async () => {
    await click('.tabs button[data-view="models"]');
    await click('#modelList button[data-id="krea2-raw"]');
    assert((await text('#wfList')).includes('No workflows yet'), 'empty state');
    await click('#addWorkflowBtn');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    await waitFor('!!document.querySelector(\'#wfSaved button[data-path="Mock T2I.json"]\')', 'saved workflows listed');
    eq(await count('#wfSaved button'), 1, 'hidden files skipped');
    await shot('20-wf-pick');
    await click('#wfSaved button[data-path="Mock T2I.json"]');
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    eq(await value('#mapPrompt select'), '6|text', 'prompt → positive encoder, not the negative');
    eq(await value('#mapWidth'), '5|width', 'width');
    eq(await value('#mapHeight'), '5|height', 'height');
    assert((await text('#optSeedLabel')).includes('1 seed input'), 'seed found');
    await shot('21-wf-setup');
    await click('#wfSave');
    await toastText('is ready');
    assert(!(await js('document.querySelector("#wfDialog").open')), 'dialog closed');
    eq(await count('#wfList .wf-row'), 1, 'listed');
    eq(await js('[...document.querySelectorAll("#wfList .wf-maps span.on")].map(s => s.textContent.trim()).join(",")'), '✍️ Prompt,📐 Size,🎲 Seed', 'mapping chips');
    assert((await text('#modelList button[data-id="krea2-raw"]')).includes('🎨 1'), 'count in model list');
  });

  let renderedText = '';
  await test('render: a take becomes an image, live', async () => {
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a lighthouse at dusk');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector(".take .render-bar .rb-go")', 'render bar');
    renderedText = await value('.take .prompt-text');
    const before = comfy.prompts.length;
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile.running")', 'running tile');
    await waitFor('/\\d+%/.test(document.querySelector(".take .rtile.running .rt-pct")?.textContent || "")', 'live progress %');
    await shot('22-rendering');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'finished image', 10000);
    await toastText('render ready');
    eq(comfy.prompts.length, before + 1, 'one prompt queued');
    const sent = comfy.prompts.at(-1).prompt;
    eq(sent['6'].inputs.text, renderedText, 'take text injected');
    eq(sent['7'].inputs.text, 'blurry, low quality, watermark', 'negative untouched');
    assert(sent['5'].inputs.width % 16 === 0 && sent['5'].inputs.height % 16 === 0 && sent['5'].inputs.width >= 512, 'size set from the take');
    assert(Number.isInteger(sent['3'].inputs.seed) && sent['3'].inputs.seed !== 42, 'fresh seed');
    await shot('23-rendered', { full: true });
  });

  await test('render: lightbox', async () => {
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox open');
    assert((await text('#lbInfo')).includes('Mock T2I'), 'workflow shown');
    assert((await text('#lbInfo .lb-prompt')) === renderedText, 'prompt shown');
    assert(await visible('#lbStage img'), 'image shown');
    await shot('24-lightbox');
    await press('Escape');
    assert(await js('document.querySelector("#lightbox").hidden'), 'Esc closes');
  });

  await test('seed: random, keep it, fixed, ×2, +1, −1, the setup and the lightbox agree', async () => {
    await openPanel('create-render-adv');
    const seedOf = (k = -1) => comfy.prompts.at(k).prompt['3'].inputs.seed;
    const renderOnce = async n => {
      const before = await count('.take .rtile img');
      await click('.take .rb-go');
      await waitFor(`document.querySelectorAll(".take .rtile img").length === ${before + n} && !document.querySelector(".take .rtile.running")`, 'rendered', 12000);
    };
    await waitFor('!document.querySelector("#wfpSeed").hidden', 'a seed row in step 5');
    assert(await js('document.querySelector(\'#wfpSeed [data-value="random"]\').classList.contains("active")'), 'random by default');
    const last = seedOf();
    await waitFor(`document.querySelector("#wfpSeed .seed-last")?.textContent.includes("${last}")`, 'it shows the last seed');
    eq(await text('.take .rb-seed'), '🎲 Random seed', 'and the take says random');
    await shot('27-seed-random');
    await click('#wfpSeed [data-act="keep"]');
    await waitFor(`document.querySelector("#wfpSeed .seed-val")?.value === "${last}"`, 'kept: fixed at the last seed');
    eq(await text('.take .rb-seed'), `🔒 Seed ${last}`, 'the take shows it');
    await click('.take .rb-count button[data-value="2"]');
    await renderOnce(2);
    eq(seedOf(-2), last, 'first render uses the fixed seed');
    eq(seedOf(-1), last + 1, '×2 in one go: the second steps by one');
    await click('.take .rb-count button[data-value="1"]');
    await renderOnce(1);
    eq(seedOf(), last, 'fixed stays fixed');

    await click('#wfpSeed [data-value="increment"]');
    await type('#wfpSeed .seed-val', '1000');
    await press('Enter');
    await waitFor('document.querySelector("#wfpSeed .dn-hint").textContent.includes("Next render: 1000, then 1001")', 'it says what comes next');
    await shot('28-seed-increment');
    await renderOnce(1);
    eq(seedOf(), 1000, 'increment starts at the seed');
    await waitFor('document.querySelector("#wfpSeed .seed-val").value === "1001"', 'then moves up by one');
    await renderOnce(1);
    eq(seedOf(), 1001, 'the next render uses the next seed');
    await click('#wfpSeed [data-value="decrement"]');
    await renderOnce(1);
    eq(seedOf(), 1002, 'decrement starts where increment left off');
    await waitFor('document.querySelector("#wfpSeed .seed-val").value === "1001"', 'then moves down by one');

    await click('.take .rb-tune');
    await waitFor('document.querySelector("#wfDialog").open && !document.querySelector("#wfSetup").hidden', 'setup open');
    eq(await value('#optSeedMode'), 'decrement', 'the setup shows the same mode');
    eq(await value('#samplerCtl .sp-field[data-key="3|seed"] input'), '1001', 'and the same next seed');
    await click('#wfClose');

    await click('#wfpSeed [data-value="random"]');
    await renderOnce(1);
    const fresh = seedOf();
    assert(fresh < 1000 || fresh > 1002, 'random again');
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="seed"]');
    await toastText('now renders with seed');
    await press('Escape');
    await waitFor(`document.querySelector("#wfpSeed .seed-val")?.value === "${fresh}"`, 'the render\'s seed is now fixed');
    await click('#wfpSeed [data-value="random"]');
  });

  await test('workflow sampler settings: see them, change them, lock CFG 1', async () => {
    assert((await text('.take .rb-settings')).includes('euler · normal'), 'render bar shows the sampler');
    assert((await text('.take .rb-settings')).includes('20 steps') && (await text('.take .rb-settings')).includes('CFG 7'), 'steps and CFG shown');
    await click('.take .rb-tune');
    await waitFor('document.querySelector("#wfDialog").open && !document.querySelector("#wfSetup").hidden', 'settings open from Create');
    const field = k => `#samplerCtl .sp-field[data-key="3|${k}"]`;
    eq(await value(`${field('steps')} input`), '20', 'steps shown');
    eq(await value(`${field('cfg')} input`), '7', 'cfg shown');
    eq(await value(`${field('sampler_name')} select`), 'euler', 'sampler shown');
    eq(await value(`${field('scheduler')} select`), 'normal', 'scheduler shown');
    assert(await js(`document.querySelector('${field('seed')} input').disabled`), 'seed field idle while randomized');
    await type(`${field('cfg')} input`, '5');
    await type(`${field('steps')} input`, '12');
    await choose(`${field('sampler_name')} select`, 'dpmpp_2m');
    assert(await js(`document.querySelector('${field('cfg')}').classList.contains('edited')`), 'edited fields are marked');
    await shot('26-sampler-settings');
    await click('#wfSave');
    await toastText('Workflow updated');
    await waitFor('document.querySelector(".take .rb-settings").textContent.includes("dpmpp_2m")', 'summary updated');
    assert((await text('.take .rb-settings')).includes('12 steps') && (await text('.take .rb-settings')).includes('CFG 5'), 'new values in summary');
    await click('.take .rb-count button[data-value="1"]');
    await click('.take .rb-go');
    await waitFor('!document.querySelector(".take .rtile.running")', 'rendered', 10000);
    const ks = comfy.prompts.at(-1).prompt['3'].inputs;
    eq(`${ks.cfg}/${ks.steps}/${ks.sampler_name}/${ks.scheduler}`, '5/12/dpmpp_2m/normal', 'ComfyUI got the new settings');
  });

  await test('render: cancel mid-render', async () => {
    await type('#theme', 'SLOWRENDER harbor at night');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector(".take .rb-go")', 'render bar');
    await click('.take .rb-count button[data-value="1"]');
    await click('.take .rb-go');
    await waitFor('/[1-9]\\d*%/.test(document.querySelector(".take .rtile.running .rt-pct")?.textContent || "")', 'running');
    await click('.take .rtile.running .rt-cancel');
    await waitFor('!document.querySelector(".take .rtile.running")', 'tile gone', 8000);
    await toastText('Render stopped');
  });

  await test('render: ComfyUI error is explained', async () => {
    await type('#theme', 'COMFYFAIL scene');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector(".take .rb-go")', 'render bar');
    await click('.take .rb-go');
    await waitFor('document.querySelector("#stageError") && !document.querySelector("#stageError").hidden', 'error card', 8000);
    assert((await text('#stageError')).includes('Mock sampler exploded'), 'ComfyUI error surfaced');
    assert(await visible('.take .rtile.failed'), 'failed tile');
  });

  await test('render: ComfyUI offline → clear message, reconnects', async () => {
    await comfy.stop();
    await click('.take .rb-go');
    await waitFor('document.querySelector("#stageError") && document.querySelector("#stageError").textContent.includes("reach ComfyUI")', 'offline error', 8000);
    await waitFor('document.querySelector(".take .rb-status")?.textContent.includes("offline")', 'offline badge');
    await comfy.start();
    await waitFor('!document.querySelector(".take .rb-status")?.textContent.includes("offline")', 'reconnected on its own', 9000);
    await toastText('ComfyUI is connected');
  });

  await test('gallery: every render, opens back into Create', async () => {
    await click('.tabs button[data-view="gallery"]');
    await waitFor('document.querySelectorAll(".gtile").length >= 3', 'gallery tiles');
    eq(await text('#galleryCount'), String(await count('.gtile')), 'count');
    await shot('25-gallery', { full: true });
    await click('.gtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="open"]');
    await waitFor('document.querySelector("#view-create").classList.contains("active")', 'back on Create');
    eq(await value('#theme'), 'a lighthouse at dusk', 'entry restored');
    await waitFor('document.querySelectorAll(".take .rtile img").length >= 3', 'renders restored with the take');
  });

  await test('render: delete from the lightbox', async () => {
    const before = await count('.take .rtile img');
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="delete"]');
    await click('[data-lb="delete"]');
    await toastText('Render deleted');
    await press('Escape');
    eq(await count('.take .rtile img'), before - 1, 'one fewer');
  });

  await test('lightbox: use a render as the next input image', async () => {
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="use"]');
    await waitFor('!document.querySelector(".dz-preview").hidden', 'render became the input image');
    await toastText('Render set as your image');
    assert(await visible('#roleBlock'), 'image modes offered');
    await click('#imageClear');
  });

  await test('render all takes at once', async () => {
    await click('#varSeg button[data-value="2"]');
    await type('#theme', 'twin lighthouses');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector("#renderAllBtn")', 'render-all button');
    const before = comfy.prompts.length;
    await click('#renderAllBtn');
    await waitFor(`document.querySelectorAll(".take .rtile img").length === 2 && !document.querySelector(".take .rtile.running")`, 'both takes rendered', 12000);
    eq(comfy.prompts.length, before + 2, 'one render per take');
    await click('#varSeg button[data-value="1"]');
  });

  await test('history cards show the latest render', async () => {
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'cards');
    const idx = await js('[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("a lighthouse at dusk")) + 1');
    assert(await js(`!!document.querySelector('.hcard:nth-of-type(${idx}) .hthumb img[src^="/renders/"]')`), 'render as the thumbnail');
    assert(/\d+ renders/.test(await text(`.hcard:nth-of-type(${idx}) .hthumb .tag`)), 'render count');
  });

  await test('brains: cards, records, suggestions, own Thinking level, Quick check', async () => {
    // a refusal counts against the Brain
    await click('.tabs button[data-view="create"]');
    await type('#theme', 'REFUSETEST a quiet harbor');
    await click('#generateBtn');
    await genDone();

    // the picker suggests Brains for the model on Create, with the reason
    const group = await js('document.querySelector("#llmSelect optgroup")?.label');
    assert(group.startsWith('Suggested for'), `first group is the suggestions (got "${group}")`);
    assert(await js('[...document.querySelectorAll("#llmSelect optgroup:first-of-type option")].some(o => o.value === "mock/vision-8b" && /rendered/.test(o.textContent))'), 'the Brain you rendered with is suggested, saying why');

    await click('.tabs button[data-view="models"]');
    await click('.models-switch button[data-pane="brains"]');
    await waitFor('document.querySelector(\'.brain[data-id="mock/vision-8b"]\')?.textContent.includes("refused 1×")', 'Brain cards, with the refusal counted');
    eq(await js('location.hash'), '#models/brains', 'own address');
    assert(await visible('#modelsPane') === false, 'model editor hidden');
    eq(await js('document.querySelector("#brainList .brain").dataset.id'), 'mock/vision-8b', 'the Brain in use comes first');
    const card = await text('.brain[data-id="mock/vision-8b"]');
    assert(card.includes('per prompt'), 'speed from your runs');
    assert(/\d+ rendered/.test(card), 'record from History');
    assert(card.includes('8B · Q4_K_M · 6.2 GB') && card.includes('🛠 tools'), "LM Studio's facts");
    assert((await text('.brain[data-id="mock/fable"]')).includes('switches it off another way'), 'thinking behavior learned earlier');
    assert(!(await js('document.querySelector("#brainsNew").hidden')), 'unused Brains are folded away');
    assert(await js('!!document.querySelector("#brainListNew .brain[data-id=\\"mock/fresh\\"]")'), 'the never-used Brain is in the fold');

    // a Brain's own Thinking level wins over Settings
    await choose('.brain[data-id="mock/thinker"] select[data-act="thinking"]', 'default');
    await toastText("Thinking Model's default");
    await click('.brain[data-id="mock/thinker"] button[data-act="use"]');
    await toastText('Brain: Mock Thinker 9B');
    assert((await js('document.querySelector("#llmBox").title')).includes("Thinking: Model's default (this Brain's own setting)"), 'tooltip shows its own level');
    await click('.tabs button[data-view="create"]');
    await type('#theme', 'a paper boat on a pond');
    await click('#generateBtn');
    await genDone();
    eq(lastCall().reasoning_effort, undefined, 'its own level was used');
    await click('.tabs button[data-view="models"]');
    await choose('.brain[data-id="mock/thinker"] select[data-act="thinking"]', '');
    await toastText('follows Settings (Off)');
    await click('.brain[data-id="mock/vision-8b"] button[data-act="use"]');
    await toastText('Brain: Mock Vision 8B');

    // Quick check: loads the Brain, writes an image and a video prompt; text-only Brains skip the image test
    await js('document.querySelector("#brainsNew").open = true');
    const before = mockCalls();
    await click('.brain[data-id="mock/fresh"] button[data-act="check"]');
    await toastText('Mock Fresh 3B passed the Quick check');
    eq(mock.log[before].messages[0].content, 'Say OK.', 'loaded first');
    eq(mockCalls(), before + 3, 'then an image and a video prompt');
    const fresh = await text('#brainList .brain[data-id="mock/fresh"]');
    assert(fresh && /✓ image .*✓ video/.test(fresh) && !fresh.includes('sees images'), 'results on its card, out of the fold');
    await click('.brain[data-id="mock/vision-8b"] button[data-act="check"]');
    await toastText('Mock Vision 8B passed the Quick check');
    assert((await text('.brain[data-id="mock/vision-8b"]')).includes('✓ sees images'), 'vision test passed');
    await shot('brains');
    await click('.models-switch button[data-pane="models"]');
    eq(await js('location.hash'), '#models', 'back to the model editor');
  });

  await test('brain picker: type to find a Brain, sort by last used or name; Brains page search', async () => {
    await click('.tabs button[data-view="create"]');
    await click('#llmPick');
    assert(await visible('#llmMenu'), 'menu opens');
    eq(await js('document.activeElement.id'), 'llmSearch', 'focus in the search box');
    await type('#llmSearch', 'think');
    eq(await count('#llmList [role="option"]'), 1, 'narrowed to one');
    eq(await text('#llmList [role="option"] mark'), 'Think', 'match highlighted');
    await press('Enter');
    await toastText('Brain: Mock Thinker 9B');
    assert(!(await visible('#llmMenu')), 'closed after picking');
    eq(await value('#llmSelect'), 'mock/thinker', 'Brain set');
    eq(await text('#llmPickName'), '👁 Mock Thinker 9B', 'button shows it');

    // words in any order, arrow keys move the highlight
    await click('#llmPick');
    await type('#llmSearch', '8b vision');
    eq(await js('[...document.querySelectorAll("#llmList [role=option]")].map(o => o.dataset.id).join()'), 'mock/vision-8b', 'every word must match');
    await type('#llmSearch', 'mock');
    await press('ArrowDown');
    eq(await js('document.querySelector("#llmList .active").dataset.i'), '1', 'arrow moves the highlight');
    await type('#llmSearch', 'vision');
    await press('Enter');
    await toastText('Brain: Mock Vision 8B');

    // last used: the Brain that just wrote comes first
    await type('#theme', 'a kite over the dunes');
    await click('#generateBtn');
    await genDone();
    await click('#llmPick');
    await click('.llm-sort button[data-sort="recent"]');
    eq(await js('[...document.querySelectorAll("#llmList .grp")].map(g => g.textContent).join("|")'), 'In use|Last used|Not used yet', 'the Brain in use on top, then grouped by use');
    eq(await js('document.querySelector("#llmList .grp + [role=option]").dataset.id'), 'mock/vision-8b', 'in use: the current Brain');
    assert((await text('#llmList [data-id="mock/vision-8b"] .d')).includes('used just now'), 'says when');
    await type('#llmSearch', 'mo');
    await shot('brain-picker');
    await type('#llmSearch', '');
    await click('.llm-sort button[data-sort="name"]');
    const names = await js('[...document.querySelectorAll("#llmList .grp:last-of-type ~ [role=option]")].map(o => o.querySelector(".n").textContent.replace("👁 ", ""))');
    eq(names.join('|'), [...names].sort((a, b) => a.localeCompare(b)).join('|'), 'A to Z');
    await click('.llm-sort button[data-sort="smart"]');
    // Filters: one at a time, with counts.
    await click('#llmFilters [data-filter="vision"]');
    assert(await js('[...document.querySelectorAll("#llmList [role=option]")].every(o => o.querySelector(".n").textContent.startsWith("👁"))'), 'vision only');
    assert(!(await js('!!document.querySelector(\'#llmList [data-id="mock/text-only"]\')')), 'text-only Brains hidden');
    assert(/Vision \d+/.test(await text('#llmFilters [data-filter="vision"]')), 'with a count');
    await click('#llmFilters [data-filter="all"]');
    await press('Escape');
    assert(!(await visible('#llmMenu')), 'Esc closes');

    // Models → Brains: search and sort
    await click('.tabs button[data-view="models"]');
    await click('.models-switch button[data-pane="brains"]');
    await type('#brainSearch', 'fresh');
    eq(await js('[...document.querySelectorAll("#brainList .brain")].map(b => b.dataset.id).join()'), 'mock/fresh', 'search narrows the cards');
    await type('#brainSearch', 'zzz');
    assert((await text('#brainsEmpty')).includes('No Brain matches'), 'says when nothing matches');
    await type('#brainSearch', '');
    await click('.brain-sort button[data-sort="name"]');
    const cards = await js('[...document.querySelectorAll("#brainList .brain .brain-name")].map(n => n.textContent)');
    eq(cards.join('|'), [...cards].sort((a, b) => a.localeCompare(b)).join('|'), 'cards A to Z, none folded');
    assert(await js('document.querySelector("#brainsNew").hidden'), 'no fold when sorted by name');
    await click('.brain-sort button[data-sort="fit"]');
    await click('.models-switch button[data-pane="models"]');
  });

  await test('workflows: upload an API file, pick between two, export, delete', async () => {
    await click('.tabs button[data-view="models"]');
    await click('#modelList button[data-id="krea2-raw"]');
    await click('#addWorkflowBtn');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    await click('.wf-tabs button[data-value="upload"]');
    await setFiles('#wfFile', [apiWorkflowFile]);
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    eq(await value('#mapPrompt select'), '6|text', 'mapped from an API file too');
    assert(await js('document.querySelector(\'#samplerCtl .sp-field[data-key="3|cfg"] input\').disabled'), 'CFG 1 is locked');
    await click('#samplerCtl .sp-field[data-key="3|cfg"] .sp-unlock');
    assert(!(await js('document.querySelector(\'#samplerCtl .sp-field[data-key="3|cfg"] input\').disabled')), 'unlocks on request');
    await type('#wfName', 'Uploaded API flow');
    await click('#wfSave');
    await toastText('is ready');
    eq(await count('#wfList .wf-row'), 2, 'two workflows');
    await click('#wfList .wf-row:nth-child(2) [data-act="export"]');
    await toastText('Workflow exported');
    await click('#wfList .wf-row:nth-child(2) [data-act="delete"]');
    await click('#wfList .wf-row:nth-child(2) [data-act="delete"]');
    await waitFor('document.querySelectorAll("#wfList .wf-row").length === 1', 'deleted');
  });

  await test('create: pick, add, edit and delete workflows without leaving Create', async () => {
    const picked = () => js('document.querySelector("#wfpSelect").selectedOptions[0]?.textContent');
    const optionId = name => js(`[...document.querySelectorAll("#wfpSelect option")].find(o => o.textContent === ${q(name)})?.value`);
    const setupOpen = () => waitFor('document.querySelector("#wfDialog").open && !document.querySelector("#wfSetup").hidden', 'workflow setup open');
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="krea2-raw"]');
    assert(await visible('#wfpBox'), 'picker shown');
    eq(await count('#wfpSelect option'), 1, 'one workflow');
    eq(await picked(), 'Mock T2I', 'it is picked');
    assert((await text('#wfpSettings')).includes('dpmpp_2m'), 'its sampler settings are shown');
    assert((await text('#comfyState')).includes('ComfyUI ready'), 'ComfyUI status');

    await click('#wfpAdd');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    assert((await text('#wfDialogTitle')).includes('Krea 2 RAW'), 'adds to the model picked on Create');
    await click('.wf-tabs button[data-value="upload"]');
    await setFiles('#wfFile', [apiWorkflowFile]);
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    await type('#wfName', 'Turbo flow');
    await click('#wfSave');
    await toastText('is ready');
    assert(await js('document.querySelector("#view-create").classList.contains("active")'), 'still on Create');
    eq(await count('#wfpSelect option'), 2, 'two workflows');
    eq(await picked(), 'Turbo flow', 'the new one is picked');
    assert((await text('#wfpSettings')).includes('CFG 1 🔒'), 'its settings are shown');
    const mockId = await optionId('Mock T2I');
    const turboId = await optionId('Turbo flow');

    await type('#theme', 'a paper boat in a gutter stream');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector(".take .rb-wf")', 'render bar');
    eq(await value('.take .rb-wf'), turboId, 'the take uses the picked workflow');
    await choose('#wfpSelect', mockId);
    eq(await value('.take .rb-wf'), mockId, 'the take follows the picker');
    assert((await text('.take .rb-settings')).includes('dpmpp_2m'), 'and so do its settings');
    await choose('.take .rb-wf', turboId);
    eq(await value('#wfpSelect'), turboId, 'the picker follows the take');
    await choose('#wfpSelect', mockId);

    await click('#wfpEdit');
    await setupOpen();
    eq(await value('#wfName'), 'Mock T2I', 'editing the picked workflow');
    assert(await visible('#wfDelete'), 'delete offered while editing');
    await type('#samplerCtl .sp-field[data-key="3|steps"] input', '9');
    await shot('31-wf-edit-from-create');
    await click('#wfSave');
    await toastText('Workflow updated');
    await waitFor('document.querySelector("#wfpSettings").textContent.includes("9 steps")', 'picker shows the new steps');
    assert((await text('.take .rb-settings')).includes('9 steps'), 'the take shows them too');
    await click('#wfpSettings');
    await setupOpen();
    assert(await js('document.activeElement?.closest("#samplerCtl")'), 'settings chips jump to the sampler');
    await click('#wfClose');

    await choose('#wfpSelect', turboId);
    await click('#wfpEdit');
    await setupOpen();
    await click('#wfDelete');
    await click('#wfDelete');
    await toastText('Workflow removed');
    assert(!(await js('document.querySelector("#wfDialog").open')), 'dialog closed');
    eq(await count('#wfpSelect option'), 1, 'one left');
    eq(await value('.take .rb-wf'), mockId, 'the take falls back to the one left');

    await click('#renderStep .switch');
    assert(await js('document.querySelector("#wfpAuto").checked'), 'auto-render on');
    await toastText('Auto-render on');
    let before = comfy.prompts.length;
    await type('#theme', 'a red kite over the dunes');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered with no click', 10000);
    eq(comfy.prompts.length, before + 1, 'one render queued by itself');
    eq(comfy.prompts.at(-1).prompt['6'].inputs.text, await value('.take .prompt-text'), 'the new take was sent');
    before = comfy.prompts.length;
    await click('.take .refine input');
    await click('.take .chips button');
    await waitFor('document.querySelectorAll(".take .rtile img").length === 2 && !document.querySelector(".take .rtile.running")', 'refined take rendered too', 12000);
    eq(comfy.prompts.length, before + 1, 'refining renders again');
    await shot('32-auto-render', { full: true });
    await click('#renderStep .switch');
    assert(!(await js('document.querySelector("#wfpAuto").checked')), 'auto-render off again');

    await viewport(390, 844, true);
    await sleep(200);
    eq(await js('document.documentElement.scrollWidth - innerWidth'), 0, 'no sideways scroll on a phone');
    await shot('33-picker-phone', { full: true });
    await viewport(1440, 900);

    await click('.model-card[data-id="ltx-2-3"]');
    assert(await visible('#wfpEmpty'), 'a model with no workflows gets the add prompt');
    assert(!(await visible('#wfpBox')), 'and no picker');
    assert((await text('#wfpEmpty')).includes('videos'), 'video wording');
    await click('#wfpAddFirst');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    assert((await text('#wfDialogTitle')).includes('LTX'), 'adds to LTX');
    await click('#wfClose');
    await click('.model-card[data-id="krea2-raw"]');
  });

  await test('chain: animate a still (first frame at full quality, linked both ways)', async () => {
    await click('.model-card[data-id="ltx-2-3"]');
    await click('#wfpAddFirst');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    await click('.wf-tabs button[data-value="upload"]');
    await setFiles('#wfFile', [i2vWorkflowFile]);
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    eq(await value('#mapImage'), '11|image', 'the Load Image node takes the frame');
    await type('#wfName', 'Mock I2V');
    await click('#wfSave');
    await toastText('is ready');
    assert((await text('#wfpWarn')).includes('needs an input image'), 'warns that this workflow wants a frame');

    await click('.model-card[data-id="krea2-raw"]');
    await type('#theme', 'a lighthouse keeper on the rocks');
    await click('#generateBtn');
    await genDone();
    const stillText = await value('.take .prompt-text');
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rcell .rt-next") && !document.querySelector(".take .rtile.running")', 'still rendered, with Animate', 10000);

    await click('.take .rcell .rt-next');
    await waitFor('document.querySelector(".model-card.active")?.dataset.id === "ltx-2-3" && !document.querySelector(".dz-preview").hidden && !document.querySelector("#dzSource").hidden', 'still loaded as the first frame');
    await toastText('Ready to animate');
    assert((await text('#dzSource')).startsWith('🔗 From Krea 2 RAW · take 1 · seed'), 'the image says where it came from');
    eq(await js('document.querySelector("#roleBlock .role.active")?.dataset.value'), 'animate', 'animate is picked');
    eq(await value('#theme'), '', 'the theme is free for the motion');
    assert(await visible('#themeUndo'), 'the still\'s theme can come back');
    assert((await js('document.querySelector("#theme").placeholder')).startsWith('What happens?'), 'the box asks what happens');
    assert(!(await visible('#wfpWarn')), 'the image-to-video workflow fits');
    await shot('34-animate-ready', { full: true });

    await type('#theme', 'the keeper raises a lantern');
    await click('#generateBtn');
    await genDone();
    const asked = JSON.stringify(lastCall().messages);
    assert(asked.includes('PREVIOUS STEP') && asked.includes(stillText.slice(0, 60)), 'the LLM gets the still\'s prompt as context');
    assert((await text('#srcLink')).includes('from Krea 2 RAW · take 1'), 'results link back to the still');
    const entry = (await (await fetch(`${APP}/api/history`)).json()).find(e => e.theme === 'the keeper raises a lantern');
    eq(entry.source.text, stillText, 'the link keeps the still\'s prompt');
    assert(/\.png$/.test(entry.source.file), 'the link points at the original render');

    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'video rendered', 10000);
    eq(comfy.uploads.at(-1), `prompt-maker_${entry.source.file}`, 'ComfyUI got the original render, not the smaller copy');
    eq(comfy.prompts.at(-1).prompt['11'].inputs.image, `prompt-maker_${entry.source.file}`, 'and it went into the first-frame input');
    await shot('35-animated', { full: true });

    await click('#srcLink');
    await waitFor('document.querySelector("#theme").value === "a lighthouse keeper on the rocks"', 'back on the still');
    eq(await js('document.querySelector(".model-card.active")?.dataset.id'), 'krea2-raw', 'with its model');

    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'cards');
    assert(await js('[...document.querySelectorAll(".hcard")].some(c => c.textContent.includes("the keeper raises a lantern") && c.querySelector(".hsrc")?.textContent.includes("from Krea 2 RAW"))'), 'History shows the link');
    await click('.tabs button[data-view="create"]');
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    assert(await visible('[data-lb="animate"]'), 'the lightbox offers Animate this');
    await press('Escape');
  });

  await test('workflows: edits made in ComfyUI are noticed and pulled in, setup kept', async () => {
    const setupOpen = () => waitFor('document.querySelector("#wfDialog").open && !document.querySelector("#wfSetup").hidden', 'workflow setup open');
    await click('.model-card[data-id="krea2-raw"]');
    eq(await js('document.querySelector("#wfpSelect").selectedOptions[0]?.textContent'), 'Mock T2I', 'the ComfyUI workflow is picked');
    assert(!(await visible('#wfpStale')), 'up to date at first');
    const id = await value('#wfpSelect');
    comfy.editSaved(w => { w.nodes.find(n => n.id === 7).widgets_values[0] = 'ugly, deformed'; return w; });
    await js('window.dispatchEvent(new Event("focus"))'); // coming back from the ComfyUI tab
    await waitFor('!document.querySelector("#wfpStale").hidden', 'noticed the edit made in ComfyUI');
    assert((await text('#wfpStale')).includes('was changed in ComfyUI'), 'says what happened');
    assert(await visible('.take .rb-stale'), 'the take\'s render bar says so too');
    await click('.tabs button[data-view="models"]');
    await click('#modelList button[data-id="krea2-raw"]');
    assert((await text('#wfList')).includes('changed in ComfyUI'), 'Models shows it too');
    await click('.tabs button[data-view="create"]');
    await shot('36-wf-changed');
    await click('#wfpStale button');
    await toastText('updated');
    assert(!(await visible('#wfpStale')), 'notice gone');
    const w = await (await fetch(`${APP}/api/workflows/${id}`)).json();
    eq(w.prompt['7'].inputs.text, 'ugly, deformed', 'the new version is in');
    eq(JSON.stringify(w.mapping.prompt), JSON.stringify([{ node: '6', input: 'text' }]), 'prompt spot kept');
    eq(w.overrides['3|steps'], 9, 'sampler tweaks kept');

    await type('#theme', 'a quiet harbor at dawn');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 10000);
    eq(comfy.prompts.at(-1).prompt['7'].inputs.text, 'ugly, deformed', 'ComfyUI got the updated workflow');
    eq(comfy.prompts.at(-1).prompt['3'].inputs.steps, 9, 'with your tweaks');

    // The prompt node got a new id in ComfyUI: that part of the setup can't be kept, so the setup opens for a check.
    comfy.editSaved(wf => {
      wf.nodes.find(n => n.id === 6).id = 16;
      wf.links.forEach(l => { if (l[1] === 6) l[1] = 16; if (l[3] === 6) l[3] = 16; });
      return wf;
    });
    await click('#wfpEdit');
    await setupOpen();
    eq(await text('#wfRefresh'), '↻ Update from ComfyUI', 'manual update offered');
    await click('#wfRefresh');
    await waitFor('!!document.querySelector("#wfWarnings .wf-note")', 'update note');
    assert((await text('#wfWarnings .wf-note')).includes('Couldn\'t keep where the prompt went'), 'explains what needs a check');
    eq(await value('#mapPrompt select'), '16|text', 'a new spot was picked for the prompt');
    await shot('37-wf-updated-review');
    await click('#wfSave');
    await toastText('Workflow updated');
    await click('#wfpEdit');
    await setupOpen();
    await click('#wfRefresh');
    await waitFor('document.querySelector("#wfWarnings .wf-note")?.textContent.includes("Already up to date")', 'nothing new');
    await click('#wfClose');
  });

  await test('chains: build one on Create, pick the stills, continue to video', async () => {
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="2"]');
    eq(await count('.chain-card'), 0, 'no Then steps yet');
    await click('#chainBox [data-act="add"]');
    eq(await count('.chain-card'), 1, 'a Then step');
    eq(await value('.chain-card [data-f="modelId"]'), 'ltx-2-3', 'a video model by default');
    eq(await value('.chain-card [data-f="use"]'), 'animate', 'the still becomes the first frame');
    eq(await js('document.querySelector(".chain-card [data-f=workflowId]").selectedOptions[0].textContent'), 'Mock I2V', 'an image-to-video workflow is picked');
    assert(await js('document.querySelector(\'.chain-gate button[data-gate="pick"]\').classList.contains("active")'), 'you pick by default');
    eq(await text('#genLabel'), 'Run chain', 'Generate becomes Run chain');
    eq(await text('#genCost'), '⛓ 2 stills → you pick → videos', 'it says what it will make');
    assert((await visible('#wfpRenders')) && !(await visible('#wfpAutoRow')), 'step 5 asks for renders per take instead');
    await type('.chain-card [data-f="direction"]', 'a calm sea');
    await type('#theme', 'a lighthouse in a storm');
    await shot('38-chain-built', { full: true });
    const before = comfy.prompts.length;
    await click('#generateBtn');
    await waitFor('!document.querySelector("#runStrip").hidden', 'run strip');
    await waitFor('document.querySelectorAll(".take .rt-pick").length === 2', 'two stills to pick from', 20000);
    eq(comfy.prompts.length, before + 2, 'each take rendered once');
    assert((await text('#runStrip .rs-status')).includes('Pick'), 'waiting for you');
    assert(await js('document.querySelector(\'#runStrip [data-act="continue"]\').disabled'), 'nothing picked yet');
    await click('.take .rt-pick');
    eq(await text('#runStrip [data-act="continue"]'), 'Continue ▶ 1', 'one picked');
    await type('.chain-card [data-f="direction"]', 'the waves crash against the rocks'); // decided after seeing the stills
    await shot('39-chain-pick', { full: true });
    await click('#runStrip [data-act="continue"]');
    await waitFor('document.querySelectorAll("#runStrip .rs-step:last-child .rs-chip").length === 1', 'step 2 started', 15000);
    await waitFor('document.querySelector("#runStrip .rs-status")?.textContent.includes("Done")', 'chain done', 20000);
    await toastText('Chain done');
    eq(await js('document.querySelector(".model-card.active")?.dataset.id'), 'krea2-raw', 'the form still shows step 1');
    assert((await text('#stageHead')).includes('LTX 2.3') && (await text('#srcLink')).includes('from Krea 2 RAW'), 'the stage shows the video step, linked to its still');
    const asked = JSON.stringify(lastCall().messages);
    assert(asked.includes('THEME: the waves crash against the rocks') && asked.includes('PREVIOUS STEP'), 'step 2 got the direction as changed while picking, and the still\'s prompt');
    const all = await (await fetch(`${APP}/api/history`)).json();
    const root = all.find(e => e.chain?.step === 0 && e.theme === 'a lighthouse in a storm');
    const child = all.find(e => e.chain?.runId === root.chain.runId && e.chain.step === 1);
    eq(root.chain.steps.length, 2, 'the run remembers its steps');
    eq(child.source.entryId, root.id, 'step 2 links to step 1');
    eq(comfy.uploads.at(-1), `prompt-maker_${child.source.file}`, 'the original still went to ComfyUI');
    await shot('40-chain-done', { full: true });
    await click('.take .refine input');
    await click('.take .chips button');
    await waitFor('document.querySelector(".take .vlabel")?.textContent === "v2/2"', 'refined the video prompt');
    await click('#runStrip .rs-step:first-child .rs-chip');
    await waitFor('document.querySelector("#stageHead")?.textContent.includes("Krea 2 RAW")', 'step 1 back on stage');
    assert(await js('[...document.querySelectorAll(".take .rt-pick")].some(b => b.textContent.includes("Used"))'), 'the still that went on is marked');
    await click('#runStrip .rs-step:last-child .rs-chip');
    await waitFor('document.querySelector(".take .vlabel")?.textContent === "v2/2"', 'the run kept the refined version');
  });

  await test('chains: auto runs straight through; save, reload, load, export, delete', async () => {
    await click('.chain-gate button[data-gate="auto"]');
    await click('#varSeg button[data-value="1"]');
    eq(await text('#genCost'), '⛓ 1 still → 1 video', 'auto goes the whole way');
    await click('#chainBox [data-act="save"]');
    await type('.chain-save input', 'My still to video');
    await press('Enter');
    await toastText('Saved the chain');
    eq(await js('document.querySelector(".cr-item.on button")?.textContent'), 'My still to video', 'listed and active');
    const before = comfy.prompts.length;
    await type('#theme', 'a fox in the snow');
    await click('#generateBtn');
    await waitFor('document.querySelector("#runStrip .rs-status")?.textContent.includes("Done")', 'ran straight through', 25000);
    eq(comfy.prompts.length, before + 2, 'one still and one video, no clicks');
    await goto(`${APP}/#create`);
    eq(await count('.chain-card'), 1, 'the chain being built survives a reload');
    eq(await text('#genLabel'), 'Run chain', 'still a chain');
    await click('.chain-card [data-act="remove"]');
    eq(await count('.chain-card'), 0, 'step removed');
    eq(await text('#genLabel'), 'Generate', 'back to a single step');
    await click('.cr-item button[data-recipe="my-still-to-video"]');
    await toastText('is set up');
    eq(await count('.chain-card'), 1, 'loading the chain brings its step back');
    assert((await value('.chain-card [data-f="direction"]')).includes('waves'), 'with its settings');
    assert(await js('document.querySelector(\'.chain-gate button[data-gate="auto"]\').classList.contains("active")'), 'and its gate');
    assert(await visible('.cr-item button[data-recipe="still-to-video"]'), 'the starter chains are there too');
    await click('.cr-item.on [data-act="export"]');
    await toastText('Exported');
    await click('.cr-item.on [data-act="delete-recipe"]');
    await click('.cr-item.on [data-act="delete-recipe"]');
    await toastText('Deleted the chain');
    assert(!(await js('!!document.querySelector(\'[data-recipe="my-still-to-video"]\')')), 'gone from the list');
    eq(await count('.chain-card'), 1, 'its steps stay in the form');
  });

  await test('chains: starter chains find your workflows; History reopens a run', async () => {
    await click('.cr-item button[data-recipe="still-to-video"]');
    eq(await count('.chain-card'), 1, 'one Then step');
    eq(await js('document.querySelector(".chain-card [data-f=workflowId]").selectedOptions[0]?.textContent'), 'Mock I2V', 'the starter chain found your image-to-video workflow');
    eq(await text('#genCost'), '⛓ 2 stills → you pick → videos', 'two stills, then you pick');
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'cards');
    const idx = await js('[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("a lighthouse in a storm") && c.querySelector(".tag.chain")) + 1');
    assert(idx > 0, 'the run is in History, marked as a chain');
    await click(`.hcard:nth-of-type(${idx}) button.open`);
    await waitFor('!document.querySelector("#runStrip").hidden', 'run reopened');
    eq(await count('#runStrip .rs-step'), 2, 'both steps');
    eq(await count('#runStrip .rs-chip'), 2, 'the still and the video');
    eq(await value('#theme'), 'a lighthouse in a storm', 'the form gets step 1 back');
    assert(await js('[...document.querySelectorAll(".chain-card [data-f=direction]")].some(t => t.value.includes("waves"))'), 'and the chain as it ran');
    assert(await visible('#runStrip [data-act="continue"]'), 'a finished run can still send another still on');
    await click('#resultsList .take:nth-of-type(2) .rt-pick');
    await click('#runStrip [data-act="continue"]');
    await waitFor('document.querySelectorAll("#runStrip .rs-step:last-child .rs-chip").length === 2 && document.querySelector("#runStrip .rs-status").textContent.includes("Done")', 'a second video from the other still', 20000);
    await click('#runStrip .rs-step:first-child .rs-chip');
    await waitFor('document.querySelectorAll(".take .rt-pick").length === 2 && [...document.querySelectorAll(".take .rt-pick")].every(b => b.textContent.includes("Used"))', 'both stills now marked as used');
    await viewport(390, 844, true);
    await sleep(200);
    eq(await js('document.documentElement.scrollWidth - innerWidth'), 0, 'no sideways scroll on a phone');
    await shot('41-chain-phone', { full: true });
    await viewport(1440, 900);
    await click('#runStrip [data-act="close"]');
    assert(!(await visible('#runStrip')), 'closed');
    while (await count('.chain-card')) await click('.chain-card [data-act="remove"]');
  });

  await test('LoRAs: the workflow\'s own and yours, from the model\'s folder, with strengths', async () => {
    await openPanel('create-render-adv');
    const lora = sel => `#wfpLoras ${sel}`;
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="krea2-raw"]');
    await click('#wfpAdd');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    await click('.wf-tabs button[data-value="upload"]');
    await setFiles('#wfFile', [loraWorkflowFile]);
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    await type('#wfName', 'Mock LoRA flow');
    await click('#wfSave');
    await toastText('is ready');
    eq(await js('document.querySelector("#wfpSelect").selectedOptions[0]?.textContent'), 'Mock LoRA flow', 'picked');
    eq(await count(lora('.lora-row')), 1, 'the workflow\'s own LoRA is listed');
    assert((await text(lora('.lora-row'))).includes('baked_in') && (await text(lora('.lora-row'))).includes('in workflow'), 'named, and marked as part of the workflow');
    eq(await value(lora('.lora-row .lr-num')), '0.50', 'at the workflow\'s strength');
    await type(lora('[data-key="20"] .lr-num'), '0.8');
    await press('Enter');
    await waitFor(`!!document.querySelector('${lora('[data-key="20"] .lr-reset')}')`, 'changed, with ↺ to go back');

    await click(lora('[data-act="lora-add"]'));
    await waitFor(`document.querySelectorAll('${lora('.lp-list button')}').length > 0`, 'the LoRA list');
    eq(await value(lora('.lp-folder')), 'krea2', 'the model\'s folder is picked for you');
    eq(await js(`[...document.querySelectorAll('${lora('.lp-list button')}')].map(b => b.dataset.lora).join(',')`), 'krea2/detail_slider.safetensors,krea2/film_grain.safetensors', 'only Krea LoRAs, minus the one already in');
    await type(lora('.lp-search'), 'grain');
    eq(await count(lora('.lp-list button')), 1, 'search narrows it');
    await click(lora('.lp-list button'));
    eq(await count(lora('.lora-row')), 2, 'added');
    await type(lora('[data-key="+0"] .lr-num'), '-0.5');
    await press('Enter');
    await waitFor('document.querySelector("#wfpSettings").textContent.includes("2 LoRAs")', 'the chips count them');
    await js('document.querySelector("#wfpLoras").scrollIntoView({ block: "center" })');
    await shot('42-loras');

    await type('#theme', 'a portrait in window light');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 10000);
    let p = comfy.prompts.at(-1).prompt;
    eq(p['20'].inputs.strength_model, 0.8, 'the workflow\'s LoRA re-weighted');
    eq(p.pm_lora_1?.inputs.lora_name, 'krea2/film_grain.safetensors', 'yours went in');
    eq(p.pm_lora_1.inputs.strength_model, -0.5, 'at your strength');
    eq(JSON.stringify(p.pm_lora_1.inputs.model), '["4",0]', 'right after the model loader');
    eq(JSON.stringify(p['20'].inputs.model), '["pm_lora_1",0]', 'feeding the rest of the chain');
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    assert((await text('#lbInfo')).includes('baked_in 0.80, film_grain -0.50'), 'the lightbox lists the LoRAs it used');
    await press('Escape');

    await click(lora('[data-key="20"] .switch'));
    await waitFor(`document.querySelector('${lora('[data-key="20"]')}').classList.contains('off')`, 'switched off');
    const id = await value('#wfpSelect');
    await waitFor(`fetch('/api/workflows').then(r => r.json()).then(l => l.find(w => w.id === ${q(id)})?.loras.tweaks['20']?.on === false)`, 'saved');
    await click('.take .rb-go');
    await waitFor('document.querySelectorAll(".take .rtile img").length === 2 && !document.querySelector(".take .rtile.running")', 'rendered again', 10000);
    p = comfy.prompts.at(-1).prompt;
    assert(!p['20'], 'switched off: left out of the render entirely');
    eq(JSON.stringify(p['3'].inputs.model), '["pm_lora_1",0]', 'the sampler gets your LoRA straight');

    await goto(`${APP}/#create`);
    eq(await count(lora('.lora-row')), 2, 'kept after a reload');
    assert(await js(`document.querySelector('${lora('[data-key="20"]')}').classList.contains('off')`), 'still off');
    await click('.model-card[data-id="ltx-2-3"]');
    await click(lora('[data-act="lora-add"]'));
    await waitFor(`document.querySelectorAll('${lora('.lp-list button')}').length > 0`, 'the LTX list');
    eq(await value(lora('.lp-folder')), 'LTX_2.3', 'LTX gets its own folder');
    eq(await js(`[...document.querySelectorAll('${lora('.lp-list button')}')].map(b => b.dataset.lora).join(',')`), 'LTX_2.3/motion_boost.safetensors', 'and only its LoRAs');
    await press('Escape');
    await click('.model-card[data-id="krea2-raw"]');
  });

  await test('assistant: sets up a shot, generates, adds a LoRA, explains; failures are safe', async () => {
    const bot = () => js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""');
    const acts = () => js('[...document.querySelectorAll("#asLog .as-act")].map(a => a.textContent).join(" | ")');
    const idle = () => waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    await click('#askBtn');
    await waitFor('!document.querySelector("#assistant").hidden && document.activeElement === document.querySelector("#asInput")', 'panel open, ready to type');
    assert(await visible('.as-hello'), 'a hello with starters');
    await type('#asInput', 'Set up a 9:16 shot of a surfer at golden hour, 2 takes');
    await press('Enter');
    await idle();
    assert((await bot()).includes('All set'), 'it says what it did');
    eq(await js('document.querySelector(".model-card.active")?.dataset.id'), 'krea2-raw', 'model set');
    eq(await value('#theme'), 'a surfer at golden hour', 'theme written');
    eq(await value('#aspect'), '9:16', 'aspect set');
    eq(await js('document.querySelector("#varSeg .active")?.dataset.value'), '2', 'takes set');
    const a = await acts();
    assert(a.includes('Model → Krea 2 RAW') && a.includes('Theme → “a surfer at golden hour”') && a.includes('aspect 9:16'), `each step shows: ${a}`);
    assert(lastCall().messages[0].content.includes('"theme": "a surfer at golden hour"') && lastCall().tools.length > 20, 'the brain sees the app and its tools');
    await shot('43-assistant');

    await type('#asInput', 'go');
    await press('Enter');
    await idle();
    eq(await count('#resultsList .take'), 2, 'two takes written');
    assert((await bot()).includes('ready'), 'and it says so');

    await type('#asInput', 'add the detail lora at 0.6');
    await press('Enter');
    await idle();
    assert((await acts()).includes('Added LoRA detail_slider at 0.60'), 'found the LoRA by part of its name');
    assert((await text('#wfpLoras')).includes('detail_slider'), 'it\'s in step 5');

    await type('#asInput', 'how do I add a LoRA?');
    await press('Enter');
    await idle();
    assert((await bot()).includes('Add LoRA'), 'answers from the guide');

    await type('#asInput', 'switch to the bogus model');
    await press('Enter');
    await idle();
    assert((await acts()).includes('There\'s no model called “nonexistent”'), 'a failing tool is shown, nothing breaks');
    assert((await bot()).includes('no model by that name'), 'and it tells you');

    await type('#asInput', 'tag fallback please');
    await press('Enter');
    await idle();
    eq(await value('#theme'), 'from a tag', 'tool calls written as text work too');

    await goto(`${APP}/#create`);
    await click('#askBtn');
    await waitFor('document.querySelectorAll("#asLog .as-msg.me").length === 6', 'the conversation is still there after a reload');
    await viewport(390, 844, true);
    await sleep(200);
    eq(await js('document.documentElement.scrollWidth - innerWidth'), 0, 'no sideways scroll on a phone');
    eq(await js('Math.round(document.querySelector("#assistant").getBoundingClientRect().width)'), 390, 'full width on a phone');
    await shot('44-assistant-phone');
    await viewport(1440, 900);
    await click('#asClear');
    await click('#asClear');
    assert(await visible('.as-hello'), 'cleared');
    // It can write a playbook for you, and undo it.
    const before = await (await fetch(`${APP}/api/models/krea2-raw`)).json();
    await type('#asInput', 'fix the playbook for krea');
    await press('Enter');
    await idle();
    assert((await acts()).includes('Saved the Krea 2 RAW'), 'saved, and says what changed');
    let after = await (await fetch(`${APP}/api/models/krea2-raw`)).json();
    eq(after.description, 'Edited by the assistant', 'the playbook changed');
    eq(after.instructions.trim(), before.instructions.trim(), 'fields it was not given stay');
    await type('#asInput', 'undo that');
    await press('Enter');
    await idle();
    after = await (await fetch(`${APP}/api/models/krea2-raw`)).json();
    eq(after.description, before.description, 'undo puts it back');
    eq(JSON.stringify(after.resolutions), JSON.stringify(before.resolutions), 'all of it');
    await press('Escape');
    assert(await js('document.querySelector("#assistant").hidden && document.activeElement === document.querySelector("#askBtn")'), 'Esc closes it');
  });

  await test('denoise: shown for image-to-image workflows, saved on the workflow', async () => {
    await openPanel('create-render-adv');
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="krea2-raw"]');
    assert(!(await visible('#wfpDenoise')), 'no denoise for a text-to-image workflow');
    await click('.model-card[data-id="ltx-2-3"]');
    await waitFor('!document.querySelector("#wfpDenoise").hidden', 'denoise for a workflow that takes an image');
    eq(await text('#wfpDenoise .dn-val'), '1.00', 'at the workflow\'s value');
    await js('const r = document.querySelector("#wfpDenoise .dn-range"); r.value = "0.55"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true }))');
    eq(await text('#wfpDenoise .dn-val'), '0.55', 'shows the new value');
    assert((await text('#wfpDenoise .dn-hint')).includes('keeps the layout'), 'says what it means');
    const id = await value('#wfpSelect');
    await waitFor(`fetch('/api/workflows').then(r => r.json()).then(l => l.find(w => w.id === ${q(id)})?.denoise[0].value === 0.55)`, 'saved on the workflow');
    await waitFor('document.querySelector("#wfpSettings").textContent.includes("denoise 0.55")', 'and in the settings chips');
    await click('#wfpEdit');
    await waitFor('document.querySelector("#wfDialog").open', 'setup open');
    eq(await value('#samplerCtl .sp-field[data-key="3|denoise"] input'), '0.55', 'the setup dialog shows it too');
    await click('#wfClose');
    await click('#wfpDenoise .dn-reset');
    await waitFor(`fetch('/api/workflows').then(r => r.json()).then(l => l.find(w => w.id === ${q(id)})?.denoise[0].value === 1)`, '↺ puts it back');
    await click('.model-card[data-id="krea2-raw"]');
  });

  await test('cleanup: a copied render is deleted from ComfyUI\'s output folder and gets its own name', async () => {
    await click('.tabs button[data-view="settings"]');
    assert(!(await visible('#sComfyDirField')), 'folder field hidden until cleanup is on');
    await click('#sComfyCleanup');
    assert(await visible('#sComfyDirField'), 'then shown');
    await waitFor(`document.querySelector('#sComfyDir').placeholder.includes(${q(path.join(comfyRoot, 'output'))})`, 'the output folder is found on its own');
    await click('#settingsForm button[type="submit"]');
    await waitFor('document.querySelector("#settingsDirty").hidden', 'saved'); // (another toast can cover "Settings saved")
    await click('.tabs button[data-view="create"]');
    await type('#theme', 'a red fox in fresh snow');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 10000);
    const made = comfy.prompts.at(-1).id.slice(0, 6);
    assert(!(await fileExists(path.join(comfyRoot, 'output', `mock_${made}.png`))), 'gone from ComfyUI\'s output folder');
    const entry = (await (await fetch(`${APP}/api/history`)).json()).find(e => e.theme === 'a red fox in fresh snow');
    const f = entry.variations[0].renders[0].files[0];
    assert(await fileExists(path.join(dataDir, 'renders', f.file)), 'the copy is in the data folder');
    assert(/^krea-2-raw_a-red-fox-in-fresh-snow_\d+_[0-9a-f]{6}\.png$/.test(f.name), `the copy has its own name: ${f.name}`);
    await fs.writeFile(path.join(comfyRoot, 'output', 'not-ours.png'), 'keep me');
    await click('.tabs button[data-view="settings"]');
    await click('#sComfyCleanup');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
    await click('.take .rb-go');
    await waitFor('document.querySelectorAll(".take .rtile img").length === 2 && !document.querySelector(".take .rtile.running")', 'rendered again', 10000);
    assert(await fileExists(path.join(comfyRoot, 'output', `mock_${comfy.prompts.at(-1).id.slice(0, 6)}.png`)), 'with cleanup off, ComfyUI keeps its file');
    assert(await fileExists(path.join(comfyRoot, 'output', 'not-ours.png')), 'other files are never touched');
  });

  await test('step 3: pick any image from the Gallery', async () => {
    await click('.tabs button[data-view="create"]');
    if (await visible('.dz-preview')) await click('#imageClear');
    await click('#dzGallery');
    await waitFor('document.querySelector("#imgPick").open && document.querySelectorAll("#imgPickGrid .ip-tile").length > 0', 'the picker shows your image renders');
    const all = await count('#imgPickGrid .ip-tile');
    if ((await count('#imgPickModels button')) > 1) {
      await click('#imgPickModels button[data-id="ltx-2-3"]');
      assert((await count('#imgPickGrid .ip-tile')) < all, 'filter by model');
      await click('#imgPickModels button[data-id=""]');
    }
    await shot('45-image-picker');
    await click('#imgPickGrid .ip-tile');
    await waitFor('!document.querySelector(".dz-preview").hidden && !document.querySelector("#dzSource").hidden', 'attached, linked to its render');
    await toastText('Image added');
    assert(!(await js('document.querySelector("#imgPick").open')), 'the picker closed');
    assert((await text('#dzSource')).startsWith('🔗 From '), 'it says where it came from');
    assert(await visible('#imageGallery'), 'and another can be picked from the Gallery');
    await click('#imageClear');
  });

  await test('security: other websites can\'t use the local API', async () => {
    const res = await fetch(`${APP}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"llmModel":"x"}' });
    eq(res.status, 403, 'cross-site write blocked');
    // fetch() won't send a custom Host header, so use a raw request.
    const rebind = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: APP_PORT, path: '/api/history', headers: { Host: `evil.example:${APP_PORT}` } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    eq(rebind, 403, 'DNS-rebinding host blocked');
    const ok = await fetch(`${APP}/api/models`);
    eq(ok.status, 200, 'local tools still work');
  });

  await test('routing: deep link + back button', async () => {
    await goto(`${APP}/#history`);
    assert(await js('document.querySelector("#view-history").classList.contains("active")'), 'deep link to history');
    await click('.tabs button[data-view="models"]');
    await js('history.back()');
    await waitFor('document.querySelector("#view-history").classList.contains("active")', 'back to history');
  });

  await test('responsive: no sideways scroll, screenshots', async () => {
    await goto(`${APP}/#create`);
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'cards');
    await click('.hcard:nth-of-type(1) button.open');
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector(".dz-preview").hidden', 'image attached');
    await click('.model-card[data-id="ltx-2-3"]');
    const sizes = [[360, 740, true], [390, 844, true], [820, 1180, true], [1024, 768, false], [1280, 800, false], [1920, 1080, false]];
    for (const [w, h, mobile] of sizes) {
      await viewport(w, h, mobile);
      for (const view of ['create', 'history', 'gallery', 'models', 'brains', 'settings']) {
        if (view === 'brains') await js(`document.querySelector('.models-switch button[data-pane="brains"]').click()`);
        else await js(`document.querySelector('.tabs button[data-view="${view}"]').click()`);
        await sleep(250);
        const overflow = await js('document.documentElement.scrollWidth - innerWidth');
        const culprit = overflow > 1 ? await js(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && e.offsetParent).slice(-4).map(e => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' r=' + Math.round(e.getBoundingClientRect().right)).join(' | ')`) : '';
        assert(overflow <= 1, `${view} at ${w}px scrolls sideways by ${overflow}px: ${culprit}`);
        await shot(`r-${w}-${view}`, { full: view === 'create' || view === 'models' });
        if (view === 'brains') await js(`document.querySelector('.models-switch button[data-pane="models"]').click()`);
      }
    }
    await viewport(1440, 900);
  });

  await test('storage: an old ./data folder moves out of the app folder', async () => {
    const app2 = path.join(tmp, 'old-install');
    for (const d of ['lib', 'public', 'playbooks', 'chains']) await fs.cp(path.join(ROOT, d), path.join(app2, d), { recursive: true });
    for (const f of ['server.js', 'package.json']) await fs.copyFile(path.join(ROOT, f), path.join(app2, f));
    const old = path.join(app2, 'data');
    for (const d of ['models', 'images', 'renders', 'workflows']) await fs.mkdir(path.join(old, d), { recursive: true });
    await fs.writeFile(path.join(old, 'settings.json'), JSON.stringify({ comfyUrl: 'http://127.0.0.1:9999' }));
    await fs.writeFile(path.join(old, 'history.json'), JSON.stringify([{ id: 'old-1', createdAt: '2026-09-01T00:00:00.000Z', theme: 'an old theme', modelId: 'krea2-raw', variations: [] }]));
    await fs.writeFile(path.join(old, 'images', 'a.jpg'), 'jpg');
    await fs.writeFile(path.join(old, 'renders', 'r.png'), 'png');
    await fs.writeFile(path.join(old, 'workflows', 'w1.json'), JSON.stringify({ id: 'w1', modelId: 'krea2-raw', name: 'Old flow', prompt: {}, mapping: {} }));
    await fs.copyFile(path.join(ROOT, 'playbooks', 'krea2-raw.json'), path.join(old, 'models', 'krea2-raw.json')); // an untouched built-in
    await fs.writeFile(path.join(old, 'models', 'my-model.json'), JSON.stringify({ id: 'my-model', name: 'My Model', kind: 'image', instructions: '## Mine' }));
    const home = path.join(tmp, 'home');
    const env = { ...process.env, PORT: String(APP_PORT + 1), HOME: home, XDG_DATA_HOME: path.join(home, 'xdg'), XDG_CONFIG_HOME: path.join(home, 'xdg-config'), SYSTEMCTL_BIN: fakeSystemctl, APPDATA: path.join(home, 'appdata') };
    delete env.PROMPT_MAKER_DATA;
    const srv = spawn(process.execPath, ['server.js'], { cwd: app2, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    srv.stdout.on('data', d => { log += d; });
    srv.stderr.on('data', d => { log += d; });
    try {
      for (let i = 0; i < 50 && !log.includes('running at'); i++) await sleep(100);
      assert(log.includes('running at'), `the old install starts:\n${log}`);
      assert(log.includes('Moved your data out of the app folder'), 'it says what it moved');
      const base = `http://127.0.0.1:${APP_PORT + 1}`;
      const get = p => fetch(`${base}${p}`).then(r => r.json());
      const settings = await get('/api/settings');
      const dir = settings.dataDir;
      assert(dir.startsWith(home) && !dir.startsWith(app2), `per-user data folder outside the app: ${dir}`);
      eq(await fileExists(old), false, 'the old data folder is gone');
      eq(settings.comfyUrl, 'http://127.0.0.1:9999', 'settings moved');
      eq((await get('/api/history'))[0]?.theme, 'an old theme', 'history moved');
      eq((await get('/api/workflows'))[0]?.name, 'Old flow', 'workflows moved');
      for (const f of ['images/a.jpg', 'renders/r.png', 'models/my-model.json']) assert(await fileExists(path.join(dir, f)), `${f} moved`);
      assert(!(await fileExists(path.join(dir, 'models', 'krea2-raw.json'))), 'an untouched copy of a built-in is dropped');
      const models = await get('/api/models');
      assert(models.some(m => m.id === 'my-model' && !m.builtin), 'your own model is there');
      assert(models.some(m => m.id === 'krea2-raw' && m.builtin && !m.edited), 'built-ins come from the app');
    } finally {
      srv.kill();
    }
  });

  await test('the app folder is never written to', async () => {
    eq(JSON.stringify((await fs.readdir(path.join(ROOT, 'playbooks'))).sort()), JSON.stringify(Object.keys(shipped).sort()), 'no files added to or removed from playbooks/');
    for (const [f, before] of Object.entries(shipped)) eq(await fs.readFile(path.join(ROOT, 'playbooks', f), 'utf8'), before, `playbooks/${f} unchanged`);
    eq(await fileExists(path.join(ROOT, 'data')), hadLegacyData, 'no data folder appears in the app folder');
    eq(JSON.stringify((await fs.readdir(path.join(ROOT, 'chains'))).sort()), JSON.stringify(Object.keys(shippedChains).sort()), 'no files added to or removed from chains/');
    for (const [f, before] of Object.entries(shippedChains)) eq(await fs.readFile(path.join(ROOT, 'chains', f), 'utf8'), before, `chains/${f} unchanged`);
  });

  await test('no console errors', async () => {
    assert(!problems.length, `console problems:\n      ${problems.join('\n      ')}`);
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}.`);
  if (appLog.includes('Error')) console.log(`\nApp server log:\n${appLog}`);
  const chromeExit = new Promise(r => chrome.once('exit', r));
  chrome.kill();
  app.kill();
  await Promise.race([chromeExit, sleep(3000)]);
  await mock.stop();
  await comfy.stop();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
