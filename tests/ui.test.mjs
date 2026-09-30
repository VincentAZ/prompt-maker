// End-to-end UI test: the real app server + a mock LM Studio + headless Chrome driven over the
// DevTools protocol. Clicks are real mouse events, so a button hidden under something else fails.
// Usage: node tests/ui.test.mjs [name-filter]   Screenshots go to $SHOTS (default: /tmp/prompt-maker-ui).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { startMock } from './mock-lmstudio.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_PORT = Number(process.env.APP_PORT) || 5399;
const MOCK_PORT = Number(process.env.MOCK_PORT) || 12399;
const CDP_PORT = Number(process.env.CDP_PORT) || 9333;
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

async function js(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
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
  const box = await js(`(() => {
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
  if (box.err) throw new Error(`click(${sel}): ${box.err}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(40);
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
  const codes = { Enter: 13, Escape: 27, ' ': 32 };
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
  await cdp.send('Page.navigate', { url });
  await sleep(150);
  await waitFor('document.documentElement.dataset.ready === "1"', 'app boot', 10000);
}

async function toastText(expected = '') {
  return waitFor(`(() => { const t = document.querySelector("#toast"); return !t.hidden && t.textContent.includes(${q(expected)}) && t.textContent; })()`, `toast "${expected}"`);
}

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
  await fs.mkdir(path.join(dataDir, 'models'), { recursive: true });
  for (const f of await fs.readdir(path.join(ROOT, 'data/models'))) {
    await fs.copyFile(path.join(ROOT, 'data/models', f), path.join(dataDir, 'models', f));
  }
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ lmStudioUrl: `http://127.0.0.1:${MOCK_PORT}`, llmModel: 'mock/vision-8b' }));
  const fixture = path.join(tmp, 'fixture.png');
  await fs.writeFile(fixture, makePng(640, 400));

  const mock = startMock(MOCK_PORT);
  await mock.start();

  const app = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT), PROMPT_MAKER_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await click('.model-card[data-id="ltx-2-3"]');
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
    await mock.start();
    await click('#bannerRetry');
    await waitFor('document.querySelector("#banner").hidden', 'banner cleared');
    assert(await js('document.querySelector("#llmDot").classList.contains("ok")'), 'green dot again');
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
      for (const view of ['create', 'history', 'models', 'settings']) {
        await js(`document.querySelector('.tabs button[data-view="${view}"]').click()`);
        await sleep(250);
        const overflow = await js('document.documentElement.scrollWidth - innerWidth');
        assert(overflow <= 1, `${view} at ${w}px scrolls sideways by ${overflow}px`);
        await shot(`r-${w}-${view}`, { full: view === 'create' });
      }
    }
    await viewport(1440, 900);
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
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
