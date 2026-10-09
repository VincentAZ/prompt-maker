// End-to-end UI test: the real app server + a mock LM Studio + headless Chrome driven over the
// DevTools protocol. Clicks are real mouse events, so a button hidden under something else fails.
// Usage: node tests/ui.test.mjs [name-filter]   (several filters: "a|b")   Screenshots go to $SHOTS (default: /tmp/prompt-maker-ui).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { startMock } from './mock-lmstudio.mjs';
import { startMockComfy, SAVED_WORKFLOW, OBJECT_INFO, MODEL_BYTES } from './mock-comfyui.mjs';
import { convertUiWorkflow, pruneToOutputs } from '../lib/comfy-convert.js';
import * as wfLib from '../lib/workflows.js';
import * as modelsLib from '../lib/models.js';
import * as videotools from '../lib/videotools.js';
import * as comfyLib from '../lib/comfy.js';

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
  // A click is lost when the page redraws the element between press and release (a person would click again).
  for (let attempt = 0; ; attempt++) {
    const before = await js('window.__input?.clicks ?? -1');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(40);
    if (before < 0 || attempt === 1 || (await js('window.__input?.clicks ?? -1').catch(() => -1)) !== before) break; // -1: the page is changing (navigation)
    console.log(`      (a click on ${sel} never reached the page: clicking again)`);
    const again = await locate(sel);
    if (again.err) throw new Error(`click(${sel}): ${again.err}`);
    box = again;
  }
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
  const codes = { Enter: 13, Escape: 27, Delete: 46, ' ': 32, ArrowDown: 40, ArrowUp: 38 };
  const base = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key], modifiers: ctrl ? 2 : 0 };
  for (let attempt = 0; ; attempt++) {
    const before = await js('window.__input?.keys ?? -1');
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if ((key === 'Enter' || key === ' ') && !ctrl) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key === ' ' ? ' ' : '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(40);
    if (before < 0 || attempt === 1 || (await js('window.__input?.keys ?? -1').catch(() => -1)) !== before) break; // -1: the page is changing (navigation)
    console.log(`      (${key} never reached the page: pressing again)`);
  }
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

async function toastText(expected = '', timeout = 8000) {
  return waitFor(`(() => { const t = document.querySelector("#toast"); return !t.hidden && t.textContent.includes(${q(expected)}) && t.textContent; })()`, `toast "${expected}"`, timeout);
}
const UNDO_WAIT = 14000; // a clicked delete waits 8 s for ↶ Undo before it happens

const fileExists = p => fs.access(p).then(() => true, () => false);
// Unfolds a collapsible panel (data-panel="key") if it's folded.
const openPanel = key => js(`(() => { const el = document.querySelector('[data-panel="${key}"]'); if (el?.classList.contains('collapsed')) el._btn.click(); })()`);

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function eq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }

// ---------- harness ----------

const results = [];
async function test(name, fn) {
  if (FILTER && !FILTER.split('|').some(f => name.includes(f)) && !['boot'].includes(name)) return;
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name} (${Date.now() - t}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
    const toasts = await js('(window.__toasts || []).slice(-4).map(t => `${((Date.now() - t.at) / 1000).toFixed(1)}s ago: ${t.text}`)').catch(() => []);
    if (toasts?.length) console.log(`      last toasts: ${toasts.join(' | ')}`);
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
  *"UnitFileState hibernate.target"*) if [ -f ${JSON.stringify(path.join(tmp, 'privacy', 'masked'))} ]; then echo UnitFileState=masked; else echo UnitFileState=static; fi ;;
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
  for (const d of ['output', 'input', 'custom_nodes', 'models/checkpoints', 'models/loras/krea2']) await fs.mkdir(path.join(comfyRoot, d), { recursive: true });
  // A one-second video for the mock to "render" when a prompt says MP4TEST (needs ffmpeg; without it, no video tests).
  const clipFile = path.join(tmp, 'mock-clip.mp4');
  const clip = await new Promise(resolve => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipFile], { stdio: 'ignore' });
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? fs.readFile(clipFile).catch(() => null) : null));
  });
  const comfy = startMockComfy(COMFY_PORT, { png: makePng(96, 96), root: comfyRoot, mp4: await clip });
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

  // A saved workflow whose checkpoint ComfyUI doesn't have yet, with the download link ComfyUI's templates carry.
  const bigModelWorkflowFile = path.join(tmp, 'needs-big-model.json');
  const bigModel = structuredClone(SAVED_WORKFLOW);
  Object.assign(bigModel.nodes.find(n => n.type === 'CheckpointLoaderSimple'), { widgets_values: ['big_model.safetensors'], properties: { models: [{ name: 'big_model.safetensors', url: `http://127.0.0.1:${COMFY_PORT}/hf/big_model.safetensors`, directory: 'checkpoints' }] } });
  await fs.writeFile(bigModelWorkflowFile, JSON.stringify(bigModel));
  // The tests set up their own workflows: the starters count as added already (one test takes this back).
  const starterModels = await fs.readdir(path.join(ROOT, 'workflows'));
  await fs.writeFile(path.join(dataDir, 'starters.json'), JSON.stringify(Object.fromEntries(starterModels.map(id => [id, 'test']))));

  // A fake computer for the Privacy check: lsblk's tree, /proc/swaps, the power file, gsettings and pkexec (which
  // logs what it was asked to run as root and acts out the swap fix).
  const privacyDir = path.join(tmp, 'privacy');
  await fs.mkdir(privacyDir, { recursive: true });
  const fakeSwaps = path.join(privacyDir, 'swaps');
  await fs.writeFile(fakeSwaps, 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swapfile                               file\t\t8388604\t\t0\t\t-2\n');
  const fakePowerDisk = path.join(privacyDir, 'power-disk');
  await fs.writeFile(fakePowerDisk, '[platform] shutdown reboot suspend test_resume\n');
  const fakeLsblk = path.join(privacyDir, 'lsblk');
  await fs.writeFile(fakeLsblk, `#!/bin/sh\necho '{"blockdevices":[{"name":"nvme0n1","type":"disk","fstype":null,"mountpoint":null,"children":[{"name":"nvme0n1p2","type":"part","fstype":"ext4","mountpoint":"/"}]}]}'\n`, { mode: 0o755 });
  const gsettingsStore = path.join(privacyDir, 'gsettings.json');
  await fs.writeFile(gsettingsStore, JSON.stringify({ 'org.gnome.desktop.screensaver lock-enabled': 'true', 'org.gnome.desktop.session idle-delay': 'uint32 0' }));
  const fakeGsettings = path.join(privacyDir, 'gsettings');
  await fs.writeFile(fakeGsettings, `#!/usr/bin/env node\nconst fs = require('fs'); const f = ${JSON.stringify(gsettingsStore)}; const d = JSON.parse(fs.readFileSync(f, 'utf8')); const [op, schema, key, ...val] = process.argv.slice(2);\nif (op === 'get') console.log(d[schema + ' ' + key]); else { d[schema + ' ' + key] = val.join(' '); fs.writeFileSync(f, JSON.stringify(d)); }\n`, { mode: 0o755 });
  const pkexecLog = path.join(privacyDir, 'pkexec.log');
  const fakePkexec = path.join(privacyDir, 'pkexec');
  await fs.writeFile(fakePkexec, `#!/bin/sh\necho "$@" >> ${JSON.stringify(pkexecLog)}\ncase "$*" in *swapoff*) printf 'Filename\\tType\\tSize\\tUsed\\tPriority\\n' > ${JSON.stringify(fakeSwaps)};; *mask*) touch ${JSON.stringify(path.join(privacyDir, 'masked'))};; esac\n`, { mode: 0o755 });
  // systemctl: the fake one answers "masked" for hibernate.target once the fix ran.
  const ramDir = path.join(tmp, 'ram');
  await fs.mkdir(ramDir, { recursive: true });

  // A fake computer for the one-click ComfyUI set-up: git (makes a ComfyUI-shaped folder), python (venv copies
  // itself, pip logs what it was asked for and "installs" torch), nvidia-smi (a card with a driver), no uv.
  const setupDir = path.join(tmp, 'setup');
  await fs.mkdir(setupDir, { recursive: true });
  const gitLog = path.join(setupDir, 'git.log');
  const fakeGit = path.join(setupDir, 'git');
  await fs.writeFile(fakeGit, `#!/bin/sh
echo "$@" >> ${JSON.stringify(gitLog)}
[ "$1" = --version ] && { echo "git version 2.43.0"; exit 0; }
if [ "$1" = clone ]; then for a in "$@"; do d="$a"; done; mkdir -p "$d/comfy" "$d/models/checkpoints"; echo 'print("comfy")' > "$d/main.py"; echo 'torch' > "$d/requirements.txt"; echo "Cloning into '$d'..."; exit 0; fi
exit 1
`, { mode: 0o755 });
  const pipLog = path.join(setupDir, 'pip.log');
  const fakePython = path.join(setupDir, 'python3');
  await fs.writeFile(fakePython, `#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
case "$*" in
  *"version_info"*) echo 3.12.9 ;;
  *"import venv, ensurepip"*) exit 0 ;;
  *"import torch"*) [ -f "$here/torch-ok" ] ;;
  "-m venv "*) d="$3"; mkdir -p "$d/bin"; cp "$0" "$d/bin/python"; chmod +x "$d/bin/python" ;;
  "-m pip install "*) echo "$@" >> ${JSON.stringify(pipLog)}; echo "Collecting $4"; sleep 1; echo "Downloading $4 (2.1 GB)"; sleep 1; case "$*" in *torch*) touch "$here/torch-ok";; esac; echo "Successfully installed $4" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const fakeNvidiaSmi = path.join(setupDir, 'nvidia-smi');
  await fs.writeFile(fakeNvidiaSmi, '#!/bin/sh\necho "NVIDIA GeForce RTX 4090, 580.65.06"\n', { mode: 0o755 });

  // A fake LM Studio home: its server logs quote every request, and deleting from History must clean them.
  const lmsHome = path.join(tmp, 'lmstudio-home');
  await fs.mkdir(path.join(lmsHome, 'server-logs', '2026-10'), { recursive: true });
  // PM_MODEL_HOSTS: model downloads may come from the mock ComfyUI's fake Hugging Face.
  const app = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT), PROMPT_MAKER_DATA: dataDir, LMS_BIN: fakeLms, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData, SYSTEMCTL_BIN: fakeSystemctl, SYSTEMD_RUN_BIN: fakeSystemdRun, XDG_MIME_BIN: '/bin/true', PM_MODEL_HOSTS: '127.0.0.1', PROMPT_MAKER_VOICE_PYTHON: path.join(ROOT, 'tests', 'mock-voice-python.sh'), PROMPT_MAKER_VOICE_WORKER: path.join(ROOT, 'tests', 'mock-voice-worker.mjs'), LMSTUDIO_HOME: lmsHome, PM_LSBLK_BIN: fakeLsblk, PM_PROC_SWAPS: fakeSwaps, PM_SYS_POWER_DISK: fakePowerDisk, PM_GSETTINGS_BIN: fakeGsettings, PM_PKEXEC_BIN: fakePkexec, PM_RAM_DIR: ramDir, PM_GIT_BIN: fakeGit, PM_PYTHON_BIN: fakePython, PM_NVIDIA_SMI_BIN: fakeNvidiaSmi, PM_LSPCI_BIN: '/bin/true', PM_UV_BIN: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Every toast, in order, with when it showed: there's one toast slot, and a later toast replaces the one before.
  // And every click and key press that reached the page, so a lost one can be told apart from one the app ignored.
  // The assistant opens by default; most tests want the page as it is without it (one test checks the default).
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(APP)} && localStorage.getItem('pm.assistantOpen') === null && !sessionStorage.getItem('default-assistant')) localStorage.setItem('pm.assistantOpen', 'false');` });
  // The technical cards start folded for a new user; the tests work in them, so here they start open.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.origin === ${JSON.stringify(APP)} && localStorage.getItem('pm.panels') === null) localStorage.setItem('pm.panels', JSON.stringify({ 'set-lmstudio': false, 'set-comfy': false, 'set-thinking': false, 'set-master': false, 'model-instructions': false, 'model-sizes': false, 'models-defaults': false, 'models-lengths': false }));` });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__toasts = [];
    window.__input = { clicks: 0, keys: 0 };
    addEventListener('click', () => { window.__input.clicks++; }, true);
    addEventListener('keydown', () => { window.__input.keys++; }, true);
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.querySelector('#toast');
      if (t) new MutationObserver(() => { if (!t.hidden) window.__toasts.push({ text: t.textContent, at: Date.now() }); }).observe(t, { attributes: true, attributeFilter: ['hidden'] });
    });` });
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
    // The first start asks how private; Safe is the default, and the answer is kept.
    await waitFor('document.querySelector("#privacyDlg").open', 'the "How private?" question');
    await waitFor('document.querySelector("#privacyDisk").textContent.includes("not encrypted")', 'the disk verdict');
    assert((await text('#privacyDlg')).includes('Nothing stays'), 'the levels');
    assert(await js('document.querySelector(\'#privacyDlg input[value="normal"]\').checked'), 'Safe is picked');
    await click('#privacyDlg button[value="ok"]');
    await toastText('Safe');
    eq((await (await fetch(`${APP}/api/settings`)).json()).privacyLevel, 'normal', 'kept');
    await goto(`${APP}/`);
    await sleep(500);
    assert(!(await js('document.querySelector("#privacyDlg").open')), 'not asked again');
    eq(await count('.model-card'), 7, 'model cards');
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

  await test('clear empties the theme, undo brings it back', async () => {
    const orig = await value('#theme');
    await type('#theme', '');
    assert(await js('document.querySelector("#themeClear").disabled'), 'nothing to clear: greyed out');
    await type('#theme', 'a fox in the snow');
    await click('#themeClear');
    eq(await value('#theme'), '', 'theme cleared');
    await click('#themeUndo');
    eq(await value('#theme'), 'a fox in the snow', 'undo restored theme');
    await type('#theme', orig);
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
    // A video's first frame sets its shape: no LTX preset fits 1.6, so it gets the image's own ratio.
    eq(await value('#aspect'), '8:5', 'LTX takes the image\'s own ratio');
    eq(await text('#aspect option:checked'), '8:5 🖼️', 'and says so');
    eq(await js('[...document.querySelectorAll("#resolution option")].map(o => o.value).join("|")'), '1216×768|1280×800|1824×1152|2432×1504|3648×2272|__custom', 'its sizes, redrawn in that shape');
    eq(await value('#resolution'), '1824×1152', 'the one nearest the 1080p it had');
    assert(await visible('#aspectNote'), '"from image" note on the video model too');
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

  await test('portrait image on a video model: its own shape; manual change wins; Krea snaps to a preset', async () => {
    await setFiles('#imageInput', [portrait]);
    await waitFor('document.querySelector("#aspect").value === "4:7"', 'portrait aspect: 400×700 is 4:7, not quite 9:16');
    eq(await value('#resolution'), '1088×1920', 'portrait resolution of about the same size');
    eq(await js('[...document.querySelectorAll("#aspect option")].filter(o => o.textContent.includes("🖼️")).length'), 1, 'only the new image\'s ratio is offered');
    await choose('#aspect', '9:16');
    eq(await value('#resolution'), '1080×1920', 'back on a preset: the preset sizes');
    await choose('#aspect', '1:1');
    eq(await value('#resolution'), '1024×1024', 'resolution follows a manual aspect change');
    await choose('#resolution', '__custom');
    assert(await visible('#resCustom'), 'width and height boxes for your own size');
    eq(await value('#resolution'), '1024×1024', 'still on the size in use until one is typed');
    await type('#resW', '1000'); await type('#resH', '700');
    await shot('04b-own-size');
    await click('#resUse');
    eq(await value('#resolution'), '1000×700', 'your own size is picked');
    eq(await text('#resolution option:checked'), 'Your size: 1000×700', 'and says so');
    eq(await js('JSON.parse(localStorage.getItem("pm.prefs.ltx-2-3")).resolution'), '1000×700', 'and remembered');
    await choose('#aspect', '16:9');
    eq(await value('#resolution'), '1000×700', 'an aspect change keeps a typed size');
    await choose('#resolution', '1024×1024');
    assert(!(await visible('#resCustom')), 'boxes hide on a preset');
    assert((await js('[...document.querySelectorAll("#resolution option")].map(o => o.value)')).includes('1000×700'), 'your size stays in the menu');
    eq(JSON.stringify(await js('JSON.parse(localStorage.getItem("pm.sizes.ltx-2-3"))')), '["1000×700"]', 'kept across sessions');
    await choose('#resolution', '1000×700');
    assert(await visible('#resForget'), 'a size of yours can be forgotten');
    await click('#resForget');
    assert(!(await js('[...document.querySelectorAll("#resolution option")].map(o => o.value)')).includes('1000×700'), 'forgotten');
    await choose('#aspect', '1:1');
    assert(!(await visible('#aspectNote')), 'note cleared after a manual change');
    const prefs = () => js('JSON.parse(localStorage.getItem("pm.prefs.ltx-2-3")).aspectRatio');
    eq(await prefs(), '1:1', 'a preset is remembered for the model');
    await choose('#aspect', '4:7');
    eq(await prefs(), '1:1', 'the image\'s own ratio is not: it belongs to the image');
    await click('.model-card[data-id="krea2-raw"]');
    eq(await value('#aspect'), '9:16', 'an image model snaps to its closest preset');
    eq(await js('[...document.querySelectorAll("#aspect option")].some(o => o.textContent.includes("🖼️"))'), false, 'no own ratio offered there');
    await click('.model-card[data-id="ltx-2-3"]');
    eq(await value('#aspect'), '4:7', 'back on the video model: the image\'s shape again');
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

  await test('nothing jumps: takes keep their size when written, folds keep their header, the steps stay put', async () => {
    const top = sel => js(`Math.round(document.querySelector(${q(sel)}).getBoundingClientRect().top)`);
    // Like a person, without scrolling first (click() does): presses the button where it is now.
    const pressAt = async sel => {
      const b = await js(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await sleep(80);
    };
    try {
      await click('#varSeg button[data-value="3"]');
      await type('#theme', 'SLOWSECOND nothing jumps');
      const theme = await top('#theme');
      await click('#generateBtn');
      await waitFor('document.querySelectorAll(".take").length === 3', 'three takes');
      // While they're written, each take's buttons are there already, greyed out, and so is Copy all.
      assert(await js('[...document.querySelectorAll(".take")].every(t => !t.querySelector(".refine").hidden && t.querySelector(".refine").inert && t.querySelector(".chips").inert)'), 'tweak box and chips show greyed out while writing');
      eq(await js('document.querySelector("#copyAllBtn")?.disabled'), true, 'Copy all shows greyed out while writing');
      await waitFor('!document.querySelector(".take:nth-child(3) .prompt-view").hidden && document.querySelector(".take:nth-child(2) .status").textContent.includes("Done")', 'take 3 being written', 15000);
      await sleep(150);
      const take3 = await top('.take:nth-child(3)');
      await genDone();
      const moved = (await top('.take:nth-child(3)')) - take3;
      assert(Math.abs(moved) <= 6, `take 3 stays where it was when the takes are done (moved ${moved}px)`);
      assert(await js('[...document.querySelectorAll(".take")].every(t => !t.querySelector(".refine").inert)'), 'and their buttons work');
      eq(await top('#theme'), theme, 'the steps never moved');
      // A wide window: the steps and the takes scroll on their own, the page doesn't.
      assert(await js('document.documentElement.scrollHeight <= innerHeight + 1'), 'the page itself does not scroll');
      await js('document.querySelector(".stage").scrollTop = 1e6');
      await sleep(100);
      eq(await top('#theme'), theme, 'scrolling the takes leaves the steps where they are');

      // Fold a take, or a step, scrolled to the end: the header you clicked stays under the mouse.
      const take3Head = '.take:nth-child(3) > .take-head';
      const takeHead = await top(take3Head);
      await pressAt(`${take3Head} .collapse-btn`);
      assert(await js('document.querySelector(".take:nth-child(3)").classList.contains("collapsed")'), 'take 3 folded');
      eq(await top(take3Head), takeHead, 'the folded take\'s header stays put');
      await pressAt(`${take3Head} .collapse-btn`);
      await js('document.querySelector(".director-steps").scrollTop = 1e6');
      await sleep(100);
      const dialsHead = '[data-panel="create-dials"] > .step-head';
      const stepHead = await top(dialsHead);
      await pressAt(`${dialsHead} .collapse-btn`);
      assert(await js('document.querySelector(\'[data-panel="create-dials"]\').classList.contains("collapsed")'), 'step 4 folded');
      eq(await top(dialsHead), stepHead, 'the folded step\'s header stays put');
    } finally {
      await openPanel('create-dials');
      await click('#varSeg button[data-value="1"]');
    }
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
    assert((await text('#bannerLong')).includes('app menu') && !(await text('#bannerLong')).includes('start.sh'), 'says how to start it, by clicking');
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
    assert(unit.includes(`ConditionPathExists=${path.join(ROOT, 'server.js')}`), 'does nothing once this copy is gone');
    assert(desktop.includes(`TryExec=${path.join(ROOT, 'start.sh')}`), 'the menu entry hides itself once this copy is gone');
    assert(!(await visible('#sSetupElsewhere')), 'set up for this copy: nothing to say');

    // The package was removed: the setup points at a folder that's gone. Settings says so; one click points it here.
    const unitPath = path.join(xdgConfig, 'systemd', 'user', 'prompt-maker.service');
    await fs.writeFile(unitPath, unit.replaceAll(ROOT, '/opt/prompt-maker-gone/app').replace(`ExecStart="${process.execPath}"`, 'ExecStart="/opt/prompt-maker-gone/node/bin/node"'));
    await click('.tabs button[data-view="create"]');
    await click('.tabs button[data-view="settings"]');
    await waitFor('!document.querySelector("#sSetupElsewhere").hidden', 'removed-copy notice');
    assert((await text('#sSetupElsewhere')).includes("been removed") && (await text('#sSetupElsewhere')).includes('/opt/prompt-maker-gone/app'), 'says where, plainly');
    await click('#sSetupRepair');
    await toastText('Set up for this copy');
    const fixed = await fs.readFile(unitPath, 'utf8');
    assert(fixed.includes(`WorkingDirectory=${ROOT}`) && fixed.includes(`ExecStart="${process.execPath}"`) && !fixed.includes('prompt-maker-gone'), 'points here again');
    assert(await js('document.querySelector("#sAutostart").checked'), 'still starts with the computer');
    assert(!(await visible('#sSetupElsewhere')), 'notice gone');

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

  await test('🔒 privacy check: disk, swap, hibernation, screen lock; one click fixes what it can', async () => {
    await click('.tabs button[data-view="settings"]');
    const state = name => text(`.svc[data-check="${name}"] .svc-state`);
    await waitFor('document.querySelector(\'.svc[data-check="swap"] .svc-state\').textContent.startsWith("On")', 'the checks are in');
    assert((await state('disk')).startsWith('Off') && (await state('disk')).includes('installed'), `disk: not encrypted, and says it's an install-time choice: ${await state('disk')}`);
    eq(await count('.svc[data-check="disk"] [data-fix]'), 0, 'nothing to click for the disk');
    assert((await state('swap')).includes('in the open'), `swap on, in the open: ${await state('swap')}`);
    assert((await state('hibernation')).startsWith('Possible'), `hibernation possible: ${await state('hibernation')}`);
    assert((await state('lock')).startsWith('Off'), `the screen never locks (lock on, but never blanks): ${await state('lock')}`);
    // Swap off: through the system's password prompt (pkexec), swapoff and fstab.
    await click('[data-fix="swap"]');
    await toastText('Swap is off');
    const asked = await fs.readFile(pkexecLog, 'utf8');
    assert(asked.includes('swapoff -a') && asked.includes('/etc/fstab'), `turned off now and for good: ${asked}`);
    eq(await state('swap'), 'Off: memory is never written to disk.', 'swap shown off');
    eq(await state('hibernation'), 'Off: there is no swap to write memory to.', 'and so hibernation cannot happen');
    assert(await js('document.querySelector(\'[data-fix="hibernation"]\').hidden'), 'nothing left to fix there');
    // Screen lock: no password needed (your own desktop settings), locks after 5 minutes.
    await click('[data-fix="lock"]');
    await toastText('locks on its own');
    eq(await state('lock'), 'On: locks after 5 min away.', 'lock on');
    const g = JSON.parse(await fs.readFile(gsettingsStore, 'utf8'));
    eq(g['org.gnome.desktop.session idle-delay'], 'uint32 300', 'the desktop was told');
    // Hibernation on its own (swap back on): masked.
    await fs.writeFile(fakeSwaps, 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swapfile file 8388604 0 -2\n');
    await click('.tabs button[data-view="create"]');
    await click('.tabs button[data-view="settings"]');
    await waitFor('document.querySelector(\'.svc[data-check="hibernation"] .svc-state\').textContent.startsWith("Possible")', 'possible again');
    await click('[data-fix="hibernation"]');
    await toastText('Hibernation is off');
    assert((await fs.readFile(pkexecLog, 'utf8')).includes('mask hibernate.target'), 'masked as root');
    eq(await state('hibernation'), 'Off.', 'shown off');
    await fs.writeFile(fakeSwaps, 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n');

    // The level, changed from here: Safer switches ComfyUI to memory and runs the fixes that are still needed.
    await fs.writeFile(fakeSwaps, 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swapfile file 8388604 0 -2\n');
    await fs.writeFile(pkexecLog, '');
    assert((await text('#privacyLevelLine')).includes('Safe'), `the level shows: ${await text('#privacyLevelLine')}`);
    await click('#privacyLevelBtn');
    await waitFor('document.querySelector("#privacyDlg").open', 'the level dialog');
    await click('#privacyDlg input[value="private"]');
    await click('#privacyDlg button[value="ok"]');
    await toastText('Safer');
    const sPrivate = await (await fetch(`${APP}/api/settings`)).json();
    assert(sPrivate.privacyLevel === 'private' && sPrivate.comfyRam && sPrivate.logScrub && !sPrivate.dataRam, 'the Safer switches');
    assert((await fs.readFile(pkexecLog, 'utf8')).includes('swapoff -a'), 'swap turned off again as part of it');
    assert((await text('#privacyLevelLine')).includes('Safer'), 'the card says so');
    assert(await js('document.querySelector("#sComfyRam").checked'), 'the ComfyUI switch in the form follows');
    // Nothing stays: your work in memory, after a restart.
    await click('#privacyLevelBtn');
    await waitFor('document.querySelector("#privacyDlg").open', 'the level dialog again');
    await click('#privacyDlg input[value="ram"]');
    await click('#privacyDlg button[value="ok"]');
    await toastText('Restart Prompt Maker');
    const sRam = await (await fetch(`${APP}/api/settings`)).json();
    assert(sRam.privacyLevel === 'ram' && sRam.dataRam && !sRam.inMemory, 'set, not yet in effect');
    assert((await text('#privacyLevelLine')).includes('after a restart'), 'the card says it takes a restart');
    // Back to Safe.
    await click('#privacyLevelBtn');
    await waitFor('document.querySelector("#privacyDlg").open', 'the level dialog once more');
    await click('#privacyDlg input[value="normal"]');
    await click('#privacyDlg button[value="ok"]');
    await toastText('Safe');
    const sNormal = await (await fetch(`${APP}/api/settings`)).json();
    assert(sNormal.privacyLevel === 'normal' && !sNormal.comfyRam && !sNormal.dataRam, 'the Safe switches');
  });

  await test('🔒 a session in memory: History, renders and the chat live in RAM and go when Prompt Maker stops', async () => {
    const dataDir2 = path.join(tmp, 'data-ram');
    const ram2 = path.join(tmp, 'ram2');
    await fs.mkdir(dataDir2, { recursive: true });
    await fs.mkdir(ram2, { recursive: true });
    await fs.writeFile(path.join(dataDir2, 'settings.json'), JSON.stringify({ dataRam: true, privacyLevel: 'ram', comfyUrl: `http://127.0.0.1:${COMFY_PORT}` }));
    const env = { ...process.env, PORT: String(APP_PORT + 2), PROMPT_MAKER_DATA: dataDir2, PM_RAM_DIR: ram2, SYSTEMCTL_BIN: fakeSystemctl, LMS_BIN: fakeLms, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData };
    const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    srv.stdout.on('data', d => { log += d; });
    srv.stderr.on('data', d => { log += d; });
    try {
      for (let i = 0; i < 50 && !log.includes('running at'); i++) await sleep(100);
      assert(log.includes('kept in memory for this session'), `says so as it starts:\n${log}`);
      const base = `http://127.0.0.1:${APP_PORT + 2}`;
      const settings = await (await fetch(`${base}/api/settings`)).json();
      const session = path.join(ram2, 'prompt-maker-session');
      assert(settings.inMemory && settings.sessionDir === session && settings.dataDir === dataDir2, `the session folder is in memory: ${settings.sessionDir}`);
      for (const d of ['images', 'renders', 'videos']) assert(await fileExists(path.join(session, d)), `${d} in memory`);
      for (const d of ['images', 'renders', 'videos']) assert(!(await fileExists(path.join(dataDir2, d))), `no ${d} folder on disk`);
      await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topP: 0.5 }) });
      assert(JSON.parse(await fs.readFile(path.join(dataDir2, 'settings.json'), 'utf8')).topP === 0.5, 'settings still go to the data folder on disk');
      srv.kill('SIGTERM');
      for (let i = 0; i < 50 && srv.exitCode === null; i++) await sleep(100);
      assert(srv.exitCode !== null, 'it stopped');
      assert(!(await fileExists(session)), 'the session folder is gone with it');
    } finally {
      if (srv.exitCode === null) srv.kill('SIGKILL');
    }
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
    assert(!started.includes('--output-directory'), 'its own folders, as usual');
    assert(started.includes(`StandardOutput=append:${path.join(dataDir, 'comfyui.log')}`) && started.includes('StandardError=append:'), `its output goes to comfyui.log in the data folder, not the system journal: ${started}`);
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

  await test('🎨 one-click ComfyUI set-up: not on this computer → Set up: fetched, its Python, PyTorch for the card, its packages, started', async () => {
    // Point ComfyUI's folder at a place with nothing in it: as on a fresh computer, there's no ComfyUI to start.
    const fresh = path.join(tmp, 'fresh', 'ComfyUI');
    await click('.tabs button[data-view="settings"]');
    await type('#sComfyFolder', fresh);
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await comfy.stop();
    await fs.rm(path.join(tmp, 'comfy-active'), { force: true });
    await fs.writeFile(systemdRunLog, '');
    await click('.tabs button[data-view="create"]');
    await waitFor('document.querySelector("#comfyState").hidden || document.querySelector("#comfyState").textContent.includes("isn\'t set up")', 'Create says ComfyUI isn\'t set up (when it has something to render with)', 15000);
    await click('.tabs button[data-view="settings"]');
    await waitFor('!document.querySelector(\'[data-act="comfy-setup"]\').hidden', 'a Set up ComfyUI button when it isn\'t on this computer');
    assert((await text('.svc[data-svc="comfy"] .svc-state')).includes('Not on this computer yet'), `says so: ${await text('.svc[data-svc="comfy"] .svc-state')}`);
    assert(await js('document.querySelector(\'[data-act="comfy-start"]\').hidden'), 'nothing to start');

    // The dialog: what the computer has, where it goes, what it downloads.
    await click('[data-act="comfy-setup"]');
    await waitFor('document.querySelector("#comfySetupDlg").open && document.querySelector(\'#csChecks [data-check="gpu"] .svc-state\').textContent.includes("NVIDIA GeForce RTX 4090")', 'the graphics card, by name');
    assert((await text('#csChecks [data-check="gpu"] .svc-state')).includes('driver 580.65.06'), 'with its driver');
    assert(await js('document.querySelector(\'#csChecks [data-check="gpu"] [data-fix]\').hidden'), 'no driver to install');
    assert((await text('#csChecks [data-check="python"] .svc-state')).includes('Python 3.12.9'), `Python, by version: ${await text('#csChecks [data-check="python"] .svc-state')}`);
    eq(await text('#csDirShown'), fresh, 'goes where Settings → ComfyUI points');
    assert((await text('#csAbout')).includes('3 GB') && (await text('#csAbout')).includes('step ⑤'), 'says what it downloads, and that models come later');
    await shot('comfy-setup');

    // Go: each step in plain words, then ComfyUI starts on its own.
    await click('#csGo');
    await waitFor('!document.querySelector("#csProgress").hidden && document.querySelector("#csText").textContent.length > 0', 'progress shows');
    await waitFor('document.querySelector("#csText").textContent.includes("PyTorch")', 'the PyTorch step, named for the card', 20000);
    assert((await text('#csText')).includes('NVIDIA GeForce RTX 4090'), `for this card: ${await text('#csText')}`);
    await waitFor('document.querySelector("#csProgress").classList.contains("done")', 'done', 30000);
    assert((await text('#csText')).includes('set up and starting'), 'says so');
    assert(await fileExists(path.join(fresh, 'main.py')) && await fileExists(path.join(fresh, 'comfy')), 'ComfyUI fetched into the folder');
    assert((await fs.readFile(gitLog, 'utf8')).includes(`clone --depth 1 --progress https://github.com/comfyanonymous/ComfyUI.git ${fresh}`), 'a shallow clone of ComfyUI');
    assert(await fileExists(path.join(fresh, 'venv', 'bin', 'python')), 'its own Python environment');
    const pips = await fs.readFile(pipLog, 'utf8');
    assert(pips.includes('torch torchvision torchaudio') && !pips.includes('index-url'), `PyTorch's CUDA build from PyPI for an NVIDIA card: ${pips}`);
    assert(pips.includes('-r requirements.txt'), 'then ComfyUI\'s packages');
    assert(pips.indexOf('torch') < pips.indexOf('requirements'), 'in that order');
    const started = await fs.readFile(systemdRunLog, 'utf8');
    assert(started.includes(`--working-directory=${fresh}`) && started.includes(path.join(fresh, 'venv', 'bin', 'python')) && started.includes('main.py'), `started from the new folder with its own Python: ${started}`);
    eq((await (await fetch(`${APP}/api/settings`)).json()).comfyDir, fresh, 'Settings → ComfyUI points at it');
    eq(await text('#csLater'), 'Done', 'the dialog is done');
    await click('#csLater');
    await comfy.start(); // ComfyUI answers
    await toastText('ComfyUI is running', 15000);
    await waitFor('document.querySelector(\'.svc[data-svc="comfy"] .svc-state\').textContent.startsWith("Running")', 'shown running');
    assert(await js('document.querySelector(\'[data-act="comfy-setup"]\').hidden'), 'the Set up button goes');

    // Already set up: the dialog says so and would only finish and start it. The root fixes go through pkexec.
    const st = await (await fetch(`${APP}/api/comfy/setup`)).json();
    eq(st.installed, fresh, 'knows it\'s there');
    const fix = await (await fetch(`${APP}/api/comfy/setup/fix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'python' }) })).json();
    assert(fix.ok && (await fs.readFile(pkexecLog, 'utf8')).includes('python3-venv'), `python3-venv through the system's password prompt: ${JSON.stringify(fix)}`);
    const badDir = await (await fetch(`${APP}/api/comfy/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: tmp }) })).json();
    assert(/other things in it/.test(badDir.error), `won't take over a folder with other things in it: ${JSON.stringify(badDir)}`);

    await type('#sComfyFolder', '');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
  });

  await test('🧠 ComfyUI working files in memory: started from here with its folders in RAM; a delete finds them there', async () => {
    await click('.tabs button[data-view="settings"]');
    assert(!(await js('document.querySelector("#sComfyRamRow").hidden')), 'offered on Linux');
    await click('#sComfyRam');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await comfy.stop();
    await fs.rm(path.join(tmp, 'comfy-active'), { force: true });
    await fs.writeFile(systemdRunLog, '');
    await click('.tabs button[data-view="create"]');
    await click('.tabs button[data-view="settings"]');
    await waitFor('!document.querySelector(\'[data-act="comfy-start"]\').hidden', 'Start button when off');
    assert((await text('#svcComfyHow')).includes('working files in memory'), `says so: ${await text('#svcComfyHow')}`);
    await click('[data-act="comfy-start"]');
    await toastText('Starting ComfyUI');
    const started = await fs.readFile(systemdRunLog, 'utf8');
    for (const kind of ['output', 'input', 'temp']) {
      assert(started.includes(`--${kind}-directory ${path.join(ramDir, 'prompt-maker-comfyui', kind)}`), `${kind} folder in memory: ${started}`);
      assert(await fileExists(path.join(ramDir, 'prompt-maker-comfyui', kind)), `${kind} folder made`);
    }
    // The app finds ComfyUI's folders from the options it runs with, so deleting reaches the ones in memory.
    const { folders } = await import('../lib/comfy.js');
    const dirs = await folders('http://127.0.0.1:1', { args: ['--output-directory', path.join(ramDir, 'prompt-maker-comfyui', 'output'), '--temp-directory', '/nonexistent'] });
    eq(dirs.output, path.join(ramDir, 'prompt-maker-comfyui', 'output'), 'the output folder is the one in memory');
    eq(dirs.temp, undefined, 'a folder that is not there is not reported');
    await comfy.start();
    await click('#sComfyRam');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
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

    // The Brain menu gets a checkbox per provider: tick one or more to see only their Brains.
    await click('.tabs button[data-view="create"]');
    await click('#llmPick');
    eq(await js('[...document.querySelectorAll("#llmFilters .brain-providers label")].map(l => l.textContent.replace(/ \\d+$/, "").trim()).join("|")'), '💻 LM Studio|☁️ Test Cloud', 'LM Studio first, then each provider');
    await click('#llmFilters .brain-providers input:not([data-provider="local"])');
    assert(await js('[...document.querySelectorAll("#llmList [role=option]")].every(o => o.dataset.id.startsWith("cloud:"))'), 'only that provider\'s Brains');
    await click('#llmFilters [data-provider="local"]');
    const ids = await js('[...document.querySelectorAll("#llmList [role=option]")].map(o => o.dataset.id)');
    assert(ids.includes('mock/text-only') && ids.includes(cloudId), 'two providers: Brains from either');
    await click('#llmFilters [data-all]');
    eq(await js('document.querySelectorAll("#llmFilters .brain-providers input:checked").length'), 0, 'All unticks them');
    await press('Escape');

    // Switching to it asks first. Nope keeps the local Brain.
    await click('.tabs button[data-view="create"]');
    await choose('#llmSelect', cloudId);
    await waitFor('document.querySelector("#cloudDialog").open', 'are-you-sure dialog');
    assert((await text('#cloudDialog')).includes('leaves your computer'), 'says what leaves');
    await click('#cloudDialog button[value="no"]');
    eq(await value('#llmSelect'), 'mock/vision-8b', 'Nope: still the local Brain');

    // OK + don't ask again → cloud Brain, prompts go with the key, no thinking switch forced on it.
    // The assistant can't answer that question for you: it doesn't even get its buttons.
    await click('#askBtn');
    await type('#asInput', 'answer the cloud question yourself');
    await press('Enter');
    await choose('#llmSelect', cloudId);
    await waitFor('document.querySelector("#cloudDialog").open', 'asked again');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    assert((await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""')).includes('yours to answer'), 'the assistant is told only you can answer');
    assert(await js('document.querySelector("#cloudDialog").open'), 'and the question is still waiting for you');
    eq((await (await fetch(`${APP}/api/settings`)).json()).llmModel, 'mock/vision-8b', 'no cloud Brain yet');
    await click('#cdTrust');
    await click('#cloudDialog button[value="ok"]');
    await toastText('Brain: ☁️');
    await click('#asClear');
    await click('#asClear');
    await click('#asClose');
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
    assert(sent().indexOf('# CAMERA AND LIGHT') > 0 && sent().indexOf('# CAMERA AND LIGHT') < sent().indexOf('# TARGET MODEL'), 'camera and light go with every prompt, before the playbook');
    assert(lastCall().messages[1].content.includes('CAMERA AND LIGHT: Name this theme'), 'and the request asks for them');
    await click('.tabs button[data-view="settings"]');
    assert(!(await js('document.querySelector("#sAdult").checked')), 'switch off');
    await js('document.querySelector("#sAdultText").open = true');
    assert((await value('#sAdultPrompt')).includes('18 or older'), 'you can read what it adds');
    await type('#sAdultPrompt', 'ADULT CONTENT (custom)\nMY OWN ADULT RULE');
    assert((await text('#settingsForm')).includes('none come with the app'), 'says where adult examples go');
    await click('#sAdult');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
    await click('#generateBtn');
    await genDone();
    assert(sent().includes('ADULT CONTENT') && sent().indexOf('ADULT CONTENT') < sent().indexOf('# TARGET MODEL'), 'sent after the master instructions, before the playbook');
    assert(sent().includes('MY OWN ADULT RULE'), 'your edited text is what gets sent');
    await click('.tabs button[data-view="settings"]');
    await click('#sResetAdult');
    assert((await value('#sAdultPrompt')).includes('18 or older'), 'adult text reset');
    await click('#sAdult');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('.tabs button[data-view="create"]');
  });

  await test('look: one click under the theme sets the camera and light; saved with the take and remembered', async () => {
    const request = () => lastCall().messages[1].content;
    const before = new Set((await (await fetch(`${APP}/api/history`)).json()).map(e => e.id));
    await click('.model-card[data-id="krea2-raw"]');
    eq(await js('document.querySelector("#lookRow .active")?.dataset.value'), '', 'the Brain picks by default');
    await type('#theme', 'a detective in a rainy alley');
    await click('#generateBtn');
    await genDone();
    assert(request().includes("Name this theme's feeling") && !request().includes('The user picked the look'), 'no look: the Brain picks one for the mood');
    await click('#lookRow button[data-value="noir"]');
    eq(await js('document.querySelector("#lookRow .active")?.dataset.value'), 'noir', 'Noir lit');
    await click('#generateBtn');
    await genDone();
    assert(request().includes('The user picked the look "Noir"') && request().includes('venetian-blind shadows'), 'the Brain is told the look and what it means');
    assert(!request().includes('camera movement:'), 'a still gets no camera movement');
    const entry = (await (await fetch(`${APP}/api/history`)).json())[0];
    eq(entry.look, 'noir', 'saved with the take');
    await click('.tabs button[data-view="history"]');
    await waitFor('!!document.querySelector(".hcard")', 'history cards');
    assert((await text('.hcard')).includes('Noir'), 'and shown on its history card');
    await click('.tabs button[data-view="create"]');
    await goto(`${APP}/#create`);
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded');
    eq(await js('document.querySelector("#lookRow .active")?.dataset.value'), 'noir', 'remembered after a reload');
    await (await fetch(`${APP}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: 'krea2-raw', theme: 'an odd look', look: 'nonsense', variations: 1 }) })).text();
    assert(!request().includes('nonsense') && request().includes("Name this theme's feeling"), 'an unknown look is ignored: the Brain picks');
    eq((await (await fetch(`${APP}/api/history`)).json())[0].look, undefined, 'and none is saved');
    await click('#lookRow button[data-value=""]');
    eq(await js('document.querySelector("#lookRow .active")?.dataset.value'), '', 'back to the Brain picking');
    // (Leave History as the tests after this one expect it.)
    for (const e of (await (await fetch(`${APP}/api/history`)).json()).filter(x => !before.has(x.id))) await fetch(`${APP}/api/history/${e.id}`, { method: 'DELETE' });
    await goto(`${APP}/#create`);
  });

  await test('panels fold to a one-line summary, and stay folded after a reload', async () => {
    await click('.tabs button[data-view="create"]');
    await type('#theme', 'a lighthouse keeper making tea at dawn');
    await click('[data-panel="create-theme"] .collapse-btn');
    assert(!(await visible('#theme')), 'step 2 folded');
    eq(await text('[data-panel="create-theme"] .panel-summary'), 'a lighthouse keeper making tea at dawn', 'shows what it holds');
    await click('[data-panel="create-dials"] .step-head h2'); // the header itself folds too
    assert(/locked-in|balanced|creative|spicy|unhinged/.test(await text('[data-panel="create-dials"] .panel-summary')), 'dials summary says how adventurous, in a word');
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
    eq(await js('["set-lmstudio", "set-comfy", "set-thinking", "set-master", "model-instructions", "model-sizes", "models-defaults", "models-lengths"].filter(k => document.querySelector(`[data-panel="${k}"]`).dataset.default === "collapsed").length'), 8, 'the technical cards start folded for a new user');
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
    eq(await count('.hcard.current'), 1, 'the card open on Create is marked');
    assert((await text('.hcard.current .htheme')).includes('a gust of wind'), 'it is the one opened last');
    const before = await count('.hcard');
    const badge = Number(await text('#historyBadge'));
    // The first delete says what goes, until "Don't show this again".
    await click('.hcard:last-of-type [data-act="delete"]');
    await waitFor('document.querySelector("#deleteDlg").open', 'the "Delete it for good?" dialog');
    assert((await text('#deleteDlg')).includes('shredded') && (await text('#deleteDlg')).includes("LM Studio's and ComfyUI's logs"), 'it says what goes and how');
    await click('#deleteDlg button[value="no"]');
    eq(await count('.hcard.going'), 0, 'Keep it: nothing happens');
    await click('.hcard:last-of-type [data-act="delete"]');
    await waitFor('document.querySelector("#deleteDlg").open', 'asks again');
    await click('#ddQuiet');
    await click('#deleteDlg button[value="ok"]');
    await toastText('Deleting');
    eq(await count('.hcard.going'), 1, 'Delete it: on its way out, with Undo');
    await click('.hcard.going [data-act="undo"]');
    await toastText('Kept');
    await click('.hcard:last-of-type [data-act="delete"]');
    assert(!(await js('document.querySelector("#deleteDlg").open')), 'with "Don\'t show this again" ticked, no dialog');
    eq(await text('.hcard:last-of-type [data-act="delete"]'), 'Sure?', 'asks to confirm');
    // Settings → Privacy check brings the warning back.
    await click('.tabs button[data-view="settings"]');
    await waitFor('!document.querySelector("#deleteWarnOff").hidden', 'says the warning is off');
    await click('#deleteWarnBack');
    await toastText('shows again');
    assert(!(await visible('#deleteWarnOff')), 'line gone');
    await click('.tabs button[data-view="history"]');
    await click('.hcard:last-of-type [data-act="delete"]');
    await waitFor('document.querySelector("#deleteDlg").open', 'the warning is back');
    await click('#ddQuiet');
    await click('#deleteDlg button[value="ok"]');
    await toastText('Deleting');
    await click('.hcard.going [data-act="undo"]');
    await toastText('Kept');
    await click('.hcard:last-of-type [data-act="delete"]');
    eq(await text('.hcard:last-of-type [data-act="delete"]'), 'Sure?', 'asks to confirm');
    // A double click only asks: its second click isn't the answer.
    await js('document.querySelector(".hcard:last-of-type [data-act=delete]").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }))');
    eq(await text('.hcard:last-of-type [data-act="delete"]'), 'Sure?', 'a double click does not confirm');
    await click('.hcard:last-of-type [data-act="delete"]');
    // It waits, dimmed and in place, with ↶ Undo on the card and in the toast.
    await toastText('Deleting');
    eq(await count('.hcard'), before, 'the card is still there');
    eq(await count('.hcard.going'), 1, 'marked as on its way out');
    await click('.hcard.going [data-act="undo"]');
    await toastText('Kept');
    eq(await count('.hcard.going'), 0, 'undo: back to normal');
    await sleep(8500);
    eq(await count('.hcard'), before, 'and it is not deleted later');
    eq((await (await fetch(`${APP}/api/history`)).json()).length, before, 'nor on the server');
    await click('.hcard:last-of-type [data-act="delete"]');
    await click('.hcard:last-of-type [data-act="delete"]');
    await click('#toast .toast-act');
    await toastText('Kept');
    eq(await count('.hcard.going'), 0, 'the toast\'s Undo does the same');
    // Pick several cards: Ctrl-click, or a box dragged from the space between them; the bar deletes them, ↶ Undo keeps them.
    const hAt = (n, fx = 0.5, fy = 0.5) => js(`(() => { const c = document.querySelectorAll("#historyList > .hcard")[${n}]; c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.left + r.width * ${fx}, y: r.top + r.height * ${fy}, right: r.right, top: r.top }; })()`);
    const hCtrlClick = async n => {
      const p = await hAt(n, 0.5, 0.15);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: 2 });
      await sleep(60);
    };
    await hCtrlClick(0);
    await hCtrlClick(1);
    eq(await count('.hcard.picked'), 2, 'Ctrl-click picks History cards');
    assert(await js('document.querySelector("#view-history").classList.contains("active") || !document.querySelector("#view-history").hidden'), 'and stays in History (opens nothing)');
    eq(await text('#historySelCount'), '2 selected', 'the bar says how many');
    await press('Escape');
    eq(await count('.hcard.picked'), 0, 'Esc lets go');
    const g = await hAt(0);
    const g1 = await hAt(1);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.right + 6, y: g.top + 4, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.right + 6 + ((g1.x - g.right - 6) * k) / 10, y: g.top + 4 + ((g1.y - g.top) * k) / 10, button: 'left', buttons: 1 });
    assert(await js('!!document.querySelector(".pick-band")'), 'a box is drawn');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g1.x, y: g1.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(80);
    assert(await count('.hcard.picked') >= 1, 'the box picks what it touched');
    await shot('20b-history-picked');
    const hPicked = await count('.hcard.picked');
    await click('#historySelDelete');
    await click('#historySelDelete');
    await toastText('Deleting');
    eq(await count('.hcard.going'), hPicked, 'they dim, with Undo, while they wait');
    await click('#toast .toast-act');
    await toastText('Kept');
    eq(await count('.hcard.going'), 0, 'one ↶ Undo keeps them all');
    // Nothing of it stays anywhere: not in the copy of History from before the delete, not in a job's log, not in
    // LM Studio's own server logs (which quote every request, the middle of long texts cut).
    const allCards = await (await fetch(`${APP}/api/history`)).json();
    const doomed = allCards.at(-1);
    const words = [doomed.theme, ...doomed.variations.flatMap(v => v.versions.map(x => x.text))].filter(t => t.length >= 12);
    assert(words.length >= 2, `the card has a theme and prompts to look for: ${words.length}`);
    // The mock Brain writes the same prompt for every card: what another card also says, word for word, stays.
    const others = JSON.stringify(allCards.filter(e => e.id !== doomed.id));
    const unique = words.filter(w => !others.includes(JSON.stringify(w).slice(1, -1)));
    assert(unique.length >= 1, 'its theme is its own');
    const lmsLog = path.join(lmsHome, 'server-logs', '2026-10', '2026-10-07.1.log');
    // LM Studio keeps the first and last 50 characters of a long text, as JSON writes it.
    const cut = t => { const e = JSON.stringify(t).slice(1, -1); return `"${e.slice(0, 50)}... <Truncated in logs> ...${e.slice(-50)}"`; };
    await fs.writeFile(lmsLog, `[2026-10-07 09:59:23][DEBUG] Received request: POST to /v1/chat/completions with body {\n  "content": ${JSON.stringify(words[0])}\n}\n[INFO] Generated prediction: ${cut(words[1])}\n`);
    const jobsFile = path.join(dataDir, 'jobs.json');
    const jobsBefore = await fs.readFile(jobsFile, 'utf8').catch(() => null);
    await fs.writeFile(jobsFile, JSON.stringify({ jobs: [{ id: 'j1', title: 'test', request: `Make ${words[0]} again`, log: [{ text: words[1] }] }] }));
    try {
      await click('.hcard:last-of-type [data-act="delete"]');
      await click('.hcard:last-of-type [data-act="delete"]');
      await waitFor(`document.querySelectorAll(".hcard").length === ${before - 1}`, 'card removed', UNDO_WAIT);
      eq(Number(await text('#historyBadge')), badge - 1, 'badge decremented');
      const quotes = (body, w, parts) => body.includes(w) || body.includes(JSON.stringify(w).slice(1, -1)) || (parts && (body.includes(w.slice(0, 20)) || body.includes(w.slice(-20))));
      // History: only what no other card says. The log and the job were written with this card's words alone.
      for (const [name, file, which, parts] of [['history.json', path.join(dataDir, 'history.json'), unique, false], ['its copy from before', path.join(dataDir, 'history.json.bak'), unique, false], ['jobs.json', jobsFile, words, true], ['the jobs copy from before', `${jobsFile}.bak`, words, true], ["LM Studio's log", lmsLog, words, true]]) {
        const body = await fs.readFile(file, 'utf8');
        for (const w of which) assert(!quotes(body, w, parts), `${name} no longer quotes "${w.slice(0, 30)}…"`);
      }
      assert((await fs.readFile(lmsLog, 'utf8')).includes('[deleted]'), "LM Studio's log keeps its shape, the words replaced");
      assert((await fs.readFile(jobsFile, 'utf8')).includes('[deleted]'), 'the job keeps its log, the words replaced');
    } finally {
      // Both copies: a missing jobs.json is put back from its .bak (made for power cuts), and the fake job would return.
      if (jobsBefore === null) for (const f of [jobsFile, `${jobsFile}.bak`]) await fs.rm(f, { force: true });
      else await fs.writeFile(jobsFile, jobsBefore);
    }
  });

  await test('history: delete several at once', async () => {
    const before = await count('.hcard');
    for (const n of [0, 1]) {
      const p = await js(`(() => { const c = document.querySelectorAll("#historyList > .hcard")[${n}]; c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.15 }; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: 2 });
      await sleep(60);
    }
    eq(await count('.hcard.picked'), 2, 'two picked');
    await press('Delete');
    await press('Delete');
    await toastText('Deleting 2 prompts');
    await toastText('2 prompts deleted', UNDO_WAIT);
    eq(await count('.hcard'), before - 2, 'two fewer cards');
    eq((await (await fetch(`${APP}/api/history`)).json()).length, before - 2, 'and on the server');
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
    eq(await count('#modelList li'), 8, 'eight models');
    eq(await count('.model-card'), 8, 'new model on Create');
    await click('#dupModelBtn');
    eq(await value('#mName'), 'Test Wizard 9 copy', 'duplicate name');
    await click('#saveModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 9', 'nine models');
    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 8', 'copy deleted');
    await click('#modelList button[data-id="test-wizard-9"]');
    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 7', 'test model deleted');
  });

  await test('models: import JSON', async () => {
    const file = path.join(tmp, 'imported.json');
    await fs.writeFile(file, JSON.stringify({ name: 'Imported Model', kind: 'image', instructions: '## Hi', aspectRatios: ['1:1'] }));
    await setFiles('#importInput', [file]);
    await toastText('1 new');
    await waitFor('document.querySelectorAll("#modelList li").length === 8', 'imported model listed');
    await click('#modelList button[data-id="imported-model"]');
    await click('#deleteModelBtn');
    await click('#deleteModelBtn');
    await waitFor('document.querySelectorAll("#modelList li").length === 7', 'imported model deleted');
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
    eq(await count('.model-card'), 6, 'gone from Create');
    await waitFor('!document.querySelector("#restoreBuiltinsBtn").hidden', 'bring-back offered');
    assert((await text('#restoreBuiltinsBtn')).includes('MiniMax'), 'names it');
    await click('#restoreBuiltinsBtn');
    await toastText('Brought back');
    eq(await count('#modelList li'), 7, 'back in the list');
    eq(await count('.model-card'), 7, 'back on Create');
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
    // A node whose input list names only its linked widget (as in ComfyUI's newer templates): the values follow
    // the node's definition, including a dynamic combo's sub-widgets and a "FLOAT,INT" widget.
    const info = {
      Loader: { input: { required: { clip_name: [['a.safetensors', 'b.safetensors']], type: [['stable_diffusion', 'wan']] }, optional: { device: [['default', 'cpu']] } }, input_order: { required: ['clip_name', 'type'], optional: ['device'] }, output: ['CLIP'] },
      Resize: { input: { required: { input: ['IMAGE'], resize_type: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'scale dimensions', inputs: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }] } } }, { key: 'scale by multiplier', inputs: { required: { multiplier: ['FLOAT', { default: 1 }] } } }] }], scale_method: [['area', 'bilinear']], rate: ['FLOAT,INT', { widgetType: 'FLOAT', default: 25 }], batch: ['INT', { default: 1 }] } }, input_order: { required: ['input', 'resize_type', 'scale_method', 'rate', 'batch'] }, output: ['IMAGE'], output_node: true },
      Src: { input: { required: {} }, output: ['STRING', 'IMAGE'] },
    };
    const partial = convertUiWorkflow({
      nodes: [
        { id: 1, type: 'Src', mode: 0, inputs: [], outputs: [{ name: 'STRING', type: 'STRING', links: [1] }, { name: 'IMAGE', type: 'IMAGE', links: [2] }] },
        { id: 2, type: 'Loader', mode: 0, inputs: [{ name: 'clip_name', type: 'COMBO', widget: { name: 'clip_name' }, link: 1 }], outputs: [], widgets_values: ['b.safetensors', 'wan', 'cpu'] },
        { id: 3, type: 'Resize', mode: 0, inputs: [{ name: 'input', type: 'IMAGE', link: 2 }, { name: 'resize_type.width', type: 'INT', widget: { name: 'resize_type.width' }, link: null }], outputs: [], widgets_values: ['scale dimensions', 482, 854, 'bilinear', 30, 2] },
      ],
      links: [[1, 1, 0, 2, 0, 'STRING'], [2, 1, 1, 3, 0, 'IMAGE']],
    }, info);
    eq(JSON.stringify(partial['2'].inputs), JSON.stringify({ type: 'wan', device: 'cpu', clip_name: ['1', 0] }), 'the unlisted widgets keep their saved values');
    eq(JSON.stringify(partial['3'].inputs), JSON.stringify({ resize_type: 'scale dimensions', 'resize_type.width': 482, 'resize_type.height': 854, scale_method: 'bilinear', rate: 30, batch: 2, input: ['1', 1] }), 'dynamic sub-widgets and FLOAT,INT widgets in order');
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

  await test('render: ComfyUI crashing mid-render ends it instead of leaving it stuck', async () => {
    await type('#theme', 'COMFYCRASH rooftop');
    await click('#generateBtn');
    await genDone();
    await waitFor('!!document.querySelector(".take .rb-go")', 'render bar');
    await click('.take .rb-go');
    await waitFor('document.querySelector("#stageError") && !document.querySelector("#stageError").hidden', 'error card', 15000);
    assert((await text('#stageError')).includes('ComfyUI stopped'), 'crash explained');
    eq((await (await fetch(`${APP}/api/renders`)).json()).length, 0, 'nothing left rendering');
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

  await test('gallery: every render, in Your renders\' grid, opens back into Create', async () => {
    await click('.tabs button[data-view="gallery"]');
    await waitFor('document.querySelector("#galleryHome #reel") && document.querySelectorAll("#reelGrid .reel-cell").length >= 3', 'Your renders moved into the Gallery');
    eq(await text('#galleryCount'), String(await count('#reelGrid .reel-cell')), 'count');
    assert(!(await visible('#reelToggle')) && !(await visible('#reelGrip')), 'always open, as tall as the window');
    await shot('25-gallery', { full: true });
    await click('#reelKinds [data-kind=""]');
    await click('#reelGrid .reel-cell .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="open"]');
    await waitFor('document.querySelector("#view-create").classList.contains("active")', 'back on Create');
    eq(await value('#theme'), 'a lighthouse at dusk', 'entry restored');
    await waitFor('document.querySelectorAll(".take .rtile img").length >= 3', 'renders restored with the take');
  });

  await test('render: rate from the lightbox and Your renders, find it in the Gallery', async () => {
    const rated = async () => (await (await fetch(`${APP}/api/history`)).json()).flatMap(e => e.variations.flatMap(v => v.renders || [])).filter(r => r.rating);
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb-rate="2"]');
    await shot('24a-lightbox-rating');
    await waitFor('document.querySelector(\'[data-lb-rate="2"]\').getAttribute("aria-pressed") === "true"', 'rated very good');
    eq((await rated()).map(r => r.rating).join(), '2', 'saved on the render');
    await press('3');
    await waitFor('document.querySelector(\'[data-lb-rate="3"]\').getAttribute("aria-pressed") === "true"', 'key 3: excellent');
    await press('Escape');
    // Your renders shows every render, with its rating; its stars rate in place.
    await waitFor('document.querySelectorAll("#reel .reel-cell").length >= 3 && !!document.querySelector(\'#reel .reel-cell[data-rating="3"]\')', 'the box shows the renders, rated');
    eq(await count('#reel .reel-cell[data-rating="3"] .rate-bar button.on'), 3, 'three lit stars');
    await js('document.querySelector(\'#reel .reel-cell[data-rating="0"]\').classList.add("rate-me")');
    await click('#reel .reel-cell.rate-me [data-rate="1"]');
    await waitFor('document.querySelectorAll(\'#reel .reel-cell[data-rating="1"]\').length === 1', 'rated pretty good from the box');
    eq((await rated()).map(r => r.rating).sort().join(), '1,3', 'both saved');
    await click('#reel .reel-cell[data-rating="1"] [data-rate="1"]');
    await waitFor('!document.querySelector(\'#reel .reel-cell[data-rating="1"]\')', 'clicking the lit star takes it off');
    await js('document.querySelector("#reel").scrollIntoView()');
    await js('document.querySelector(\'#reel .reel-cell[data-rating="0"]\').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))');
    await shot('24b-your-renders');
    // Its filters: only the excellent one, then all again.
    await click('#reelRated button[data-min="3"]');
    await waitFor('document.querySelectorAll("#reel .reel-cell").length === 1 && !!document.querySelector(\'#reel .reel-cell[data-rating="3"]\')', '★★★ only');
    assert((await text('#reelCount')).startsWith('1 of '), `the count says so: ${await text('#reelCount')}`);
    await click('#reelRated button[data-min="3"]');
    await waitFor('document.querySelectorAll("#reel .reel-cell").length >= 3', 'all again');
    await click('#reel .reel-cell .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'a render opens in the lightbox');
    await press('Escape');
    await click('.tabs button[data-view="gallery"]');
    await click('#reelRated button[data-min="2"]');
    await waitFor('document.querySelectorAll("#galleryHome .reel-cell").length === 1 && !!document.querySelector(\'#galleryHome .reel-cell[data-rating="3"]\')', 'very good and up: only the excellent one');
    await click('#galleryHome .reel-cell .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb-rate="3"]');
    await waitFor('document.querySelector(\'[data-lb-rate="3"]\').getAttribute("aria-pressed") === "false"', 'rating taken off');
    eq((await rated()).length, 0, 'no rating left');
    await press('Escape');
    await click('#reelRated button[data-min="2"]');
    await click('#reelKinds button[data-kind=""]');
    await click('#reelGrid .reel-cell:nth-of-type(2) .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await press('ArrowRight');
    await press('Escape');
    eq(await count('#reelGrid .reel-cell.seen'), 1, 'the Gallery marks the render you looked at last');
    assert(await js('document.querySelector("#reelGrid .reel-cell:nth-of-type(3)").classList.contains("seen")'), 'the one you browsed to, not the one you opened');
    assert(await js('document.activeElement === document.querySelector("#reelGrid .reel-cell.seen .rtile")'), 'and focus is back on it');
    await click('.tabs button[data-view="create"]');
    await waitFor('document.querySelector("#view-create #reel") && !document.querySelector("#reelGrid .reel-cell.seen")', 'back on Create, the same box, unmarked');
  });

  await test('your renders: every render, from before start-up too, in one grid; filters, drag to arrange, height, picture size, full screen', async () => {
    // (The page fetches History again when the Gallery opens; a filter click redraws the box right away.)
    const refetch = async () => {
      await click('.tabs button[data-view="gallery"]');
      await click('.tabs button[data-view="create"]');
      await click('#reelKinds button[data-kind=""]');
    };
    // A render made before Prompt Maker last started shows too (only 🕘 This session leaves it out).
    await fs.writeFile(path.join(dataDir, 'renders', 'earlier-run_0.png'), makePng(48, 64));
    const file = path.join(dataDir, 'history.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8'));
    const old = '2026-01-02T10:00:00.000Z';
    all.push({ id: 'earlier-run', createdAt: old, favorite: false, modelId: 'krea2-raw', modelName: 'Krea 2 RAW', modelKind: 'image', theme: 'a paper boat on a puddle', aspectRatio: '3:4', variations: [{ versions: [{ text: 'a paper boat on a puddle', createdAt: old }], renders: [{ id: 'earlier-r', versionIndex: 0, text: 'a paper boat on a puddle', workflowName: 'Mock', files: [{ file: 'earlier-run_0.png', kind: 'image', name: 'boat.png' }], createdAt: old }] }] });
    await fs.writeFile(file, JSON.stringify(all));
    await refetch();
    const boat = 'document.querySelector(\'#reel .reel-cell[data-file="earlier-run_0.png"]\')';
    await waitFor(`!!${boat}`, 'a render from before start-up is in Your renders');
    assert(await js('document.querySelectorAll("#reel .reel-cell").length === document.querySelectorAll("#reelGrid > .reel-cell").length'), 'one grid, not a row per run');
    await waitFor(`Math.abs(${boat}.getBoundingClientRect().width / ${boat}.getBoundingClientRect().height - 0.75) < 0.02`, 'its card has the picture\'s shape');
    await click('#reelSession');
    await waitFor(`!${boat} && document.querySelectorAll("#reel .reel-cell").length > 0`, '🕘 This session leaves it out');
    await click('#reelSession');
    await type('#reelFind', 'paper boat');
    await waitFor(`!!${boat} && document.querySelectorAll("#reel .reel-cell").length === 1`, 'find it by the words of its prompt');
    await type('#reelFind', 'no such words anywhere');
    await waitFor('!document.querySelector("#reelEmpty").hidden && !document.querySelector("#reel .reel-cell")', 'nothing matches: it says so');
    await click('#reelEmpty [data-reel="all"]');
    await waitFor(`!!${boat} && document.querySelector("#reelFind").value === ""`, 'Show everything clears the filters');

    // Drag a card past two others: it lands there, opens nothing, and the order is saved. Shift+← moves it back one.
    const keys = () => js('[...document.querySelectorAll("#reelGrid > .reel-cell")].map(c => c.dataset.key)');
    const [k0, k1, k2] = await keys();
    await js('document.querySelector("#reelBody").scrollTop = 0; document.querySelector("#reel").scrollIntoView({ block: "start" })');
    const at = n => js(`(() => { const r = document.querySelectorAll("#reelGrid > .reel-cell")[${n}].getBoundingClientRect(); return { x: r.left + r.width * 0.7, y: r.top + r.height / 2 }; })()`); // (right half: it goes after)
    const from = await at(0);
    const to = await at(2);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 12; k++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * k) / 12, y: from.y + ((to.y - from.y) * k) / 12, button: 'left', buttons: 1 });
    assert(await js('!!document.querySelector(".reel-ghost") && document.querySelector("#reel").classList.contains("sorting")'), 'the card is carried while dragging');
    await shot('24c-your-renders-dragging');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    // (Headless Chrome now and then drops the release right after a screenshot: a mouse move with no button down, as a hand would make, ends the drag too.)
    if (!(await waitFor('!document.querySelector(".reel-ghost")', 'the card is let go', 1500).catch(() => false))) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x + 1, y: to.y, button: 'none', buttons: 0 });
    await waitFor('!document.querySelector(".reel-ghost")', 'the card is let go');
    await sleep(100);
    eq((await keys()).slice(0, 3).join(), [k1, k2, k0].join(), 'over a card\'s right half, it lands after it');
    const after = await js('JSON.stringify({ viewerOpen: !document.querySelector("#lightbox").hidden, stillCarried: !!document.querySelector(".reel-ghost"), sorting: document.querySelector("#reel").classList.contains("sorting") })');
    eq(after, '{"viewerOpen":false,"stillCarried":false,"sorting":false}', 'dropping it opens nothing, and the card is let go');
    await waitFor(`(async () => { const o = (await (await fetch('/api/render-order')).json()).order; return o.indexOf(${q(k0)}) > o.indexOf(${q(k2)}) && o.indexOf(${q(k2)}) >= 0; })()`, 'the order is saved');
    await js(`document.querySelector('#reelGrid > .reel-cell[data-key="${k0}"] .rtile').focus()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 8 });
    eq((await keys()).slice(0, 3).join(), [k1, k0, k2].join(), 'Shift+← moves it back one place');
    assert(await js(`document.activeElement === document.querySelector('#reelGrid > .reel-cell[data-key="${k0}"] .rtile')`), 'and it keeps the focus');
    assert(await visible('#reelNewest'), '↺ Newest first shows once you have your own order');
    await click('#reelNewest');
    await click('#reelNewest');
    eq((await keys()).slice(0, 3).join(), [k0, k1, k2].join(), '↺ Newest first puts them back');
    await waitFor('(async () => (await (await fetch("/api/render-order")).json()).order.length === 0)()', 'and forgets your order');
    assert(!(await visible('#reelNewest')), 'and the button goes');

    // Pick several: Ctrl-click, then a box dragged with Ctrl from a card; the bar deletes them, with ↶ Undo.
    const cell = n => `#reelGrid > .reel-cell:nth-child(${n + 1})`;
    const ctrlClick = async n => {
      const p = await at(n);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: 2 });
      await sleep(60);
    };
    await ctrlClick(0);
    await ctrlClick(1);
    eq(await count('#reelGrid > .reel-cell.picked'), 2, 'Ctrl-click picks cards');
    assert(!(await js('!document.querySelector("#lightbox").hidden')), 'and opens nothing');
    assert((await visible('#reelSel')) && (await text('#reelSelCount')) === '2 selected', 'the bar says how many');
    await ctrlClick(1);
    eq(await count('#reelGrid > .reel-cell.picked'), 1, 'Ctrl-click again lets one go');
    await press('Escape');
    eq(await count('#reelGrid > .reel-cell.picked'), 0, 'Esc lets go of them all');
    assert(!(await visible('#reelSel')), 'and the bar goes');
    const b0 = await at(0), b2 = await at(2);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b0.x, y: b0.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 });
    for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b0.x + ((b2.x - b0.x) * k) / 10, y: b0.y + ((b2.y - b0.y) * k) / 10 + 2, button: 'left', buttons: 1, modifiers: 2 });
    assert(await js('!!document.querySelector(".pick-band") && !document.querySelector(".reel-ghost")'), 'Ctrl-drag draws a box, it doesn\'t carry the card');
    await shot('24d-your-renders-box');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b2.x, y: b2.y + 2, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 });
    await sleep(80);
    assert(!(await js('!!document.querySelector(".pick-band")')), 'the box goes when you let go');
    assert(await count('#reelGrid > .reel-cell.picked') >= 3, 'it picks every card it touched');
    assert(!(await js('!document.querySelector("#lightbox").hidden')), 'and opens nothing');
    const picked = await count('#reelGrid > .reel-cell.picked');
    await shot('24e-your-renders-picked');
    await click('#reelSelDelete');
    await click('#reelSelDelete');
    await toastText('Deleting');
    eq(await count('#reelGrid > .reel-cell.going'), picked, 'they dim while they wait');
    await click('#toast .toast-act');
    await toastText('Kept');
    eq(await count('#reelGrid > .reel-cell.going'), 0, '↶ Undo keeps them all');
    const total = await count('#reelGrid > .reel-cell');
    await ctrlClick(0);
    await ctrlClick(1);
    await press('Delete');
    await press('Delete');
    await toastText('Deleting 2 renders');
    await toastText('2 renders deleted', UNDO_WAIT);
    await waitFor(`document.querySelectorAll("#reelGrid > .reel-cell").length === ${total - 2}`, 'two fewer, after the 8 s');

    // Its height stays put (renders scroll inside it); drag the bottom edge, or ↑ ↓ on it, to change it.
    const bodyH = () => js('document.querySelector("#reelBody").offsetHeight');
    const h0 = await bodyH();
    await js('document.querySelector("#reelGrip").scrollIntoView({ block: "center" })');
    const grip = await js('(() => { const r = document.querySelector("#reelGrip").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y + (120 * k) / 6, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x, y: grip.y + 120, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(100);
    eq(await bodyH(), h0 + 120, 'dragged 120 px taller');
    await js('document.querySelector("#reelGrip").focus()');
    await press('ArrowUp');
    eq(await bodyH(), h0 + 80, '↑ makes it shorter');
    eq(await js('Number(localStorage.getItem("pm.reelHeight"))'), h0 + 80, 'and that height is remembered');

    // ⛶ Full screen fills the window; 🔍 makes pictures as big as the box. The lightbox opens over it; Esc goes back.
    await click('#reelFull');
    assert(await js('(() => { const r = document.querySelector("#reel").getBoundingClientRect(); return r.top === 0 && r.left === 0 && r.bottom === innerHeight; })()'), 'full screen fills the window');
    await js('(() => { const s = document.querySelector("#reelSize"); s.value = s.max; s.dispatchEvent(new Event("input")); })()');
    const tall = await js('document.querySelector("#reel .reel-cell").getBoundingClientRect().height');
    assert(tall > 600, `at its biggest, a picture fills the height: ${tall}px`);
    await shot('24d-your-renders-full-screen');
    await click('#reel .reel-cell .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'the lightbox opens over it');
    await press('Escape');
    assert(await js('document.querySelector("#lightbox").hidden && document.querySelector("#reel").classList.contains("full")'), 'Esc closes the lightbox first');
    await press('Escape');
    assert(!(await js('document.querySelector("#reel").classList.contains("full")')), 'then leaves full screen');
    assert(await js('document.querySelector("#reel .reel-cell").getBoundingClientRect().height <= document.querySelector("#reelBody").offsetHeight'), 'back in the box, pictures fit its height');

    // As it was: the usual sizes, and the earlier render gone again.
    await js('localStorage.removeItem("pm.reelSize"); localStorage.removeItem("pm.reelHeight"); dispatchEvent(new Event("resize"))');
    await fs.writeFile(file, JSON.stringify(all.filter(e => e.id !== 'earlier-run')));
    await fs.rm(path.join(dataDir, 'renders', 'earlier-run_0.png'));
    await refetch();
    await waitFor(`!${boat}`, 'the earlier render leaves with its entry');
  });

  await test('gallery: video tiles show a still of their first frame, and play on hover; the lightbox keeps your sound', async () => {
    const mp4 = path.join(dataDir, 'renders', 'poster-test_0.mp4');
    const made = await new Promise(resolve => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p', '-shortest', mp4], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', code => resolve(code === 0));
    });
    if (!made) return console.log('      (skipped: ffmpeg not installed)');
    const file = path.join(dataDir, 'history.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8'));
    all.unshift({ id: 'poster-test', createdAt: new Date().toISOString(), favorite: false, modelId: 'ltx-2-3', modelName: 'LTX 2.3', modelKind: 'video', theme: 'a test pattern', variations: [{ versions: [{ text: 'a test pattern', createdAt: new Date().toISOString() }], renders: [{ id: 'poster-r', versionIndex: 0, text: 'a test pattern', workflowName: 'Mock', files: [{ file: 'poster-test_0.mp4', kind: 'video', name: 'test.mp4' }], createdAt: new Date().toISOString() }] }] });
    await fs.writeFile(file, JSON.stringify(all));
    await click('.tabs button[data-view="gallery"]');
    await waitFor('/^data:image\\/jpeg/.test(document.querySelector(\'#reelGrid video[src*="poster-test_0.mp4"]\')?.getAttribute("poster") || "")', 'the video tile got its still', 15000);
    eq(await js('document.querySelector(\'#reelGrid video[src*="poster-test_0.mp4"]\').preload'), 'none', 'the video itself loads only when played');
    // The lightbox plays it with sound, and the next one with the sound you left this one at.
    await js('localStorage.removeItem("pm.lbSound")');
    const lbVid = '#lbStage video[src*="poster-test_0.mp4"]';
    const openLb = async () => {
      await click('#reelGrid .reel-cell:has(video[src*="poster-test_0.mp4"]) .rtile');
      await waitFor(`document.querySelector('${lbVid}')?.paused === false`, 'the lightbox plays the video', 10000);
    };
    await openLb();
    eq(await js(`document.querySelector('${lbVid}').muted`), false, 'with sound the first time');
    await js(`(v => { v.volume = 0.4; v.muted = true; })(document.querySelector('${lbVid}'))`);
    await waitFor('JSON.parse(localStorage.getItem("pm.lbSound") || "{}").muted === true', 'muting is remembered');
    await press('Escape');
    await openLb();
    eq(await js(`(v => v.muted + ' ' + v.volume)(document.querySelector('${lbVid}'))`), 'true 0.4', 'opens muted, at the volume you left');
    await js(`document.querySelector('${lbVid}').muted = false`);
    await press('Escape');
    await openLb();
    eq(await js(`document.querySelector('${lbVid}').muted`), false, 'sound back on, and it stays on');
    await press('Escape');
    await fs.writeFile(file, JSON.stringify(all.slice(1)));
    await fs.rm(mp4);
    await click('.tabs button[data-view="create"]');
  });

  await test('render: delete from the lightbox', async () => {
    const before = await count('.take .rtile img');
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="delete"]');
    await click('[data-lb="delete"]');
    await toastText('Render deleted', UNDO_WAIT);
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

  await test('render: a page reload doesn\'t stop it; the page picks it up, and ✕ Cancel still works', async () => {
    const reload = async () => {
      await js('document.documentElement.dataset.ready = ""; location.reload()'); // not ready until the new page is
      await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded', 15000);
    };
    await type('#theme', 'SLOWRENDER lanterns on a river');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-count button[data-value="1"]');
    const before = comfy.prompts.length;
    await click('.take .rb-go');
    await waitFor('/[1-9]\\d*%/.test(document.querySelector(".take .rtile.running .rt-pct")?.textContent || "")', 'running');
    await reload();
    await waitFor('!!document.querySelector(".take .rtile.running")', 'the running render is back on the stage');
    await toastText('still going');
    eq(await value('#theme'), 'SLOWRENDER lanterns on a river', 'with its take');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'and it finishes', 15000);
    eq(comfy.prompts.length, before + 1, 'one job, not restarted');
    eq(await count('.take .rtile img'), 1, 'one render, shown once');

    await click('.take .rb-go');
    await waitFor('/[1-9]\\d*%/.test(document.querySelector(".take .rtile.running .rt-pct")?.textContent || "")', 'running again');
    await reload();
    await waitFor('!!document.querySelector(".take .rtile.running .rt-cancel")', 'back, with Cancel');
    await click('.take .rtile.running .rt-cancel');
    await waitFor('!document.querySelector(".take .rtile.running")', 'cancelled', 8000);
    await toastText('Render stopped');
    eq((await (await fetch(`${APP}/api/renders`)).json()).length, 0, 'nothing left running');
    eq(await count('.take .rtile img'), 1, 'no render from the cancelled job');
  });

  await test('rendering now: the top bar shows every render still going; open one, cancel one', async () => {
    assert(!(await visible('#rendersBtn')), 'no pill while nothing renders');
    await type('#theme', 'SLOWRENDER paper cranes in the wind');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-count button[data-value="2"]');
    await click('.take .rb-go');
    await waitFor('/[1-9]\\d*%/.test(document.querySelector(".take .rtile.running .rt-pct")?.textContent || "")', 'running');
    await waitFor('!document.querySelector("#rendersBtn").hidden', 'the pill shows');
    eq(await text('#rendersCount'), '2', 'it counts the renders left');
    await click('#newBtn'); // the take (and its live tiles) leave the stage
    await waitFor('!document.querySelector(".take")', 'stage cleared');
    await click('#rendersBtn');
    await waitFor('document.querySelectorAll("#rendersList .rp-row").length === 1', 'the panel lists it');
    assert((await text('#rendersList .rp-row')).includes('paper cranes'), 'by its theme');
    await waitFor('/Render [12] of 2/.test(document.querySelector("#rendersList .rp-stage").textContent)', 'with its progress');
    await shot('40-rendering-now');
    await click('#rendersList [data-rp="open"]');
    await waitFor('!!document.querySelector(".take .rtile.running")', 'Open brings the take back, rendering live');
    eq(await value('#theme'), 'SLOWRENDER paper cranes in the wind', 'its take');
    await click('#rendersBtn');
    await click('#rendersList [data-rp="cancel"]');
    await waitFor('document.querySelector("#rendersBtn").hidden', 'cancelled: the pill goes', 10000);
    await waitFor('!document.querySelector(".take .rtile.running")', 'and the live tiles stop');
    eq((await (await fetch(`${APP}/api/renders`)).json()).length, 0, 'nothing left running');
  });

  await test('assistant: on by default, sees the renders and says which it likes; ratings; asks before deleting', async () => {
    const bot = () => js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""');
    const idle = () => waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    // On by default: with no choice saved, the panel opens with the app.
    // (ready is cleared first, so the wait below can't be met by the page that's going away)
    await js('document.documentElement.dataset.ready = ""; localStorage.removeItem("pm.assistantOpen"); sessionStorage.setItem("default-assistant", "1"); location.reload()');
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded', 15000);
    assert(await visible('#assistant'), 'the assistant is open from the start');
    await js('sessionStorage.removeItem("default-assistant")');
    try {
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a red balloon over the rooftops');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-count button[data-value="1"]');
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'a render to look at', 10000);

    await type('#asInput', 'Which of these renders do you like best?');
    await press('Enter');
    await idle();
    assert((await bot()).includes('take 1, render 1'), `it gives an opinion: ${await bot()}`);
    assert(await count('#asLog .as-seen img') >= 1, 'the chat shows what it looked at');
    const sent = JSON.stringify(lastCall().messages);
    assert(/data:image\/jpeg;base64,/.test(sent), 'the Brain got the pictures');

    // Renders you made, found by what they show (not just the newest ones).
    await type('#asInput', 'show me my renders of the red balloon over rooftops');
    await press('Enter');
    await idle();
    assert((await bot()).includes('Found them') && (await bot()).includes('red balloon'), `it finds renders by the words of their prompt: ${await bot()}`);
    await type('#asInput', 'show me my renders of a purple elephant skating');
    await press('Enter');
    await idle();
    assert((await bot()).includes('None of your renders'), `and says so when none match: ${await bot()}`);

    await type('#asInput', 'rate the first one excellent');
    await press('Enter');
    await idle();
    assert((await js('[...document.querySelectorAll("#asLog .as-act")].map(a => a.textContent).join("|")')).includes('Rated excellent'), 'rated');
    const fav = (await (await fetch(`${APP}/api/history`)).json()).flatMap(e => e.variations.flatMap(v => v.renders || [])).filter(r => r.rating === 3);
    assert(fav.length >= 1, 'saved as excellent');

    await type('#asInput', 'pick the best one for a poster');
    await press('Enter');
    await idle();
    const picked = await js('[...document.querySelectorAll("#asLog .as-act")].map(a => a.textContent).join("|")');
    assert(picked.includes('Picked') && picked.includes('the light is softer'), `it looks, picks one and says why: ${picked}`);
    assert(await js('!document.querySelector("#dropzone .dz-preview").hidden && !!document.querySelector("#roleBlock .role.active[data-value=reference]")'), 'and puts it in step 3 as the reference');
    await js('document.querySelector("#imageClear").click()');
    assert(/reads better\. Rated ★★(★)?\. Step 3/.test(picked), `and rates it (never lower than it was): ${picked}`);

    // Judging: every unrated render gets a rating for the purpose; a clear failure is hidden, with the reason.
    await click('.take .rb-count button[data-value="2"]');
    await click('.take .rb-go');
    await waitFor('document.querySelectorAll(".take .rtile img").length >= 3 && !document.querySelector(".take .rtile.running")', 'two more renders', 15000);
    await type('#asInput', 'judge the renders for a poster');
    await press('Enter');
    await idle();
    assert((await bot()).includes('Rated 1 of 2 (1 ★★★)') && (await bot()).includes('hid 1 that failed') && (await bot()).includes('warped hands'), `rates them, hides the failure and says why: ${await bot()}`);
    const judged = (await (await fetch(`${APP}/api/history`)).json()).flatMap(e => e.variations.flatMap(v => (v.renders || []).map(r => ({ ...r, entry: e.id }))));
    const gone = judged.filter(r => r.hidden);
    eq(gone.length, 1, 'one hidden, none deleted');
    eq(judged.filter(r => r.rating === 3).length, 2, 'the one rated before kept its rating, the good one got ★★★');
    await fetch(`${APP}/api/history/${gone[0].entry}/renders/${gone[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden: false }) });

    const before = (await (await fetch(`${APP}/api/history`)).json()).length;
    await type('#asInput', 'delete this prompt');
    await press('Enter');
    await waitFor('!!document.querySelector("#asLog .as-confirm")', 'it asks on screen first');
    await click('#asLog [data-confirm="no"]');
    await idle();
    assert((await bot()).includes('kept it'), 'and keeps it when you say no');
    eq((await (await fetch(`${APP}/api/history`)).json()).length, before, 'nothing deleted');
    await waitFor('!!document.querySelector("#asLog .as-msg.bot")', 'saved');
    await sleep(300);
    assert(!(await fs.readFile(path.join(dataDir, 'assistant.json'), 'utf8')).includes('data:image'), 'pictures it saw aren\'t saved to disk');
    } finally {
      if (await visible('#assistant')) {
        await click('#asClear'); // a fresh conversation for the tests after this
        await click('#asClear');
        await click('#asClose');
      }
    }
  });

  await test('history: opening a card puts back everything it was made with, render setup too', async () => {
    const flows = async () => (await fetch(`${APP}/api/workflows`)).json();
    const picked = await js('document.querySelector(".take .rb-wf")?.selectedOptions[0]?.textContent || ""');
    const flow = (await flows()).find(f => f.modelId === 'krea2-raw' && f.name === picked);
    await fetch(`${APP}/api/workflows/${flow.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seedPatch: { mode: 'fixed', value: 4242 } }) });
    await js('document.documentElement.dataset.ready = ""; location.reload()'); // not ready until the new page is
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded', 15000);
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a glass of lemonade on a porch');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-count button[data-value="2"]');
    await click('.take .rb-go');
    await waitFor('document.querySelectorAll(".take .rtile img").length === 2 && !document.querySelector(".take .rtile.running")', 'rendered ×2', 10000);
    // Change the setup: random seed, ×1, another prompt.
    await fetch(`${APP}/api/workflows/${flow.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seedPatch: { mode: 'random' } }) });
    await js('document.documentElement.dataset.ready = ""; location.reload()'); // not ready until the new page is
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded', 15000);
    await type('#theme', 'something else entirely');
    await click('.tabs button[data-view="history"]');
    await waitFor(`[...document.querySelectorAll(".hcard")].some(c => c.textContent.includes("a glass of lemonade"))`, 'the card');
    const n = await js(`[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("a glass of lemonade")) + 1`);
    await click(`.hcard:nth-of-type(${n}) [data-act="open"]`);
    await waitFor('document.querySelector("#theme").value === "a glass of lemonade on a porch"', 'the theme is back');
    await waitFor('document.querySelector(".take .rb-count .active")?.dataset.value === "2"', 'renders per take back to ×2');
    const seed = (await flows()).find(f => f.id === flow.id).seed;
    eq(seed.mode, 'fixed', 'the seed mode is back');
    eq(seed.value, 4242, 'and the seed');
    await fetch(`${APP}/api/workflows/${flow.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seedPatch: { mode: 'random' } }) });
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

  await test('batches: named, each its own count and prompts; run one or all in order; Stop; saved', async () => {
    await openPanel('create-render');
    await openPanel('create-render-batch');
    assert(await visible('#batchBox'), 'Batch shows once the model has a workflow');
    eq(await value('#batchPick'), '', 'no batch at first');

    // A new batch: you name it, pick how many images and how its prompts work.
    await click('#batchAdd');
    eq(await js('document.activeElement.classList.contains("b-name")'), true, 'ready to be named');
    await type('#batchList li:nth-child(1) .b-name', 'Hero shots');
    await press('Enter');
    await type('#batchList li:nth-child(1) .b-count input', '4');
    await press('Enter');
    eq(await text('#batchList li:nth-child(1) .b-count span'), 'images', 'counted in images for an image model');
    await click('#batchList li:nth-child(1) [data-mode="same"]');
    eq(await text('#batchPick option:checked'), '🎞 Hero shots · 4 images, one prompt', 'picked, and says what it is');
    eq(await text('#genLabel'), 'Generate “Hero shots”', 'Generate runs it');
    eq(await text('#genCost'), '🎞 4 images, one prompt', 'what it will do');
    assert(await js('[...document.querySelectorAll("#varSeg button")].every(b => b.disabled)'), 'Takes are set by the batch');
    assert(!(await visible('#wfpAutoRow')), 'a batch always renders: no auto-render switch');
    await js('document.querySelector("#renderStep").scrollIntoView({ block: "center" })');
    await shot('batch');

    // One prompt, four renders, a new seed each; the History entry carries the batch's name.
    await type('#theme', 'a paper boat in the rain');
    let before = comfy.prompts.length;
    await click('#generateBtn');
    await waitFor('/Hero shots/.test(document.querySelector("#genLabel").textContent)', 'progress on the button');
    await genDone();
    eq(await count('.take'), 1, 'one prompt written');
    eq(await count('.take .rtile img'), 4, 'rendered four times');
    let sent = comfy.prompts.slice(before);
    eq(sent.length, 4, 'four renders queued');
    eq(new Set(sent.map(p => p.prompt['6'].inputs.text)).size, 1, 'all of the same prompt');
    eq(new Set(sent.map(p => p.prompt['3'].inputs.seed)).size, 4, 'a new seed each');
    await toastText('“Hero shots” done: 4 images');
    assert((await text('#stageHead')).includes('🎞 Hero shots'), 'the takes say which batch they came from');

    // A second batch with its own choice: a different prompt each.
    await click('#batchAdd');
    await type('#batchList li:nth-child(2) .b-name', 'Explore');
    await press('Enter');
    await type('#batchList li:nth-child(2) .b-count input', '3');
    await press('Enter');
    await click('#batchList li:nth-child(2) [data-mode="different"]');
    eq(await js('[...document.querySelectorAll("#batchList [data-mode].active")].map(b => b.dataset.mode).join("|")'), 'same|different', 'each batch keeps its own choice');

    // All batches, one after another: each its own takes and History entry.
    await choose('#batchPick', '*');
    eq(await text('#genLabel'), 'Generate all 2 batches', 'Generate runs them all');
    eq(await text('#genCost'), '🎞 2 batches · 7 images', 'how much in all');
    before = comfy.prompts.length;
    await click('#generateBtn');
    await genDone();
    sent = comfy.prompts.slice(before);
    eq(sent.length, 7, '4 + 3 renders');
    eq(new Set(sent.slice(4).map(p => p.prompt['6'].inputs.text)).size, 3, '“Explore”: a different prompt each');
    eq(await count('.take'), 3, 'the stage shows the last batch');
    await toastText('All 2 batches done: 7 images');
    const tagged = JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8')).slice(0, 2).map(e => e.batch).join('|');
    eq(tagged, 'Explore|Hero shots', 'one History entry per batch, named after it');

    // Stop: what's running is cancelled, nothing new starts, finished renders stay.
    await type('#batchList li:nth-child(2) .b-count input', '8');
    await press('Enter');
    await choose('#batchPick', await js('document.querySelector("#batchList li:nth-child(2)").dataset.id'));
    before = comfy.prompts.length;
    await click('#generateBtn');
    await waitFor('!!document.querySelector(".take .rtile.running")', 'the batch started rendering', 15000);
    await click('#stopBtn');
    await genDone();
    assert(comfy.prompts.length - before < 8, 'the rest never started');
    await toastText('Batch stopped');

    // Saved: still there after a reload. Delete, with undo.
    await goto(`${APP}/#create`);
    eq(await js('[...document.querySelectorAll("#batchList .b-name")].map(i => i.value).join("|")'), 'Hero shots|Explore', 'batches are saved');
    eq(await text('#genLabel'), 'Generate “Explore”', 'and so is the pick');
    await openPanel('create-render-batch');
    await click('#batchList li:nth-child(2) .b-del');
    eq(await count('#batchList li'), 1, 'deleted');
    eq(await value('#batchPick'), '', 'its pick went with it');
    // The other batch changes before the undo: that change stays.
    await js('(() => { const i = document.querySelector("#batchList li .b-count input"); i.value = "7"; i.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await click('#toast .toast-act');
    await waitFor('document.querySelectorAll("#batchList li").length === 2', 'undo brings it back');
    eq(await js('[...document.querySelectorAll("#batchList .b-name")].map(i => i.value).join("|")'), 'Hero shots|Explore', 'where it was');
    eq(await value('#batchList li .b-count input'), '7', 'and what changed meanwhile is kept');
    await choose('#batchPick', '');
    eq(await text('#genLabel'), 'Generate', 'no batch: a plain Generate again');
    assert(!(await js('document.querySelector("#varSeg button").disabled')), 'Takes are yours again');
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
    // Filters: any number at once, with counts; All clears them.
    await click('#llmFilters [data-trait="vision"]');
    assert(await js('[...document.querySelectorAll("#llmList [role=option]")].every(o => o.querySelector(".n").textContent.startsWith("👁"))'), 'vision only');
    assert(!(await js('!!document.querySelector(\'#llmList [data-id="mock/text-only"]\')')), 'text-only Brains hidden');
    assert(/Vision \d+/.test(await text('#llmFilters [data-trait="vision"]')), 'with a count');
    await click('#llmFilters [data-trait="loaded"]');
    eq(await js('[...document.querySelectorAll("#llmFilters [aria-pressed=true]")].map(b => b.dataset.trait).join("|")'), 'vision|loaded', 'two at once');
    eq(await js('[...document.querySelectorAll("#llmList [role=option]")].map(o => o.dataset.id).join("|")'), 'mock/vision-8b', 'only Brains that are both');
    eq(await js('document.querySelector("#llmFilters").scrollWidth <= document.querySelector("#llmFilters").clientWidth'), true, 'the filters wrap instead of running off the menu');
    await click('#llmFilters [data-all]');
    eq(await js('document.querySelectorAll("#llmFilters [data-trait][aria-pressed=true]").length'), 0, 'All clears them');
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
    await waitFor('document.activeElement?.closest("#samplerCtl")', 'settings chips jump to the sampler'); // on the next frame
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

  await test('create: your own prompt, word for word, with no Brain', async () => {
    await click('.model-card[data-id="krea2-raw"]');
    assert(!(await js('document.querySelector("#manualMode").checked')), 'off by default');
    eq(await text('[data-panel="create-theme"] h2'), 'Describe the shot', 'the Brain writes from your idea');
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector(".dz-preview").hidden', 'image preview');
    assert(await visible('#roleBlock'), 'the Brain asks how to use the image');
    await click('.manual-row .switch');
    await toastText('Your own prompt');
    eq(await text('[data-panel="create-theme"] h2'), 'Your prompt', 'step 2 is your prompt now');
    assert(!(await visible('#roleBlock')) && !(await visible('#roleHint')), 'the image goes in as it is: no role to pick');
    assert(!(await visible('#surpriseBtn')) && !(await visible('#lengthField')) && !(await visible('#tempField')), 'the Brain\'s dials step aside');
    assert(!(await visible('#wfpAutoRow')), 'no auto-render switch: your own prompt always renders');
    assert(!(await visible('#chainStep')), 'no chain: its steps are written by the Brain');
    eq(await text('#takesLabel'), 'Renders', 'Takes becomes how many renders');
    await click('#varSeg button[data-value="2"]');
    eq(await text('#genLabel'), 'Render ×2', 'Generate says what it does');
    const prompt = 'masterpiece, (red kite:1.3) over dunes, 35mm — keep EXACTLY as typed';
    await type('#theme', prompt);
    const calls = mockCalls();
    const before = comfy.prompts.length;
    await click('#generateBtn');
    await genDone();
    await waitFor('document.querySelectorAll(".take .rtile img").length === 2 && !document.querySelector(".take .rtile.running")', 'rendered twice with no click', 15000);
    eq(mockCalls(), calls, 'no Brain was asked');
    eq(await count('.take'), 1, 'one take');
    eq(await value('.take .prompt-text'), prompt, 'the take is your text');
    eq(comfy.prompts.length, before + 2, 'two renders');
    eq(comfy.prompts.at(-1).prompt['6'].inputs.text, prompt, 'ComfyUI got it word for word');
    assert((await text('#stageHead')).includes('your own prompt'), 'the stage says who wrote it');
    assert(!(await text('.take .meter')).includes('target'), 'no Brain length target to meet');
    eq(await text('.take .rb-count .active'), '×2', 'the take shows the renders it got');
    const entry = (await js('fetch("/api/history").then(r => r.json())'))[0];
    assert(entry.manual && entry.imageFile && !entry.llmModel, 'History keeps it as yours, with the image');
    await shot('33a-own-prompt', { full: true });

    await click('.manual-row .switch');
    await toastText('Brain writes the prompts again');
    assert(await visible('#tempField') && await visible('#roleBlock') && await visible('#chainStep'), 'everything is back');
    eq(await text('#takesLabel'), 'Takes', 'Takes again');
    await click('#imageClear');
    await click('#varSeg button[data-value="1"]');
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
    const asked = JSON.stringify(mock.log.at(-1).messages);
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
    eq(await js('[document.querySelector(\'.chain-card [data-f="duration"]\').type, document.querySelector(\'.chain-card [data-f="duration"]\').min, document.querySelector(\'.chain-card [data-f="duration"]\').max].join()'), 'range,1,20', 'duration is a 1–20 s slider');
    await js(`(() => { const r = document.querySelector('.chain-card [data-f="duration"]'); r.value = 7; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq(await text('.chain-card .cc-dur output'), '7s', 'the slider shows its seconds');
    assert((await text('.chain-card .cc-title small')).endsWith('7s'), 'and the step\'s summary too');
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
    const asked = JSON.stringify(mock.log.at(-1).messages);
    assert(asked.includes('THEME: the waves crash against the rocks') && asked.includes('PREVIOUS STEP'), 'step 2 got the direction as changed while picking, and the still\'s prompt');
    const all = await (await fetch(`${APP}/api/history`)).json();
    const root = all.find(e => e.chain?.step === 0 && e.theme === 'a lighthouse in a storm');
    const child = all.find(e => e.chain?.runId === root.chain.runId && e.chain.step === 1);
    eq(root.chain.steps.length, 2, 'the run remembers its steps');
    eq(child.source.entryId, root.id, 'step 2 links to step 1');
    eq(child.duration, '7s', 'step 2 rendered at the slider\'s duration');
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

  await test('chains: the Brain picks the best still, and only it goes on', async () => {
    await click('.chain-gate button[data-gate="brain"]');
    await click('#varSeg button[data-value="2"]');
    await click('#wfpRenders button[data-value="2"]');
    eq(await text('#genCost'), '⛓ 4 stills → 🧠 the best one → 1 video', 'four stills, one video');
    const before = comfy.prompts.length;
    await type('#theme', 'a hot air balloon at dawn');
    await click('#generateBtn');
    await toastText('the Brain picked take 1', 30000);
    await waitFor('document.querySelector("#runStrip .rs-status")?.textContent.includes("Done")', 'ran straight through', 30000);
    eq(comfy.prompts.length, before + 5, 'four stills and one video, no clicks');
    const all = await (await fetch(`${APP}/api/history`)).json();
    const root = all.find(e => e.chain?.step === 0 && e.theme === 'a hot air balloon at dawn');
    const kids = all.filter(e => e.chain?.runId === root.chain.runId && e.chain.step === 1);
    eq(kids.length, 1, 'one still went on');
    eq(kids[0].source.renderId, root.variations[0].renders[1].id, 'the one the Brain named (number 2 of 4)');
    await click('#wfpRenders button[data-value="1"]');
    await click('.chain-gate button[data-gate="pick"]');
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
    eq(await js(`[document.querySelector('${lora('.lr-range')}').min, document.querySelector('${lora('.lr-range')}').max].join()`), '-5,5', 'the slider spans −5 to 5');
    await type(lora('[data-key="+0"] .lr-num'), '100');
    await press('Enter');
    await waitFor(`fetch('/api/workflows').then(r => r.json()).then(l => l.find(w => w.id === ${q(await value('#wfpSelect'))})?.loras.added[0]?.strength === 100)`, 'a typed 100 is kept as 100');
    eq(`${await value(lora('[data-key="+0"] .lr-num'))}|${await value(lora('[data-key="+0"] .lr-range'))}`, '100.00|5', 'the box shows it, the slider sits at its end');
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

  await test('LoRAs: a newer version in the folder is offered, one click swaps it; a missing one offers the version you have', async () => {
    const lora = sel => `#wfpLoras ${sel}`;
    const loras = OBJECT_INFO.LoraLoaderModelOnly.input.required.lora_name[0];
    const id = await value('#wfpSelect');
    const flowOf = () => js(`fetch('/api/workflows').then(r => r.json()).then(l => l.find(w => w.id === ${q(id)}).loras)`);
    const before = await flowOf();
    loras.push('krea2/baked_in_v2.safetensors', 'krea2/baked_in_v3.safetensors', 'krea2/film_grain-000800.safetensors');
    try {
      await goto(`${APP}/#create`);
      await openPanel('create-render-adv');
      await waitFor(`!!document.querySelector('${lora('[data-key="20"] .lr-newer')}')`, 'the newest version is offered');
      eq(await text(lora('[data-key="20"] .lr-newer')), '🆕 v3', 'the newest, not just any newer one');
      assert(!(await js(`document.querySelector('${lora('[data-key="+0"] .lr-newer')}')`)), 'a training step is no version of a LoRA without one');
      const h = await js(`document.querySelector('${lora('[data-key="20"]')}').offsetHeight`);
      await click(lora('[data-key="20"] .lr-newer'));
      await toastText('Now using baked_in_v3');
      assert((await text(lora('[data-key="20"] .lr-name'))).includes('baked_in_v3') && (await text(lora('[data-key="20"] .lr-name'))).includes('in place of baked_in'), 'it says what it replaced');
      eq(await js(`document.querySelector('${lora('[data-key="20"]')}').offsetHeight`), h, 'the row keeps its height');
      await waitFor(`fetch('/api/workflows').then(r => r.json()).then(l => l.find(w => w.id === ${q(id)}).loras.tweaks['20']?.name === 'krea2/baked_in_v3.safetensors')`, 'saved on the workflow');
      eq((await flowOf()).tweaks['20'].strength, before.tweaks['20'].strength, 'same strength');
      if (await js(`document.querySelector('${lora('[data-key="20"]')}').classList.contains('off')`)) await click(lora('[data-key="20"] .switch'));
      if (!(await js('!!document.querySelector(".take .rb-go")'))) {
        await type('#theme', 'a portrait in window light');
        await click('#generateBtn');
        await genDone();
      }
      const v3file = path.join(comfyRoot, 'models/loras/krea2/baked_in_v3.safetensors');
      await fs.writeFile(v3file, 'aaa');
      await click('.take .rb-go');
      await waitFor('!document.querySelector(".take .rtile.running")', 'rendered', 10000);
      eq(comfy.prompts.at(-1).prompt['20'].inputs.lora_name, 'krea2/baked_in_v3.safetensors', 'the render loads the new file');

      // The render remembers the file it used; replaced under the same name, the lightbox says so.
      const made = (await (await fetch(`${APP}/api/history`)).json()).flatMap(e => e.variations.flatMap(v => v.renders || [])).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      eq(made.loras.find(l => l.name === 'krea2/baked_in_v3.safetensors')?.file?.size, 3, 'the file it used is recorded');
      // A ComfyUI on another computer: its model list says the same (also for a file named without its subfolder).
      const remote = await comfyLib.loraFilesOverApi(`http://127.0.0.1:${COMFY_PORT}`, ['krea2/baked_in_v3.safetensors', 'baked_in_v3.safetensors', 'krea2/nope.safetensors']);
      eq(`${remote['krea2/baked_in_v3.safetensors']?.size}|${remote['baked_in_v3.safetensors']?.size}|${remote['krea2/nope.safetensors']}`, '3|3|undefined', 'ComfyUI\'s model list gives sizes too');
      assert(Math.abs(remote['krea2/baked_in_v3.safetensors'].mtime - made.loras.find(l => l.name === 'krea2/baked_in_v3.safetensors').file.mtime) <= 1000, 'and the same date');
      await fs.writeFile(v3file, 'bbbbbb');
      await click('.take .rtile');
      await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
      await waitFor('document.querySelector("#lbInfo").textContent.includes("baked_in_v3 0.80 ⚠️ file changed since")', 'the replaced file is flagged');
      await press('Escape');

      // A file that's gone: the notice offers the version you have.
      await js(`fetch('/api/workflows/${id}', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loras: { tweaks: { 20: { on: true, strength: 0.8, name: 'krea2/baked_in_v9.safetensors' } }, added: ${JSON.stringify(before.added)} } }) })`);
      await goto(`${APP}/#create`);
      await openPanel('create-render-adv');
      await waitFor('!!document.querySelector("#wfpModels [data-act=mm-swap]")', 'the missing LoRA offers another version', 10000);
      eq(await text('#wfpModels [data-act=mm-swap]'), 'Use v3', 'the newest one you have');
      await click('#wfpModels [data-act=mm-swap]');
      await waitFor('document.querySelector("#wfpModels").hidden', 'nothing missing any more', 10000);
      eq((await flowOf()).tweaks['20'].name, 'krea2/baked_in_v3.safetensors', 'swapped');

      // The assistant swaps versions too.
      await click(lora('[data-key="20"] .lr-reset'));
      await waitFor(`!!document.querySelector('${lora('[data-key="20"] .lr-newer')}')`, 'back to the workflow\'s file');
      await click('#askBtn');
      await type('#asInput', 'use the newest baked_in');
      await press('Enter');
      await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
      const said = await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""');
      assert(said.includes('baked_in_v3 in place of baked_in'), `the assistant swaps it: ${said}`);
      eq((await flowOf()).tweaks['20'].name, 'krea2/baked_in_v3.safetensors', 'saved');
      await click('#asClear');
      await click('#asClear');
      await click('#asClose');

      // ↺ goes back to the workflow's own file; ✕ keeps it for good.
      await click(lora('[data-key="20"] .lr-reset'));
      await waitFor(`!!document.querySelector('${lora('[data-key="20"] .lr-newer')}')`, 'offered again');
      await click(lora('[data-key="20"] .lr-newer-skip'));
      assert(!(await js(`document.querySelector('${lora('[data-key="20"] .lr-newer')}')`)), 'not offered after ✕');
      await goto(`${APP}/#create`);
      await openPanel('create-render-adv');
      await waitFor(`document.querySelectorAll('${lora('.lora-row')}').length === 2`, 'reloaded');
      await sleep(500);
      assert(!(await js(`document.querySelector('${lora('[data-key="20"] .lr-newer')}')`)), 'still not offered after a reload');
    } finally {
      loras.splice(loras.indexOf('krea2/baked_in_v2.safetensors'), 3);
      await fs.rm(path.join(comfyRoot, 'models/loras/krea2/baked_in_v3.safetensors'), { force: true });
      await js(`fetch('/api/workflows/${id}', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loras: ${JSON.stringify({ tweaks: before.tweaks, added: before.added })} }) })`);
      await goto(`${APP}/#create`);
    }
  });

  await test('queue: line up Generates while one cooks; each keeps its setup; Stop, ✕, hold and carry on', async () => {
    const lora = sel => `#wfpLoras ${sel}`;
    const setGrain = async v => { await type(lora('[data-key="+0"] .lr-num'), v); await press('Enter'); };
    const comfyCount = async (n, label) => {
      for (const t = Date.now(); comfy.prompts.length < n;) {
        if (Date.now() - t > 15000) throw new Error(`Timed out waiting for ${label}`);
        await sleep(50);
      }
    };
    await openPanel('create-render');
    await openPanel('create-render-adv');
    await click('#varSeg button[data-value="1"]');
    if (!(await js('document.querySelector("#wfpAuto").checked'))) await click('#wfpAutoRow');
    assert(await js('document.querySelector("#wfpAuto").checked'), 'auto-render on');

    await setGrain('0.3');
    await type('#theme', 'SLOWTEST first in line');
    const before = comfy.prompts.length;
    await click('#generateBtn');
    await waitFor('document.querySelector("#generateBtn").disabled', 'cooking');
    assert(await visible('#queueBtn'), '＋ Queue shows while it cooks');
    assert(!(await visible('#lineBox')), 'nothing in line yet');

    // Queued with its own setup: a different LoRA strength and theme.
    await setGrain('0.9');
    await type('#theme', 'a queued harbor');
    await click('#queueBtn');
    await toastText('In line');
    eq(await count('#lineList li'), 1, 'one waiting');
    assert((await text('#lineList li')).includes('a queued harbor'), 'listed by its theme');
    assert((await text('#lineList li')).includes('Krea 2 RAW'), 'and what it is');

    // Ctrl+Enter queues too; pressing it twice on the same form queues it once.
    await type('#theme', 'FAILTEST queued');
    await press('Enter', { ctrl: true });
    await press('Enter', { ctrl: true });
    await waitFor('document.querySelectorAll("#lineList li").length === 2', 'the second in line');
    await sleep(300);
    eq(await count('#lineList li'), 2, 'a double press queues it once');
    await type('#theme', 'a queued lighthouse');
    await press('Enter', { ctrl: true });
    await waitFor('document.querySelectorAll("#lineList li").length === 3', 'the third in line');

    // ✕ takes one out; ↶ Undo puts it back where it was.
    await click('#lineList li:nth-child(2) .ln-del');
    eq(await count('#lineList li'), 2, 'taken out');
    await click('#toast .toast-act');
    await waitFor('document.querySelectorAll("#lineList li").length === 3', 'put back');
    assert((await text('#lineList li:nth-child(2)')).includes('FAILTEST'), 'in its old place');

    // Setting up the next one doesn't touch those waiting.
    await setGrain('0.1');
    await type('#theme', 'typed after queueing');
    await shot('queue');

    // ■ Stop stops only the one cooking; the line carries on.
    await click('#stopBtn');
    await toastText('3 more in line');
    await comfyCount(before + 1, 'the harbor render');
    let p = comfy.prompts.at(-1).prompt;
    assert(p['6'].inputs.text.includes('a queued harbor'), 'the queued theme was written and rendered');
    eq(p.pm_lora_1?.inputs.strength_model, 0.9, 'with the LoRA strength it was queued with, not today\'s');

    // A failure puts the line on hold, so the rest don't fail the same way.
    await waitFor('document.querySelector("#lineBox").classList.contains("held")', 'on hold after the failure', 15000);
    assert((await text('#lineHead')).includes('On hold'), 'says so');
    eq(await count('#lineList li'), 1, 'the last one still waiting');
    assert((await text('#stageError')).length > 0, 'the reason is on the stage');
    await click('#lineGo');
    await waitFor('document.querySelector("#lineBox").hidden', 'line empty', 15000);
    await genDone();
    await comfyCount(before + 2, 'the lighthouse render');
    p = comfy.prompts.at(-1).prompt;
    assert(p['6'].inputs.text.includes('a queued lighthouse'), 'the last one ran');
    eq(p.pm_lora_1?.inputs.strength_model, 0.9, 'also as it was queued');
    eq(await value('#theme'), 'typed after queueing', 'the form is as you left it');
    const themes = JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8')).slice(0, 2).map(e => e.theme).join('|');
    eq(themes, 'a queued lighthouse|a queued harbor', 'each its own History entry, in order');
    await waitFor('!document.querySelector(".take .rtile.running")', 'renders done', 10000);
    assert(!(await visible('#queueBtn')), '＋ Queue goes when nothing is cooking');

    await setGrain('-0.5');
    await click('#wfpAutoRow');
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

    // Paste a picture into the message box: it goes with the message, and the Brain sees it.
    await js(`(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#f0a'; g.fillRect(0, 0, 64, 64);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
      document.querySelector('#asInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await waitFor('document.querySelectorAll("#asAttach img").length === 1', 'the pasted picture shows above the box');
    assert(await js('document.querySelector("#dropzone .dz-preview").hidden'), 'and not in step 3');
    await type('#asInput', 'what do you think of this picture?');
    await press('Enter');
    await idle();
    assert(await js('!!document.querySelector("#asLog .as-msg.me .as-pics img")'), 'the picture is in your message');
    const sent = lastCall().messages.findLast(m => m.role === 'user' && Array.isArray(m.content));
    assert(sent && sent.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg')), 'the Brain got it, as a JPEG');
    assert(!(await visible('#asAttach')), 'the strip is empty again');
    eq(await count('#asLog .as-msg.bot'), await count('#asLog .as-msg.bot .as-copy'), 'every reply has a copy button');
    await js('[...document.querySelectorAll("#asLog .as-msg.bot .as-copy")].at(-1).click()');
    await waitFor('[...document.querySelectorAll("#asLog .as-msg.bot .as-copy")].at(-1).textContent.includes("Copied")', 'copied feedback');

    await type('#asInput', 'how do I add a LoRA?');
    await press('Enter');
    await idle();
    assert((await bot()).includes('Add LoRA'), 'answers from the guide');

    await type('#asInput', 'switch to the bogus model');
    await press('Enter');
    await idle();
    assert((await acts()).includes('There\'s no model called “nonexistent”'), 'a failing tool is shown, nothing breaks');
    assert((await bot()).includes('no model by that name'), 'and it tells you');

    await type('#asInput', 'switch to ltx then krea');
    await press('Enter');
    await idle();
    const amb = await acts();
    assert(amb.includes('could be Krea 2') && amb.includes('Krea 2 RAW i2i'), `a name that fits two models is an error, not a guess: ${amb}`);
    assert(amb.includes('Not run: set_model failed'), `the rest of that step is not run: ${amb}`);
    assert((await value('#theme')) !== 'after a failure', 'the theme was left alone');
    assert((await bot()).includes('which?'), 'and it asks');

    await type('#asInput', 'make three ltx videos');
    await press('Enter');
    await waitFor('!!document.querySelector("#asLog .as-confirm")', 'more than a couple of videos in one turn are asked on screen');
    assert((await text('#asLog .as-confirm')).includes('3 videos'), 'it says how many');
    await click('#asLog [data-confirm="no"]');
    await idle();
    assert((await acts()).includes('said no to 3'), 'the Brain is told you said no');
    assert((await bot()).includes('no videos'), 'and it stops there');
    assert(JSON.parse(await fs.readFile(path.join(dataDir, 'assistant.json'), 'utf8')).messages.some(m => m.role === 'tool' && m.content.includes('said no to 3')), 'the chat was saved as it went');

    await type('#asInput', 'tag fallback please');
    await press('Enter');
    await idle();
    eq(await value('#theme'), 'from a tag', 'tool calls written as text work too');

    await type('#asInput', 'broken template please');
    await press('Enter');
    await idle();
    eq(await value('#theme'), 'from the written tools', 'a Brain whose chat template breaks on tools gets them in writing');
    assert((await acts()).includes('Theme → “from the written tools”'), 'the step shows');
    const log = await text('#asLog');
    assert((await bot()).includes('long way round') && log.includes('On it.') && !log.includes('Done, it is set') && !log.includes('tool_call'), `only what it said before the call and after it ran shows: ${log.slice(-200)}`);
    const written = lastCall();
    assert(!written.tools && written.messages[0].content.includes('- set_theme:') && written.messages.every(m => m.role !== 'tool'), 'it was asked again with the tools described, calls and results as text');
    // That is remembered for this Brain: the next turn goes in writing straight away instead of failing first.
    const brainsFile = path.join(dataDir, 'brains.json');
    const noted = JSON.parse(await fs.readFile(brainsFile, 'utf8'));
    assert(Object.values(noted).some(b => b.toolsInWriting), 'the Brain is noted as one that takes its tools in writing');
    const callsBefore = mockCalls();
    await type('#asInput', 'broken template please');
    await press('Enter');
    await idle();
    assert(mock.log.slice(callsBefore).every(c => !c.tools), 'no request with tools was tried first this time');
    for (const b of Object.values(noted)) delete b.toolsInWriting; // (the tests after this one script a Brain that takes tools)
    await fs.writeFile(brainsFile, JSON.stringify(noted));

    // Written calls that come out a little off are still read; one cut off mid-way is left out, not shown as text.
    const { fallbackToolCalls, cleanMessages } = await import(path.join(ROOT, 'lib', 'assistant.js'));
    const read = t => fallbackToolCalls(t).toolCalls.map(c => `${c.name} ${c.arguments}`).join(' | ');
    eq(read('<tool_call>\n```json\n{"name":"generate","arguments":{}}\n```\n</tool_call>'), 'generate {}', 'in a code fence');
    eq(read('<tool_call>{"name":"set_theme","arguments":"{\\"text\\":\\"x\\"}"}</tool_call>'), 'set_theme {"text":"x"}', 'arguments written as a text');
    eq(read('<tool_call>[{"name":"set_model","arguments":{"name":"krea"}},{"name":"generate","arguments":{}}]</tool_call>'), 'set_model {"name":"krea"} | generate {}', 'several in one tag');
    eq(read('<|tool_call>call:set_theme{text:<|"|>a "quoted" cat\nwith: a colon<|"|>,takes:2}<tool_call|>'), 'set_theme {"text":"a \\"quoted\\" cat\\nwith: a colon","takes":2}', 'Gemma\'s own form, with quotes and a line break in the text');
    eq(read('<tool_call>{"name":"write_file","arguments":{"path":"~/a.txt","text":"use </tool_call> to end"}}</tool_call>'), 'write_file {"path":"~/a.txt","text":"use </tool_call> to end"}', 'a closing tag inside the text');
    eq(read('<tool_call>{"name":"list_folder","arguments":{"folder":"C:\\Users\\vince\\Pictures"}}</tool_call>'), 'list_folder {"folder":"C:\\\\Users\\\\vince\\\\Pictures"}', 'a Windows path with single backslashes');
    const cut = fallbackToolCalls('Let me do it.\n<tool_call>{"name":"set_theme","arguments":{"text":"a very long');
    assert(cut.cutOff && cut.text === 'Let me do it.' && !cut.toolCalls.length, 'cut off mid-call: only the words before it are kept');
    eq(fallbackToolCalls('To call a tool I write <tool_call> and then JSON.').toolCalls.length, 0, 'a mention of the tag in a sentence is not a call');
    // A long tool result keeps its end too.
    const long = `${'a'.repeat(20000)} THE-END`;
    const kept = cleanMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: long }]).at(-1).content;
    assert(kept.length < 8200 && kept.endsWith('THE-END') && kept.includes('characters left out here'), 'start and end kept, and it says what was left out');

    await type('#asInput', 'fewer steps please');
    await press('Enter');
    await idle();
    assert((await bot()).includes('Steps set to 12') && (await text('#wfpSettings')).includes('12 steps'), `sampler steps changed, and step 5 shows it: ${await text('#wfpSettings')}`);
    const flowId = await value('#wfpSelect');
    const tweaked = await (await fetch(`${APP}/api/workflows/${flowId}`)).json();
    const steps = Object.entries(tweaked.overrides).filter(([k]) => k.endsWith('|steps'));
    eq(JSON.stringify(steps.map(([, v]) => v)), '[12]', 'saved with the workflow');
    await fetch(`${APP}/api/workflows/${flowId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overridePatch: Object.fromEntries(steps.map(([k]) => [k, null])) }) });

    const topP = (await (await fetch(`${APP}/api/settings`)).json()).topP;
    await type('#asInput', 'use the screen to set top p to 0.77');
    await press('Enter');
    await idle();
    assert((await acts()).includes('Pressed “Save settings”') && (await bot()).includes('0.77'), `it found the box and the button on screen: ${await acts()}`);
    eq((await (await fetch(`${APP}/api/settings`)).json()).topP, 0.77, 'and the setting is saved');
    await fetch(`${APP}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topP }) });

    await goto(`${APP}/#create`);
    await waitFor('!document.querySelector("#assistant").hidden', 'left open, it opens again with the app');
    await waitFor('document.querySelectorAll("#asLog .as-msg.me").length === 13', 'the conversation is still there after a reload');
    await viewport(390, 844, true);
    await sleep(200);
    eq(await js('document.documentElement.scrollWidth - innerWidth'), 0, 'no sideways scroll on a phone');
    eq(await js('Math.round(document.querySelector("#assistant").getBoundingClientRect().width)'), 390, 'full width on a phone');
    await shot('44-assistant-phone');
    await viewport(1440, 900);
    await click('#asClear');
    await click('#asClear');

    // 💻 Using this computer: off until you switch it on; deleting asks first.
    const ask = async words => { await type('#asInput', words); await press('Enter'); await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000); };
    await ask('make it a noir look');
    eq(await js('document.querySelector("#lookRow .active")?.dataset.value'), 'noir', `the assistant sets the look: ${await bot()}`);
    await click('#lookRow button[data-value=""]');
    eq(await js('fetch("/api/computer/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\\"command\\":\\"echo hi\\"}" }).then(r => r.status)'), 403, 'commands are refused while it\'s off');
    await ask('run: echo hello-there');
    assert((await bot()).includes('Settings'), `it says where to allow it: ${await bot()}`);
    await click('.tabs button[data-view="settings"]');
    await js('document.querySelector("#sComputer").click()');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await ask('run: echo hello-there');
    assert((await bot()).includes('hello-there'), `it runs a command: ${await bot()}`);
    const victim = path.join(tmp, 'keep-me.txt');
    await fs.writeFile(victim, 'x');
    await type('#asInput', `run: rm ${victim}`);
    await press('Enter');
    await waitFor('!!document.querySelector("#asLog .as-confirm")', 'deleting asks on screen first');
    await click('#asLog [data-confirm="no"]');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    assert(await fs.access(victim).then(() => true, () => false), 'and nothing goes when you say no');
    // However the command is dressed up, and for what replaces a file too.
    for (const cmd of [`/bin/rm ${victim}`, `bash -c "rm ${victim}"`, `cp /etc/hostname ${victim}`, `mv ${victim} ${victim}.gone`, `echo gone > ${victim}`, `curl -X DELETE ${APP}/api/history/x`]) {
      await type('#asInput', `run: ${cmd}`);
      await press('Enter');
      await waitFor('!!document.querySelector("#asLog .as-confirm")', `asks first: ${cmd}`);
      await click('#asLog [data-confirm="no"]');
      await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    }
    eq(await fs.readFile(victim, 'utf8'), 'x', 'the file is as it was');
    await js('document.querySelector("#sComputer").click()');
    await click('#settingsForm button[type="submit"]');
    await toastText('Settings saved');
    await click('#asClear');
    await click('#asClear');
    await click('.tabs button[data-view="create"]');
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
    // It can't throw your edited playbook away by pressing ↺ Reset twice: the "Sure?" is yours to answer.
    await click('.tabs button[data-view="models"]');
    await click('#modelList button[data-id="krea2-raw"]');
    await waitFor('!document.querySelector("#resetModelBtn").hidden', 'the edited playbook can be reset');
    await type('#asInput', 'reset the playbook yourself');
    await press('Enter');
    await waitFor('!!document.querySelector("#asLog .as-confirm")', 'the second press asks you first');
    assert((await text('#asLog .as-confirm')).includes('Reset to built-in'), `it says which button: ${await text('#asLog .as-confirm')}`);
    await click('#asLog [data-confirm="no"]');
    await idle();
    assert((await bot()).includes('left your playbook alone'), `nothing was reset: ${await bot()}`);
    eq((await (await fetch(`${APP}/api/models/krea2-raw`)).json()).description, 'Edited by the assistant', 'your edit is still there');
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
    assert(await visible('#sComfyDirField'), 'the folder field shows even with cleanup off (deleting from History uses it too)');
    assert(/^Prompt Maker \d+\.\d+\.\d+/.test(await text('#sVersion')), 'Settings shows the version, for bug reports');
    await click('#sComfyCleanup');
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

  await test('delete: a render or a run leaves Your renders and the disk at once', async () => {
    const history = async () => (await fetch(`${APP}/api/history`)).json();
    await click('.tabs button[data-view="create"]');
    if (await visible('.dz-preview')) await click('#imageClear');
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a tin robot waving hello');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go'); // (auto-render may have started one already)
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 10000);
    if ((await count('.take .rtile img')) < 2) await click('.take .rb-go');
    await waitFor('document.querySelectorAll(".take .rtile img").length >= 2 && !document.querySelector(".take .rtile.running")', 'rendered twice', 10000);
    // A new run takes the stage; this one's renders stay in Your renders.
    const owner = (await history()).find(e => e.theme === 'a tin robot waving hello');
    const all = owner.variations.flatMap(v => v.renders || []);
    assert(all.length >= 2, `the run has renders to delete (${all.length})`);
    const files = all.map(r => r.files[0].file);
    const tiles = `[...document.querySelectorAll("#reel .rtile img")].filter(i => ${q(files)}.includes(decodeURIComponent(i.getAttribute("src").split("/").pop())))`;
    await type('#theme', 'a tin robot fast asleep');
    await click('#generateBtn');
    await genDone();
    await waitFor(`${tiles}.length === ${all.length}`, 'Your renders keeps the renders of the run that left the stage');
    await js('document.documentElement.dataset.ready = ""; location.reload()'); // not ready until the new page is
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded', 15000);
    await waitFor(`${tiles}.length === ${all.length}`, 'Your renders survives a reload');
    const originalOf = r => path.join(comfyRoot, 'output', `mock_${r.promptId.slice(0, 6)}.png`);

    await js(`${tiles}[0].closest(".rtile").classList.add("pick-me")`);
    await click('#reel .rtile.pick-me');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    await click('[data-lb="delete"]');
    await click('[data-lb="delete"]');
    await toastText('Render deleted', UNDO_WAIT);
    if (await visible('#lightbox')) await press('Escape');
    const left = (await history()).find(e => e.id === owner.id).variations.flatMap(v => v.renders || []);
    eq(left.length, all.length - 1, 'one render fewer');
    const gone = all.find(r => !left.some(x => x.id === r.id));
    eq(await js(`${tiles}.length`), all.length - 1, 'Your renders shows one fewer, right away');
    assert(!(await fileExists(path.join(dataDir, 'renders', gone.files[0].file))), 'the deleted one is gone from the data folder');
    if (gone.promptId) assert(!(await fileExists(originalOf(gone))) && !comfy.history[gone.promptId], 'and ComfyUI\'s file and job');

    await click('.tabs button[data-view="history"]');
    await waitFor(`!!document.querySelector('.hcard[data-id=${q(owner.id)}]')`, 'the card');
    const n = await js(`[...document.querySelectorAll(".hcard")].findIndex(c => c.dataset.id === ${q(owner.id)}) + 1`);
    await js('localStorage.setItem("pm.deleteWarned", "true")'); // the dialog is covered by the delete test
    await click(`.hcard:nth-of-type(${n}) [data-act="delete"]`);
    await click(`.hcard:nth-of-type(${n}) [data-act="delete"]`);
    await toastText('Deleted for good', UNDO_WAIT);
    await click('.tabs button[data-view="create"]');
    eq(await js(`${tiles}.length`), 0, 'Your renders lets go of the deleted run');
  });

  await test('delete: a History card leaves nothing behind, here or in ComfyUI', async () => {
    const history = async () => (await fetch(`${APP}/api/history`)).json();
    let byHand = null; // a job you queued yourself in ComfyUI: never Prompt Maker's to remove
    const comfyHas = text => Object.entries(comfy.history).some(([id, job]) => id !== byHand && JSON.stringify(job.prompt).includes(JSON.stringify(text).slice(1, -1)));
    const outputOf = n => path.join(comfyRoot, 'output', `mock_${comfy.prompts.at(n).id.slice(0, 6)}.png`);
    // A still, rendered (ComfyUI keeps its own file: cleanup is off), then animated: the video take uploads the still.
    await click('.tabs button[data-view="create"]');
    if (await visible('.dz-preview')) await click('#imageClear');
    await click('.model-card[data-id="krea2-raw"]');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a paper boat on a rainy puddle');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rcell .rt-next") && !document.querySelector(".take .rtile.running")', 'still rendered', 10000);
    const still = (await history()).find(e => e.theme === 'a paper boat on a rainy puddle');
    const stillText = still.variations[0].versions[0].text;
    const stillFile = still.variations[0].renders[0].files[0].file;
    const stillOriginal = outputOf(-1);
    assert(await fileExists(stillOriginal), 'ComfyUI has its own file of the still');
    await click('.take .rcell .rt-next');
    await waitFor('document.querySelector(".model-card.active")?.dataset.id === "ltx-2-3" && !document.querySelector(".dz-preview").hidden', 'still loaded as the first frame');
    await type('#theme', 'the paper boat drifts into the gutter');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'video rendered', 10000);
    const video = (await history()).find(e => e.theme === 'the paper boat drifts into the gutter');
    const videoText = video.variations[0].versions[0].text;
    const videoOriginal = outputOf(-1);
    const upload = path.join(comfyRoot, 'input', `prompt-maker_${stillFile}`);
    assert(await fileExists(upload), 'the still went to ComfyUI\'s input folder');
    assert(comfyHas(stillText) && comfyHas(videoText), 'ComfyUI\'s history has both jobs, prompts and all');
    eq((await fetch(`${APP}/renders/${stillFile}`)).headers.get('cache-control'), 'no-store', 'renders aren\'t kept in the browser\'s cache');
    // The assistant once quoted the still's prompt.
    await fs.writeFile(path.join(dataDir, 'assistant.json'), JSON.stringify({ messages: [{ role: 'user', content: `Make this moodier: ${stillText}` }, { role: 'assistant', content: 'Sure.' }] }));

    // You also rendered the still's prompt yourself, in ComfyUI's own editor.
    byHand = (await (await fetch(`http://127.0.0.1:${COMFY_PORT}/prompt`, { method: 'POST', body: JSON.stringify({ prompt: comfy.history[still.variations[0].renders[0].promptId].prompt[2], client_id: 'comfyui-editor' }) })).json()).prompt_id;
    for (let i = 0; i < 50 && !comfy.history[byHand]; i++) await sleep(100);
    const handOriginal = path.join(comfyRoot, 'output', `mock_${byHand.slice(0, 6)}.png`);
    assert(await fileExists(handOriginal), 'your own render of the same prompt is in ComfyUI\'s output folder');

    const deleteCard = async theme => {
      await click('.tabs button[data-view="history"]');
      await waitFor(`[...document.querySelectorAll(".hcard")].some(c => c.textContent.includes(${q(theme)}))`, 'the card');
      const n = await js(`[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes(${q(theme)})) + 1`);
      await js('localStorage.setItem("pm.deleteWarned", "true")'); // the dialog is covered by the delete test
      await click(`.hcard:nth-of-type(${n}) [data-act="delete"]`);
      await click(`.hcard:nth-of-type(${n}) [data-act="delete"]`);
      await waitFor(`![...document.querySelectorAll(".hcard")].some(c => c.textContent.includes(${q(theme)}))`, 'card gone', UNDO_WAIT);
    };

    await deleteCard('a paper boat on a rainy puddle');
    await toastText('Deleted for good');
    assert(!(await history()).some(e => e.id === still.id), 'the entry is gone');
    assert(!(await fileExists(path.join(dataDir, 'renders', stillFile))), 'its render is gone from the data folder');
    assert(!(await fileExists(stillOriginal)), 'and ComfyUI\'s own file of it');
    assert(!(await fileExists(upload)), 'and the copy uploaded to ComfyUI\'s input folder');
    assert(!comfyHas(stillText), 'and its job in ComfyUI\'s history');
    assert(comfy.history[byHand] && await fileExists(handOriginal), 'the render you made yourself in ComfyUI, same prompt, is not touched');
    assert(!(await fs.readFile(path.join(dataDir, 'assistant.json'), 'utf8')).includes(stillText.slice(0, 60)), 'the assistant conversation no longer quotes it');
    const kept = (await history()).find(e => e.id === video.id);
    assert(kept && !kept.source, 'the video made from it stays, without its prompt or a link back');
    assert(await fileExists(path.join(dataDir, 'images', kept.imageFile)), 'the video keeps its own first frame');
    assert(await fileExists(videoOriginal) && comfyHas(videoText), 'the video\'s files and job aren\'t touched');
    assert(!JSON.stringify(await history()).includes(stillText), 'the still\'s prompt is nowhere in History');

    // The form still holds the video's theme and image: they go with it. (Every mock render is the same picture, so
    // an earlier animation has this very first frame: a file another entry uses stays.)
    await deleteCard('the paper boat drifts into the gutter');
    assert((await history()).some(e => e.imageFile === video.imageFile), 'another entry has the same first frame');
    assert(await fileExists(path.join(dataDir, 'images', video.imageFile)), 'so that file stays');
    assert(!(await fileExists(path.join(dataDir, 'renders', video.variations[0].renders[0].files[0].file))), 'its render is gone');
    assert(!(await fileExists(videoOriginal)) && !comfyHas(videoText), 'and ComfyUI\'s file and job');
    await click('.tabs button[data-view="create"]');
    eq(await value('#theme'), '', 'the Create form lets go of its theme');
    assert(!(await visible('.dz-preview')), 'and its image');
    await js('document.documentElement.dataset.ready = ""; location.reload()'); // not ready until the new page is
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded', 15000);
    eq(await value('#theme'), '', 'still empty after a reload');
    assert(!(await visible('.dz-preview')), 'no image after a reload');

    // An image of your own, used once, goes with its entry.
    const mine = path.join(tmp, 'only-once.png');
    await fs.writeFile(mine, makePng(300, 200));
    await setFiles('#imageInput', [mine]);
    await waitFor('!document.querySelector(".dz-preview").hidden', 'image added');
    await type('#theme', 'a kite over the salt flats');
    await click('#generateBtn');
    await genDone();
    const kite = (await history()).find(e => e.theme === 'a kite over the salt flats');
    assert(kite.imageFile && (await fileExists(path.join(dataDir, 'images', kite.imageFile))), 'the image is stored');
    await deleteCard('a kite over the salt flats');
    assert(!(await fileExists(path.join(dataDir, 'images', kite.imageFile))), 'its input image is gone');
    await click('.tabs button[data-view="create"]');
    assert(!(await visible('.dz-preview')) && (await value('#theme')) === '', 'and the form let go of both');
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
    // Bigger thumbnails, remembered; 🔍 opens one full screen, and it can be used from there.
    const tileW = () => js('Math.round(document.querySelector("#imgPickGrid .ip-tile").getBoundingClientRect().width)');
    const small = await tileW();
    await js('{ const r = document.querySelector("#imgPickSize"); r.value = 400; r.dispatchEvent(new Event("input")); }');
    assert((await tileW()) > small * 1.8, 'the slider makes the thumbnails bigger');
    eq(await js('localStorage.getItem("imgPickSize")'), '400', 'and the size is remembered');
    await click('#imgPickGrid .ip-zoom');
    await waitFor('document.querySelector("#imgView").open && document.querySelector("#ivImg").naturalWidth > 0 && !document.querySelector("#ivUse").hidden', 'a closer look, with Use this image');
    await click('#ivImg');
    assert(await js('document.querySelector("#ivStage").classList.contains("actual")'), 'a click shows it at actual size');
    await click('#ivClose');
    assert(await js('document.querySelector("#imgPick").open && !document.querySelector("#imgView").open'), 'closing the viewer goes back to the picker');
    await js('{ const r = document.querySelector("#imgPickSize"); r.value = 140; r.dispatchEvent(new Event("input")); }');
    await click('#imgPickGrid .ip-tile');
    await waitFor('!document.querySelector(".dz-preview").hidden && !document.querySelector("#dzSource").hidden', 'attached, linked to its render');
    await toastText('Image added');
    assert(!(await js('document.querySelector("#imgPick").open')), 'the picker closed');
    assert((await text('#dzSource')).startsWith('🔗 From '), 'it says where it came from');
    assert(await visible('#imageGallery'), 'and another can be picked from the Gallery');
    await click('#imageZoom');
    await waitFor('document.querySelector("#imgView").open && document.querySelector("#ivUse").hidden', 'step 3\'s image opens full screen');
    await press('Escape');
    await waitFor('!document.querySelector("#imgView").open', 'Esc closes it');
    await click('#imageClear');
  });

  await test('Wan Animate 2: a character performs a motion video; ComfyUI\'s template is fixed and the prompt split', async () => {
    const history = async () => (await fetch(`${APP}/api/history`)).json();
    const textOf = c => (typeof c === 'string' ? c : c.filter(p => p.type === 'text').map(p => p.text).join('\n'));
    await click('.tabs button[data-view="create"]');
    if (await visible('.dz-preview')) await click('#imageClear');
    await click('.model-card[data-id="wan-animate-2"]');
    await waitFor('!document.querySelector("#motionBlock").hidden && !document.querySelector("#charLabel").hidden', 'step 3 asks for a character and a motion video');
    eq(await text('#imageStepTitle'), 'Character & motion', 'step 3 is about both');
    assert((await js('document.querySelector("#theme").placeholder')).startsWith('Where are they'), 'the theme says where and from what angle');

    // ComfyUI's own template, offered first: read from ComfyUI, its empty pose window fixed, everything mapped.
    await click((await visible('#wfpAddFirst')) ? '#wfpAddFirst' : '#wfpAdd');
    await waitFor('!document.querySelector("#wfTemplates").hidden && document.querySelectorAll("#wfTplList button").length === 2', 'ComfyUI\'s templates for the model come first');
    await click('#wfTplList button[data-template="video_wan_animate2"]');
    await waitFor('!document.querySelector("#wfSetup").hidden', 'the setup');
    assert((await text('#wfWarnings')).includes('pose window ended where it started'), 'the template\'s empty pose window is fixed, and it says so');
    eq(await value('#mapMotion'), '10:103|text', 'the Motion line goes to the pose prompt');
    eq(await value('#mapVideo'), '2|file', 'the motion video goes to Load Video');
    eq(await js('[...document.querySelectorAll("#mapPrompt select")].map(s => s.value).join()'), '10:102|text', 'the rest to the prompt');
    eq(await value('#samplerCtl .sp-field[data-kind="poseEnd"] input'), '1', 'pose end is 1 now');
    assert(await visible('#samplerCtl .sp-field[data-kind="pose"]') && await visible('#samplerCtl .sp-field[data-kind="identity"]'), 'pose and character strength can be tuned');
    await shot('46-wan-template-setup');
    await click('#wfSave');
    await toastText('is ready');

    // Render without a motion video: a clear message, no ComfyUI job.
    await setFiles('#imageInput', [portrait]);
    await waitFor('!document.querySelector(".dz-preview").hidden && document.querySelector("#roleBlock").hidden', 'the character is in (one way to use it: no role to pick)');
    assert((await text('#roleHint')).includes('performs the motion video'), 'the hint says what happens');
    assert((await text('#wfpWarn')).includes('needs a motion video'), 'step 5 says the workflow needs a motion video');

    // A motion video recorded in the browser: a WebM with no duration in its header, like many recorders make.
    await js(`(async () => {
      const c = document.createElement('canvas'); c.width = 180; c.height = 320; c.style.cssText = 'position:fixed;left:-999px'; document.body.append(c); // frames are only recorded from a canvas on the page
      const ctx = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
      const chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.start();
      for (let i = 0; i < 20; i++) { ctx.fillStyle = 'hsl(' + i * 18 + ' 80% 50%)'; ctx.fillRect(0, 0, 180, 320); ctx.fillStyle = '#fff'; ctx.fillRect(20 + i * 6, 100, 40, 120); await new Promise(r => setTimeout(r, 70)); }
      rec.stop();
      await new Promise(r => { rec.onstop = r; });
      c.remove();
      const dt = new DataTransfer();
      dt.items.add(new File(chunks, 'dance.webm', { type: 'video/webm' }));
      const input = document.querySelector('#videoInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor('document.querySelector("#mzInfo").textContent.startsWith("🕺")', 'the motion video is stored', 15000);
    await toastText('Motion video added');
    eq(await value('#aspect'), '4:7', 'the clip takes the character\'s shape, as in Wan-AI\'s own code (the video is cropped to it)');
    assert(!(await text('#motionHint')).includes('📐'), 'the shapes are close: nothing to warn about');
    assert(!(await visible('#wfpWarn')), 'nothing missing anymore');
    await shot('47-wan-step3');

    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'on a rooftop at dusk');
    await click('#generateBtn');
    await genDone();
    const ask = mock.log.at(-1).messages.find(m => m.role === 'user');
    eq(ask.content.filter(p => p.type === 'image_url').length, 2, 'the Brain sees the character and a contact sheet of the motion');
    assert(textOf(ask.content).includes('MOTION VIDEO') && textOf(ask.content).includes('role = "character"'), 'and is told which is which');
    const entry = (await history()).find(e => e.theme === 'on a rooftop at dusk');
    assert(entry.video?.file?.endsWith('.webm') && entry.video.sheet && entry.video.seconds > 0.5, 'the take keeps its motion video, its frames and its length');
    eq(entry.imageRole, 'character', 'and the image is the character');
    assert(await fileExists(path.join(dataDir, 'videos', entry.video.file)), 'the video is in the data folder');

    const before = comfy.prompts.length;
    await click('.take .rb-go');
    for (let i = 0; i < 100 && comfy.prompts.length === before; i++) await sleep(50);
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 10000);
    const sent = comfy.prompts.at(-1).prompt;
    const main = sent['10:102'].inputs.text;
    assert(main.startsWith('Character appearance description:') && main.includes('Background description:') && !/Motion:/.test(main), 'the look and setting go to the prompt');
    assert(sent['10:103'].inputs.text.startsWith('A woman doing'), 'the Motion line goes to the pose prompt');
    eq(sent['2'].inputs.file, `prompt-maker_${entry.video.file}`, 'the motion video goes to ComfyUI');
    assert(comfy.uploads.includes(`prompt-maker_${entry.video.file}`) && await fileExists(path.join(comfyRoot, 'input', `prompt-maker_${entry.video.file}`)), 'uploaded to its input folder');
    eq(sent['10:106'].inputs.pose_end_percent, 1, 'the pose window is fixed in what is sent');
    eq(`${sent['10:106'].inputs.width}×${sent['10:106'].inputs.height}`, '480×848', '480p in the character\'s shape');
    await click('.take .rtile img');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    assert(await visible('[data-lb="character"]'), 'a still can become a character for Wan Animate 2');
    await press('Escape');

    // New clears the motion video too, and History puts it back.
    await click('#newBtn');
    await waitFor('document.querySelector("#motionBlock .mz-preview").hidden', 'cleared');
    await click('.tabs button[data-view="history"]');
    await waitFor('[...document.querySelectorAll(".hcard")].some(c => c.textContent.includes("on a rooftop at dusk"))', 'the card');
    const n = await js('[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("on a rooftop at dusk")) + 1');
    await click(`.hcard:nth-of-type(${n}) button.open`);
    await waitFor('document.querySelector(".model-card.active")?.dataset.id === "wan-animate-2" && document.querySelector("#mzInfo").textContent.startsWith("🕺")', 'the motion video is back with the card');

    // Deleting the card takes the video with it, here and in ComfyUI.
    await click('.tabs button[data-view="history"]');
    await js('localStorage.setItem("pm.deleteWarned", "true")'); // the dialog is covered by the delete test
    await click(`.hcard:nth-of-type(${n}) [data-act="delete"]`);
    await click(`.hcard:nth-of-type(${n}) [data-act="delete"]`);
    await waitFor('![...document.querySelectorAll(".hcard")].some(c => c.textContent.includes("on a rooftop at dusk"))', 'card gone', UNDO_WAIT);
    await toastText('Deleted for good');
    assert(!(await fileExists(path.join(dataDir, 'videos', entry.video.file))), 'the motion video is gone from the data folder');
    assert(!(await fileExists(path.join(comfyRoot, 'input', `prompt-maker_${entry.video.file}`))), 'and from ComfyUI\'s input folder');
    assert(!(await fileExists(path.join(dataDir, 'images', entry.video.sheet))), 'and its frames');
    await click('.tabs button[data-view="create"]');
    if (await visible('#videoClear')) await click('#videoClear');
    if (await visible('.dz-preview')) await click('#imageClear');
    await click('.model-card[data-id="krea2-raw"]');
    assert(await js('document.querySelector("#motionBlock").hidden'), 'other models don\'t ask for a motion video');
  });

  await test('workflows: a video made in pieces gets the same prompt and size in each; extra saves are left out; a model in a subfolder is found', async () => {
    // Two copies of one part (a long video in pieces), each with its own prompt and size inputs, joined by a Batch node.
    const piece = n => ({
      [`${n}:1`]: { class_type: 'CLIPTextEncode', inputs: { text: 'a dancer', clip: ['9', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
      [`${n}:2`]: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['9', 1] }, _meta: { title: 'CLIP Text Encode (Negative Prompt)' } },
      [`${n}:3`]: { class_type: 'PrimitiveInt', inputs: { value: 896 }, _meta: { title: 'Int (Width)' } },
      [`${n}:4`]: { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'Int (Height)' } },
      [`${n}:5`]: { class_type: 'WanAnimate2ToVideo', inputs: { positive: [`${n}:1`, 0], negative: [`${n}:2`, 0], reference_image: ['7', 0], pose_video: ['8', 0], width: [`${n}:3`, 0], height: [`${n}:4`, 0] } },
      [`${n}:6`]: { class_type: 'KSampler', inputs: { seed: 1, positive: [`${n}:5`, 0], negative: [`${n}:5`, 1], model: [`${n}:7`, 0] } },
      [`${n}:7`]: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'speed.safetensors', strength_model: 0.8, model: ['9', 0] }, _meta: { title: 'Load LoRA' } },
    });
    const prompt = {
      ...piece(10), ...piece(20),
      7: { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      8: { class_type: 'LoadVideo', inputs: { file: 'y.mp4' } },
      9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1.safetensors' } },
      30: { class_type: 'CreateVideo', inputs: { images: ['10:6', 0] } },
      31: { class_type: 'SaveVideo', inputs: { video: ['30', 0] }, _meta: { title: 'Save Video (First piece)' } },
      32: { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['10:6', 0], 'images.image1': ['20:6', 0] } },
      33: { class_type: 'CreateVideo', inputs: { images: ['32', 0] } },
      34: { class_type: 'SaveVideo', inputs: { video: ['33', 0] }, _meta: { title: 'Save Video (Final)' } },
      40: { class_type: 'ImageStitch', inputs: { image1: ['32', 0], image2: ['8', 0] } },
      41: { class_type: 'SaveVideo', inputs: { video: ['40', 0] }, _meta: { title: 'Side by side' } },
    };
    // The second piece carries on from the first (SCAIL 2's "Extend"): 81 frames each, 5 repeated, its number in a primitive.
    for (const n of [10, 20]) prompt[`${n}:5`].inputs.length = 81;
    Object.assign(prompt['20:5'].inputs, { previous_frames: ['10:6', 0], previous_frame_count: 5, pose_video: ['20:9', 0] });
    prompt['20:8'] = { class_type: 'PrimitiveInt', inputs: { value: 2 }, _meta: { title: 'Int' } };
    prompt['20:9'] = { class_type: 'ImageFromBatch', inputs: { image: ['8', 0], batch_index: ['20:8', 0], length: 81 } };
    const notes = wfLib.repair(prompt);
    assert(!prompt['41'] && !prompt['31'] && prompt['34'], `only the full render is saved (${Object.keys(prompt).filter(k => /^3|^4/.test(k)).join()})`);
    eq(notes.length, 2, 'and both are said');
    const { mapping, warnings } = wfLib.analyze(prompt);
    eq(mapping.prompt.length, 1, 'one prompt slot');
    assert(warnings.some(w => w.includes('renders in 2 pieces')), 'the setup says it renders in pieces');
    const w = { prompt, mapping: { ...mapping, width: { node: '10:3', input: 'value' }, height: { node: '10:4', input: 'value' } }, options: { snap: 16, fps: 24, frameRule: 'exact' }, overrides: {}, loras: {} };
    const built = wfLib.buildPrompt(w, { text: 'a robot', imageName: 'c.png', aspectRatio: '16:9', resolution: '480p', seed: 3 }).prompt;
    eq(`${built['10:1'].inputs.text}|${built['20:1'].inputs.text}`, 'a robot|a robot', 'every piece gets the prompt');
    eq(`${built['20:3'].inputs.value}×${built['20:4'].inputs.value}`, '848×480', 'and the size');
    eq(built['20:2'].inputs.text, 'blurry', 'never the negative');
    // A longer video gets more pieces like the last, each carrying on from the one before, all joined.
    eq(wfLib.clipFrames(prompt), 'all', 'it covers any length');
    const long = wfLib.buildPrompt(w, { text: 'a robot', videoFrames: 400 });
    eq(long.applied.pieces, 6, '81 + 5 × 76 frames cover 400');
    eq(JSON.stringify(long.prompt['pm2:5'].inputs.previous_frames), '["pm1:6",0]', 'a new piece carries on from the one before');
    eq(long.prompt['pm3:8'].inputs.value, 5, 'and knows which piece it is');
    eq(JSON.stringify(long.prompt['pm3:5'].inputs.positive), '["20:1",0]', 'with the same prompt (shared, not copied)');
    eq(JSON.stringify(long.prompt['32'].inputs['images.image5']), '["pm4:6",0]', 'all joined into one video');
    assert(!long.prompt['pm1:7'], 'the LoRA stays shared, not copied');
    eq(wfLib.buildPrompt(w, { text: 'a robot', videoFrames: 120 }).applied.pieces, 2, 'a short video keeps its two');
    // With ffmpeg, each piece is saved on its own and Prompt Maker joins them: ComfyUI never holds the whole video twice.
    prompt['33'].inputs.audio = ['8', 1];
    const split = wfLib.buildPrompt(w, { text: 'a robot', videoFrames: 400, joinInApp: true });
    assert(!split.prompt['32'] && !split.prompt['33'] && !split.prompt['34'], 'no Batch node gluing the pieces in ComfyUI');
    eq(split.parts.saves.join(), 'pmsave001,pmsave002,pmsave003,pmsave004,pmsave005,pmsave006', 'a Save Video per piece, in order');
    eq(['pmvideo001', 'pmvideo002', 'pmvideo006'].map(id => split.prompt[id].inputs.images[0]).join(), '10:6,20:6,pm4:6', 'each makes a video of its own piece');
    assert(!('audio' in split.prompt.pmvideo002.inputs) && split.parts.audio, 'the sound is left for the joined video');
    eq(split.prompt.pmsave003.inputs.filename_prefix, 'video/ComfyUI_piece003', 'each piece has its own file name');
    eq(JSON.stringify(split.prompt.pmsave003.inputs.video), '["pmvideo003",0]', 'and saves its own video');
    assert(!wfLib.buildPrompt(w, { text: 'a robot', videoFrames: 400 }).parts, 'without ffmpeg, ComfyUI joins them as before');
    delete prompt['33'].inputs.audio;
    // Each piece loads the same LoRA: one row, and a change reaches every piece.
    const { leads } = wfLib.loraGroups(prompt);
    eq(leads.map(l => `${l.key}×${l.pieces}`).join(), '10:7×2', 'the LoRA shows once, for both pieces');
    const tuned = wfLib.buildPrompt({ ...w, loras: { tweaks: { '10:7': { on: true, strength: 0.5 } }, added: [] } }, { text: 'a robot' });
    eq(`${tuned.prompt['10:7'].inputs.strength_model}|${tuned.prompt['20:7'].inputs.strength_model}`, '0.5|0.5', 'its strength goes to both');
    eq(tuned.applied.loras.length, 1, 'and the render lists it once');
    const off = wfLib.buildPrompt({ ...w, loras: { tweaks: { '10:7': { on: false, strength: 0.8 } }, added: [] } }, { text: 'a robot' }).prompt;
    assert(!off['10:7'] && !off['20:7'], 'switched off, it leaves both pieces');
    const zero = wfLib.buildPrompt({ ...w, loras: { tweaks: { '10:7': { on: true, strength: 0 } }, added: [{ name: 'detail.safetensors', strength: 0, on: true }] } }, { text: 'a robot' });
    eq(`${zero.prompt['10:7']?.inputs.strength_model}|${zero.prompt['20:7']?.inputs.strength_model}`, '0|0', 'left on at 0, it still goes in at 0: some LoRAs change the render even there');
    assert(Object.values(zero.prompt).some(n => n.inputs?.lora_name === 'detail.safetensors' && n.inputs.strength_model === 0), 'so does an added one');
    eq(zero.applied.loras.length, 2, 'and the render lists both');
    const info = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['other.safetensors', 'wan-2.1/sam3.1.safetensors']] } } }, CLIPVisionLoader: { input: { required: { clip_name: [[]] } } } };
    built[11] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'clip_vision_h.safetensors' }, _meta: { title: 'Load CLIP Vision' } };
    const check = modelsLib.checkModels(built, info, [{ name: 'clip_vision_h.safetensors', url: 'https://huggingface.co/x/clip_vision_h.safetensors', directory: 'clip_vision' }]);
    eq(JSON.stringify(check.fixes.map(f => f.to)), '["wan-2.1/sam3.1.safetensors"]', 'a model kept in a subfolder is found there');
    eq(check.missing.map(m => `${m.file}→${m.folder}`).join(), 'clip_vision_h.safetensors→clip_vision', 'a missing one is named, with where it goes');
    assert(check.missing[0].url.startsWith('https://huggingface.co/') && check.missing[0].download, 'and its download link, one Prompt Maker may use');
    assert(!modelsLib.checkModels(built, info, [{ name: 'clip_vision_h.safetensors', url: 'https://example.com/clip_vision_h.safetensors', directory: 'clip_vision' }]).missing[0].download, 'a link elsewhere is shown, not downloaded');
  });

  await test('a long video\'s pieces are joined into one, with the motion video\'s sound', async () => {
    if (!(await videotools.hasFfmpeg())) return console.log('    (skipped: no ffmpeg)');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-join-'));
    const ff = args => new Promise((resolve, reject) => spawn('ffmpeg', ['-y', '-v', 'error', ...args]).on('close', c => (c ? reject(new Error(`ffmpeg ${c}`)) : resolve())));
    const pieces = [];
    for (const [k, frames] of [24, 20, 10].entries()) {
      const file = path.join(dir, `p${k}.mp4`);
      await ff(['-f', 'lavfi', '-i', `testsrc=size=320x176:rate=24`, '-frames:v', String(frames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
      pieces.push(file);
    }
    const sound = path.join(dir, 'motion.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc=size=320x176:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sound]);
    const out = path.join(dir, 'joined.mp4');
    await videotools.join(pieces, out, { audioFrom: sound });
    const count = await new Promise(resolve => { let o = ''; spawn('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]).stdout.on('data', d => { o += d; }).on('close', () => resolve(Number(o.trim()))); });
    eq(count, 54, 'every frame of every piece, in one video');
    const streams = await new Promise(resolve => { let o = ''; spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', out]).stdout.on('data', d => { o += d; }).on('close', () => resolve(JSON.parse(o))); });
    assert(streams.streams.some(st => st.codec_type === 'audio'), 'with the motion video\'s sound');
    assert(Number(streams.format.duration) < 2.6, `cut to the video's 2.25 s, not the sound's 6 (${streams.format.duration})`);
    const silent = path.join(dir, 'silent.mp4');
    await videotools.join(pieces, silent, { audioFrom: pieces[0] }); // a motion video without sound
    const quiet = await videotools.probe(silent);
    assert(quiet && quiet.width === 320, 'a motion video without sound still gives the joined video');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('character animation: SCAIL 2 keeps the picture\'s background or the video\'s, as picked', async () => {
    // A character-replacement workflow: replacement_mode from one boolean per piece, wired to its mask and its sampler.
    const prompt = {
      7: { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      8: { class_type: 'LoadVideo', inputs: { file: 'y.mp4' } },
    };
    for (const n of [10, 20]) Object.assign(prompt, {
      [`${n}:1`]: { class_type: 'CLIPTextEncode', inputs: { text: 'a dancer' } },
      [`${n}:2`]: { class_type: 'PrimitiveBoolean', inputs: { value: true } },
      [`${n}:3`]: { class_type: 'SCAIL2ColoredMask', inputs: { sort_by: 'left_to_right', replacement_mode: [`${n}:2`, 0] } },
      [`${n}:4`]: { class_type: 'WanSCAILToVideo', inputs: { positive: [`${n}:1`, 0], reference_image: ['7', 0], pose_video: ['8', 0], pose_video_mask: [`${n}:3`, 0], replacement_mode: [`${n}:2`, 0] } },
    });
    const w = { id: 'w', prompt, mapping: { prompt: [{ node: '10:1', input: 'text' }], seed: [] }, options: { snap: 16, fps: 24, frameRule: 'exact' }, overrides: {}, loras: {} };
    const bg = wfLib.summary(w).background;
    eq(`${bg.value}|${bg.original}|${bg.keys.join()}`, 'video|video|10:2|value,20:2|value', 'it keeps the video\'s, as the workflow has it, set in each piece');
    const picked = { ...w, overrides: { '10:2|value': false, '20:2|value': false } };
    eq(wfLib.summary(picked).background.value, 'picture', 'picking the picture shows');
    const sent = wfLib.buildPrompt(picked, { text: 'a robot' }).prompt;
    eq(`${sent['10:2'].inputs.value}|${sent['20:2'].inputs.value}`, 'false|false', 'and every piece animates the picture');
    eq(wfLib.summary({ ...w, prompt: { 1: { class_type: 'WanAnimate2ToVideo', inputs: { reference_image: ['7', 0], pose_video: ['8', 0] } } } }).background, null, 'Wan Animate 2 has no such choice');
    // Written on the node itself, without a primitive.
    const direct = { 1: { class_type: 'WanSCAILToVideo', inputs: { replacement_mode: false } } };
    eq(wfLib.summary({ ...w, prompt: direct }).background.keys.join(), '1|replacement_mode', 'a switch on the node itself is found too');
  });

  await test('models: a workflow needing a model ComfyUI lacks: step 5 says so, ⬇ Download puts it in ComfyUI, then it renders', async () => {
    await click('.tabs button[data-view="create"]');
    if (await visible('.dz-preview')) await click('#imageClear');
    await click('.model-card[data-id="krea2-raw"]');
    await click((await visible('#wfpAddFirst')) ? '#wfpAddFirst' : '#wfpAdd');
    await waitFor('document.querySelector("#wfDialog").open', 'dialog open');
    await click('.wf-tabs button[data-value="upload"]');
    await setFiles('#wfFile', [bigModelWorkflowFile]);
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    const setup = await text('#wfWarnings');
    assert(setup.includes('doesn\'t have a model') && setup.includes('big_model.safetensors'), `the setup says which model is missing: ${setup}`);
    await type('#wfName', 'Needs a big model');
    await click('#wfSave');
    await toastText('is ready');
    await waitFor('!document.querySelector("#wfpModels").hidden', 'step 5 says a model is missing');
    const notice = await text('#wfpModels');
    assert(notice.includes('big_model.safetensors') && notice.includes('models/checkpoints'), `which, and where it goes: ${notice}`);
    await shot('48-missing-model');

    // Rendering before it's there: a clear message, nothing sent to ComfyUI.
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'a quiet harbor at dawn');
    await click('#generateBtn');
    await genDone();
    const before = comfy.prompts.length;
    await click('.take .rb-go');
    await waitFor('(document.querySelector("#stageError")?.textContent || "").includes("doesn\'t have a model")', 'the render says what is missing');
    eq(comfy.prompts.length, before, 'nothing was sent to ComfyUI');
    await click('#stageError .x');

    await click('#wfpModels [data-act="mm-get"]');
    await toastText('is in ComfyUI now');
    await waitFor('document.querySelector("#wfpModels").hidden', 'once it\'s there, the notice goes', 10000);
    const got = path.join(comfyRoot, 'models', 'checkpoints', 'big_model.safetensors');
    eq((await fs.stat(got)).size, MODEL_BYTES.length, 'the whole file is in ComfyUI\'s checkpoints folder');
    assert(!(await fileExists(`${got}.part`)), 'and nothing half-done next to it');
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 10000);
    eq(comfy.prompts.at(-1).prompt['4'].inputs.ckpt_name, 'big_model.safetensors', 'with that model');
    const refused = await js(`fetch("/api/comfy/downloads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x.safetensors", folder: "checkpoints", url: "https://example.com/x.safetensors" }) }).then(async r => [r.status, (await r.json()).error])`);
    assert(refused[0] === 400 && refused[1].includes('only downloads models from Hugging Face'), `other sites are refused: ${refused[1]}`);
  });

  await test('render: ComfyUI skipping part of a workflow stops the render, with its reasons', async () => {
    await type('#theme', 'SKIPOUT a red kite over the dunes');
    await click('#generateBtn');
    await genDone();
    await click('.take .rb-go');
    await waitFor('(document.querySelector("#stageError")?.textContent || "").includes("would skip part of this workflow")', 'the render stops with ComfyUI\'s reasons');
    const msg = await text('#stageError');
    assert(msg.includes('#9 SaveImage') && msg.includes("'gone.safetensors' isn't in ComfyUI") && !msg.includes('mock_model'), `in short: ${msg}`);
    await sleep(600);
    eq(await count('.take .rtile img'), 0, 'and no half render is kept');
    await click('#stageError .x');
  });

  await test('gallery: a render moved out of the renders folder leaves every view, and comes back with its file', async () => {
    const all = await (await fetch(`${APP}/api/history`)).json();
    const entry = all.find(e => e.variations.some(v => v.renders?.length));
    const render = entry.variations.flatMap(v => v.renders || []).at(-1);
    const file = render.files[0].file;
    const away = path.join(tmp, `moved-${file}`);
    await fs.rename(path.join(dataDir, 'renders', file), away);
    // A video whose file is gone too: its tile only loads the file when hovered, so it would stay a blank box.
    const histFile = path.join(dataDir, 'history.json');
    const raw = JSON.parse(await fs.readFile(histFile, 'utf8'));
    raw.unshift({ id: 'moved-video', createdAt: new Date().toISOString(), favorite: false, modelId: 'ltx-2-3', modelName: 'LTX 2.3', modelKind: 'video', theme: 'a moved video', variations: [{ versions: [{ text: 'a moved video', createdAt: new Date().toISOString() }], renders: [{ id: 'moved-r', versionIndex: 0, text: 'a moved video', workflowName: 'Mock', files: [{ file: 'moved-video_0.mp4', kind: 'video', name: 'moved.mp4' }], createdAt: new Date().toISOString() }] }] });
    await fs.writeFile(histFile, JSON.stringify(raw));
    const shown = await (await fetch(`${APP}/api/history`)).json();
    const files = shown.flatMap(e => e.variations.flatMap(v => (v.renders || []).flatMap(r => r.files.map(f => f.file))));
    assert(!files.includes(file) && !files.includes('moved-video_0.mp4'), 'the page isn\'t sent renders whose file is gone');
    assert(shown.find(e => e.id === 'moved-video').variations[0].versions.length === 1, 'their takes stay');
    await click('.tabs button[data-view="gallery"]');
    await waitFor('document.querySelectorAll("#reelGrid .reel-cell").length > 0', 'gallery');
    eq(await count(`#reelGrid [src*="${file}"], #reelGrid [src*="moved-video_0"]`), 0, 'no tile for them, not even a blank one');
    eq(await text('#galleryCount'), String(await count('#reelGrid .reel-cell')), 'and the count agrees');
    await click('.tabs button[data-view="history"]');
    await waitFor('document.querySelectorAll(".hcard").length > 0', 'history');
    eq(await count(`.hcard [src*="${file}"], .hcard [src*="moved-video_0"]`), 0, 'no History card shows them');
    // Put back, it shows again.
    await fs.rename(away, path.join(dataDir, 'renders', file));
    await fs.writeFile(histFile, JSON.stringify(raw.slice(1)));
    await click('.tabs button[data-view="gallery"]');
    await waitFor(`!!document.querySelector('#reelGrid [src*="${file}"]')`, 'back in the Gallery with its file');
    // Gone while it's on screen: the tile leaves too.
    await fs.rename(path.join(dataDir, 'renders', file), away);
    await js(`(() => { const el = document.querySelector('#reelGrid [src*="${file}"]'); el.src = el.src + '?again'; })()`);
    await waitFor(`!document.querySelector('#reelGrid [src*="${file}"]') || document.querySelector('#reelGrid [src*="${file}"]').closest('.reel-cell').hidden`, 'the tile leaves while you look');
    for (let n = problems.length - 1; n >= 0; n--) if (problems[n].includes(file)) problems.splice(n, 1); // the browser logs the 404 it was meant to hit
    await fs.rename(away, path.join(dataDir, 'renders', file));
    await click('.tabs button[data-view="create"]');
  });

  await test('motion video: black bars are cropped with one click; a workflow that animates less says so; ✂️ Trim picks the part', async () => {
    const clip = path.join(tmp, 'webcam-bars.mp4');
    const made = await new Promise(resolve => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x240:rate=12', '-t', '10', '-vf', 'pad=480:240:160:0:black', '-pix_fmt', 'yuv420p', clip], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', code => resolve(code === 0));
    });
    if (!made) return console.log('      (skipped: ffmpeg not installed)');
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="wan-animate-2"]');
    if (await visible('.dz-preview')) await click('#imageClear');
    await setFiles('#videoInput', [clip]);
    await waitFor('document.querySelector("#mzInfo").textContent.includes("480×240")', 'the motion video is in', 15000);
    await waitFor('!!document.querySelector("#videoCrop")', 'it offers to crop the bars');
    assert((await text('#motionHint')).includes('160×240 inside a 480×240 frame'), 'and says where the picture is');
    await click('#videoCrop');
    await toastText('without its black bars');
    await waitFor('document.querySelector("#mzInfo").textContent.includes("160×240")', 'now the picture alone');
    assert(!(await js('!!document.querySelector("#videoCrop")')), 'nothing left to crop');
    eq(await value('#aspect'), '2:3', 'the aspect follows the cropped video (no character yet)');

    // The picked workflow (the mock template) animates 81 frames; this video has 120.
    await setFiles('#imageInput', [portrait]);
    await waitFor('(document.querySelector("#wfpWarn")?.textContent || "").includes("animates 81 frames")', 'step 5 says the workflow animates only part of it');
    assert((await text('#wfpWarn')).includes('the first 6.8s of your 10s motion video'), `and how much: ${await text('#wfpWarn')}`);
    await click('#videoTrim');
    await waitFor('document.querySelector("#trimDlg").open', 'the trim window');
    eq(await value('#trimEnd'), '6.75', 'it starts as long as the workflow animates (81 frames)');
    assert((await text('#trimNow')).includes('frame 1 of 120'), `the playhead is on the first frame: ${await text('#trimNow')}`);
    await waitFor('document.querySelectorAll(".trim-thumbs canvas").length >= 8', 'the timeline shows the video\'s frames');
    // Frame by frame to where it should start (a button, then the arrow key), and start there.
    await click('#trimFwd');
    await press('ArrowRight');
    await press('ArrowRight');
    assert((await text('#trimNow')).includes('frame 4 of 120'), `one frame per step: ${await text('#trimNow')}`);
    await click('#trimSetStart');
    eq(await value('#trimStart'), '0.25', 'it starts at that frame');
    // Drag along the timeline to 6 s and end there, then drag the start handle to 2 s: real mouse drags.
    await js('document.querySelector("#trimLine").scrollIntoView({ block: "center" })');
    const line = await js('(() => { const r = document.querySelector("#trimLine").getBoundingClientRect(); return { l: r.left, w: r.width, y: r.top + r.height / 2 }; })()');
    const xOf = f => line.l + ((f + 0.5) / 120) * line.w;
    const drag = async (x0, x1) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: line.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * k) / 6, y: line.y, button: 'left', buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: line.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(150);
    };
    await drag(xOf(40), xOf(71));
    assert((await text('#trimNow')).startsWith('0:05.92 · frame 72'), `the playhead shows the frame it's on: ${await text('#trimNow')}`);
    await click('#trimSetEnd');
    eq(await value('#trimEnd'), '6.00', 'and the part ends with it');
    await drag(line.l + (3 / 120) * line.w, xOf(24));
    eq(await value('#trimStart'), '2.00', 'the start handle drags to 2 s');
    assert((await text('#trimNow')).includes('frame 25'), 'and the frame it lands on shows');
    assert((await text('#trimNote')).includes('Frames 25–72 · 48 frames'), `it says what you picked: ${await text('#trimNote')}`);
    await shot('49-trim');
    await click('#trimGo');
    await toastText('of your motion video, from 2s');
    await waitFor('/🕺 4(\\.\\d)?s ·/.test(document.querySelector("#mzInfo").textContent) && !document.querySelector("#trimDlg").open', 'now that part alone (48 frames at 12 fps)');
    await waitFor('!(document.querySelector("#wfpWarn")?.textContent || "").includes("animates")', 'and the workflow does all of it');
    await click('#videoClear');
    await click('#imageClear');
    await click('.model-card[data-id="krea2-raw"]');
  });

  await test('jobs: the assistant works through a folder, skips what fails and logs it; a reload stops it safely', async () => {
    const pics = path.join(tmp, 'Pics');
    await fs.mkdir(pics, { recursive: true });
    await fs.writeFile(path.join(pics, 'a.png'), makePng(320, 200));
    await fs.writeFile(path.join(pics, 'b10.png'), makePng(200, 320));
    await fs.writeFile(path.join(pics, 'b2.png'), makePng(256, 256));
    await fs.writeFile(path.join(pics, 'broken.png'), 'not really a picture');
    await fs.writeFile(path.join(pics, 'notes.txt'), 'not a picture at all');
    const listed = await js(`fetch("/api/folder?path=" + encodeURIComponent(${q(pics)})).then(r => r.json())`);
    eq(JSON.stringify(listed.images.map(i => i.name)), JSON.stringify(['a.png', 'b2.png', 'b10.png', 'broken.png']), 'a folder lists its pictures in natural order');
    const missing = await js('fetch("/api/folder?path=NoSuchFolderAnywhere").then(async r => [r.status, (await r.json()).error])');
    assert(missing[0] === 404 && missing[1].includes('home folder'), `a missing folder says where it looked: ${missing[1]}`);
    await fs.mkdir(path.join(tmp, 'Work', 'Client A', 'Renders'), { recursive: true });
    const found = await js(`fetch("/api/find?kind=folder&q=renderings&in=" + encodeURIComponent(${q(path.join(tmp, "Work"))})).then(r => r.json())`);
    assert(found.found[0]?.path === path.join(tmp, 'Work', 'Client A', 'Renders'), `a folder is found by a name close to it, deep down: ${JSON.stringify(found.found[0])}`);
    const file = await js(`fetch("/api/find?kind=file&q=notes&in=" + encodeURIComponent(${q(tmp)})).then(r => r.json())`);
    assert(file.found.some(x => x.path === path.join(pics, 'notes.txt')), 'and a file by part of its name');
    if (await js('document.querySelector("#assistant").hidden')) await click('#askBtn');
    await type('#asInput', `show me the pictures in ${pics}`);
    await press('Enter');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    const saw = await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""');
    assert(saw.includes('I see them') && saw.includes('2 files'), `the assistant looks at pictures in a folder: ${saw}`);
    await click('#asClear');
    await click('#asClear');
    eq(await js(`fetch("/api/folder/image?path=" + encodeURIComponent(${q(path.join(pics, 'notes.txt'))})).then(r => r.status)`), 400, 'only pictures are handed out');

    const before = (await js('fetch("/api/history").then(r => r.json())')).length;
    await click('.tabs button[data-view="gallery"]');
    if (await js('document.querySelector("#assistant").hidden')) await click('#askBtn');
    await type('#asInput', `job: use the pictures in ${pics}, low then high temperature, skip problems`);
    await press('Enter');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    const acts = await js('[...document.querySelectorAll("#asLog .as-act")].map(a => a.textContent).join(" | ")');
    assert(acts.includes('4 pictures in') && acts.includes('Started the job “Pics, low and high”: 8 items'), `it looked, then started the job: ${acts}`);
    assert(await visible('#jobsBtn'), 'the 🗂 Job pill shows');
    // Your own click on the Create tab goes through while a job step runs (its tools can't pull you there, you can go).
    await waitFor('!!document.querySelector(".job-strip, #jobStrip") || document.querySelector("#jobsCount").textContent !== "✓"', 'the job is running');
    await click('.tabs button[data-view="create"]');
    assert(await js('document.querySelector(".tabs button[data-view=\'create\']").classList.contains("active")'), 'the Create tab answers your click while a job runs');
    await click('.tabs button[data-view="gallery"]');
    await waitFor('document.querySelector("#jobsCount").textContent === "✓"', 'the job finishes', 90000);
    assert(await js('document.querySelector(".tabs button[data-view=\'gallery\']").classList.contains("active")'), 'it ran without pulling you off the page you were on');
    eq((await js('fetch("/api/history").then(r => r.json())')).length, before + 6, 'six prompts written: two for each good picture');

    await click('#jobsBtn');
    await waitFor('document.querySelector("#jobsDlg").open && document.querySelectorAll(".job .ju").length === 8', 'the Jobs window with the log');
    eq(await count('.job .ju.s-done'), 6, 'six done');
    eq(await count('.job .ju.s-skipped'), 2, 'the broken picture is skipped, both runs');
    assert((await text('.job .ju.s-skipped')).includes('broken.png'), 'and the log says why');
    assert((await text('.job .job-chip')).includes('done'), 'the job is done');
    assert((await text('.job .job-req')).includes('skip problems'), 'it shows what you asked');
    await shot('46-jobs');
    await click('.job .ju.s-done .ju-thumb');
    await waitFor('document.querySelector("#imgView").open', 'a picture from the log opens full screen');
    await click('#ivClose');
    await click('.job [data-job="only"]');
    eq(await count('.job .ju'), 2, 'Only the skipped ones');
    assert(await js('document.querySelector(".job .ju.s-skipped .ju-thumb").classList.contains("broken")'), 'a picture that won\'t open shows ⚠ instead');
    await click('#jobsClose');
    assert(await js('document.querySelector("#jobsBtn").hidden'), 'once seen, the pill goes away');
    assert(!(await js('document.querySelector("#asJobs").hidden')), 'the log stays a click away in the assistant panel');
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')).jobs[0];
    eq(saved.status, 'done', 'the job and its log are saved');

    // A job that was running when the page went away: it stops at that item, marked to check, and offers Resume.
    const half = { ...saved, id: 'reloaded-job', title: 'Half done', status: 'running', beat: Date.now() - 600e3, seen: false, units: saved.units.map((u, i) => ({ ...u, status: i < 2 ? 'done' : i === 2 ? 'running' : 'pending' })) };
    await js(`fetch("/api/jobs/reloaded-job", { method: "PUT", headers: { "Content-Type": "application/json" }, body: ${q(JSON.stringify(half))} }).then(r => r.ok)`);
    await goto(`${APP}/#gallery`);
    await toastText('was interrupted');
    const after = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')).jobs.find(j => j.id === 'reloaded-job');
    eq(after.status, 'paused', 'it is paused');
    assert(after.units[2].status === 'skipped' && after.units[2].error.includes('Interrupted'), 'the item it was on is marked to check');
    await click('#jobsBtn');
    await waitFor('document.querySelector(".job[data-id=\'reloaded-job\'] [data-job=\'remove\']")', 'a paused job can be removed');
    await click('.job[data-id="reloaded-job"] [data-job="remove"]');
    await click('.job[data-id="reloaded-job"] [data-job="remove"]');
    await waitFor('!document.querySelector(".job[data-id=\'reloaded-job\']")', 'removed');
    await click('#jobsClose');
  });

  await test('workflows: the ones that come with the app are offered first, set themselves up, and carry nobody\'s prompts', async () => {
    // Every workflow that ships: Prompt Maker's own format, no prompt text, no seed, no picture of anyone's.
    const dir = path.join(ROOT, 'workflows');
    let shippedCount = 0;
    for (const model of await fs.readdir(dir)) {
      for (const f of await fs.readdir(path.join(dir, model))) {
        const w = JSON.parse(await fs.readFile(path.join(dir, model, f), 'utf8'));
        shippedCount++;
        eq(w.format, wfLib.EXPORT_FORMAT, `${model}/${f} is in the export format`);
        for (const [id, node] of Object.entries(w.prompt)) {
          for (const [input, v] of Object.entries(node.inputs)) {
            if (/^(text|prompt|string|value)$/i.test(input) && typeof v === 'string') eq(v, '', `${model}/${f} node ${id} ${input} is empty`);
            if (/seed/i.test(input) && typeof v === 'number') eq(v, 0, `${model}/${f} node ${id} seed is 0`);
          }
          if (node.class_type === 'LoadImage') eq(node.inputs.image, 'example.png', `${model}/${f} loads no one's picture`);
        }
        assert(w.models.every(m => /^https:\/\/huggingface\.co\//.test(m.url)), `${model}/${f}: every model file has a Hugging Face link`);
      }
    }
    assert(shippedCount > 0, 'a workflow ships');
    const refused = await fetch(`${APP}/api/workflows/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP }, body: JSON.stringify({ starter: '../../package.json' }) });
    eq(refused.status, 404, 'only files in workflows/ are read');

    await click('.tabs button[data-view="models"]');
    await click('#modelList button[data-id="krea-2-raw-i2i"]');
    await click('#addWorkflowBtn');
    await waitFor('!document.querySelector("#wfStarters").hidden && document.querySelectorAll("#wfStList button").length === 1', 'the starter workflow is offered');
    await click('#wfStList button');
    await waitFor('!document.querySelector("#wfSetup").hidden', 'setup step');
    eq(await value('#wfName'), 'Krea 2 RAW: image to image', 'named');
    await click('#wfSave');
    await waitFor('!document.querySelector("#wfDialog").open', 'saved');
    const flow = (await fetch(`${APP}/api/workflows`).then(r => r.json())).find(f => f.modelId === 'krea-2-raw-i2i');
    eq(flow?.source, 'starter:krea-2-raw-i2i/image-to-image.json', 'remembers where it came from');
    await click('#addWorkflowBtn');
    await waitFor('document.querySelector("#wfStList button")?.textContent.includes("added already")', 'marked as added');
    await click('#wfClose');
    await fetch(`${APP}/api/workflows/${flow.id}`, { method: 'DELETE', headers: { Origin: APP } });

    // Every built-in model comes with a workflow, added by itself; one you have already is left alone.
    for (const id of ['krea-2-raw-i2i', 'krea2-raw', 'ltx-2-3', 'minimax-h3', 'minimax-h3-ref', 'wan-animate-2', 'krea-2-character']) {
      assert((await fs.readdir(path.join(dir, id)).catch(() => [])).length, `${id} ships with a workflow`);
    }
    const startersFile = path.join(dataDir, 'starters.json');
    const before = await fetch(`${APP}/api/workflows`).then(r => r.json());
    const mine = new Set(before.map(f => f.modelId));
    await fs.writeFile(startersFile, '{}');
    const after = await fetch(`${APP}/api/workflows`).then(r => r.json());
    for (const id of await fs.readdir(dir)) {
      const flows = after.filter(f => f.modelId === id);
      if (mine.has(id)) eq(flows.map(f => f.id).sort().join(), before.filter(f => f.modelId === id).map(f => f.id).sort().join(), `${id} keeps the workflows it had (a starter you added yourself included), nothing new`);
      else eq(flows.map(f => f.source.split("/")[0]).join(), `starter:${id}`, `${id} got its starter workflow`);
    }
    const added = after.filter(f => !before.some(b => b.id === f.id));
    assert(added.length > 0, 'some starters were added');
    for (const f of added) await fetch(`${APP}/api/workflows/${f.id}`, { method: 'DELETE', headers: { Origin: APP } });
    const gone = await fetch(`${APP}/api/workflows`).then(r => r.json());
    eq(gone.length, before.length, 'a starter you deleted stays deleted');
    await goto(APP);
  });

  await test('voices: one-click setup, describe a voice and hear it, keep it by name, say a line, rename, delete', async () => {
    await click('.tabs button[data-view="voices"]');
    await waitFor('document.querySelector("#view-voices").classList.contains("active") && !document.querySelector("#voiceSetup").hidden', 'the Voices page, not set up yet');
    assert((await text('#voiceSetup')).includes('GB'), 'says how much it downloads');
    assert(await js('document.querySelector("#voiceNew").hidden && document.querySelector("#voiceListCard").hidden'), 'nothing to make voices with yet');
    await shot('voices-setup');
    await click('#voiceInstall');
    await waitFor('!document.querySelector("#voiceProgress").hidden || document.querySelector("#voiceSetup").hidden', 'a progress bar (or already done)');
    await toastText('Voices are ready', 15000);
    await waitFor('document.querySelector("#voiceSetup").hidden && !document.querySelector("#voiceNew").hidden', 'ready: the setup card goes, the voice form shows');
    assert(await fileExists(path.join(dataDir, 'voice', 'site', 'qwen_tts', '__init__.py')), 'the packages went into the data folder');
    const r = await (await fetch(`${APP}/api/voice`)).json();
    assert(r.installed && r.packages && r.models, `the server agrees: ${JSON.stringify(r).slice(0, 200)}`);
    await goto(`${APP}/#voices`);
    await waitFor('document.querySelector("#voiceSetup").hidden && !document.querySelector("#voiceNew").hidden', 'still installed after a reload');

    // Describe → hear → keep.
    await click('#vHear');
    await toastText('Describe the voice first');
    await type('#vDesc', 'A woman in her late twenties, warm light alto, soft Midwestern lilt');
    await click('#vHear');
    await waitFor('!document.querySelector("#vHeard").hidden && document.querySelector("#vPlay").src.includes("/voice/")', 'a clip to hear', 10000);
    assert(/\/voice\/[a-f0-9]{16}\.wav$/.test(await js('document.querySelector("#vPlay").src')), 'served from the voice folder');
    eq((await fetch(await js('document.querySelector("#vPlay").src'))).status, 200, 'the clip plays');
    eq(await js('document.activeElement.id'), 'vName', 'ready to be named');
    await click('#vKeep');
    await toastText('Give the voice a name');
    await type('#vName', 'Jess');
    await press('Enter');
    await toastText('Kept the voice “Jess”');
    eq(await count('#voiceList li'), 1, 'listed');
    assert((await text('#voiceList li')).includes('Jess') && (await text('#voiceList li')).includes('Midwestern'), 'with its name and description');
    assert(await js('document.querySelector("#vHeard").hidden'), 'the form is ready for the next one');
    await type('#vDesc', 'please fail');
    await click('#vHear');
    await toastText('mock refuses');
    await type('#vDesc', 'A deep calm narrator');
    await click('#vHear');
    await waitFor('!document.querySelector("#vHeard").hidden', 'heard', 10000);
    await type('#vName', 'jess');
    await click('#vKeep');
    await toastText('already a voice called');
    await type('#vName', 'Narrator');
    await click('#vKeep');
    await toastText('Kept the voice “Narrator”');
    eq(await count('#voiceList li'), 2, 'two voices');

    // Say a line in it.
    await click('#voiceList li [data-act="say"]');
    await toastText('Type a line to say first');
    await type('#vTry', 'Every frame, generated. Nothing ever left my computer.');
    await click('#voiceList li [data-act="say"]');
    await waitFor('!!document.querySelector("#voiceList li audio")', 'the line plays in the list', 10000);
    assert((await text('#voiceList li .vl-said')).includes('Every frame') && /\d+(\.\d+)?s/.test(await text('#voiceList li .vl-said')), 'with the words and how long it is');
    await click('#voiceList li [data-act="sample"]');
    assert((await text('#voiceList li .vl-said')).includes('out near the lake'), 'the sample again');
    await shot('voices');

    // Rename, delete (asks once).
    await click('#voiceList li [data-act="rename"]');
    await type('#voiceList li .vl-name input', 'Jess from Ohio');
    await press('Enter');
    await waitFor('document.querySelector("#voiceList li .vl-name").textContent.includes("Jess from Ohio")', 'renamed');
    eq((await (await fetch(`${APP}/api/voice`)).json()).voices[0].name, 'Jess from Ohio', 'saved');
    await click('#voiceList li [data-act="delete"]');
    eq(await count('#voiceList li'), 2, 'one click asks');
    assert((await text('#voiceList li [data-act="delete"]')).includes('Sure?'), 'and says so');
    await click('#voiceList li [data-act="delete"]');
    await toastText('Deleted the voice');
    eq(await count('#voiceList li'), 1, 'gone; the Narrator stays');
    await click('.tabs button[data-view="create"]');
  });

  await test('🎙 a line in step 3: said in a kept voice at Generate, the video\'s soundtrack at Render, saved and put back', async () => {
    const narrator = (await (await fetch(`${APP}/api/voice`)).json()).voices.find(v => v.name === 'Narrator');
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="krea2-raw"]');
    assert(await js('document.querySelector("#lineBlock").hidden'), 'no line on an image model');
    // MiniMax H3's own workflow takes a sound file (the line). An earlier test may have given it another: add the starter.
    if (!(await (await fetch(`${APP}/api/workflows`)).json()).some(f => f.modelId === 'minimax-h3' && f.maps.audio)) {
      const prep = await (await fetch(`${APP}/api/workflows/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starter: 'minimax-h3/image-to-video.json' }) })).json();
      await fetch(`${APP}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'minimax-h3', name: prep.name, source: prep.source, prompt: prep.prompt, mapping: prep.mapping, options: prep.options, models: prep.models }) });
      await goto(`${APP}/#create`);
    }
    await click('.model-card[data-id="minimax-h3"]');
    const h3 = (await (await fetch(`${APP}/api/workflows`)).json()).find(f => f.modelId === 'minimax-h3' && f.maps.audio);
    await choose('#wfpSelect', h3.id);
    await waitFor('!document.querySelector("#lineBlock").hidden && !document.querySelector("#lineForm").hidden', 'the line form on MiniMax H3 (its workflow takes a sound file)');
    eq(await js('[...document.querySelectorAll("#lineVoice option")].map(o => o.textContent).join("|")'), 'No line|🎙 Narrator', 'your voices to pick from');
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector("#dropzone .dz-preview").hidden', 'image in');
    await choose('#lineVoice', narrator.id);
    await type('#lineText', 'Every frame, generated. Nothing ever left my computer.');
    await press('Tab');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'she looks up from her coffee and speaks');
    await click('#generateBtn');
    await genDone();
    const entry = (await (await fetch(`${APP}/api/history`)).json())[0];
    assert(/^[a-f0-9]{16}\.wav$/.test(entry.line?.file || '') && entry.line.seconds > 0 && entry.line.voice?.name === 'Narrator' && entry.line.text.startsWith('Every frame'), `the line was said and saved with the prompt: ${JSON.stringify(entry.line)}`);
    assert(await fileExists(path.join(dataDir, 'voice', 'clips', entry.line.file)), 'its clip is in the data folder');
    const asked = JSON.stringify(mock.log.at(-1).messages);
    assert(asked.includes('SPOKEN LINE') && asked.includes('Every frame, generated. Nothing ever left my computer.'), 'the Brain is told the exact words');
    await click('.take .rb-count button[data-value="1"]');
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img, .take .rtile video") && !document.querySelector(".take .rtile.running")', 'rendered', 15000);
    let p = comfy.prompts.at(-1).prompt;
    eq(p['200']?.inputs.audio, `prompt-maker_${entry.line.file}`, 'the clip went to ComfyUI as the soundtrack');
    eq(JSON.stringify(p['105:16'].inputs.conditioning), '["201",0]', 'through the Add Guide node');
    assert(Number(p['105:111'].inputs.value) >= entry.line.seconds + 1, `the clip is at least as long as the line: ${p['105:111'].inputs.value}s for ${entry.line.seconds}s`);
    await click('.take .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'lightbox');
    assert((await text('#lbInfo')).includes('Says') && (await text('#lbInfo')).includes('Every frame') && (await text('#lbInfo')).includes('Narrator'), 'the full-screen view shows what is said, and by which voice');
    await press('Escape');

    // No line: the sound nodes are left out.
    await click('#lineClear');
    await waitFor('document.querySelector("#lineText").value === ""', 'cleared');
    await type('#theme', 'she sips her coffee');
    await click('#generateBtn');
    await genDone();
    assert(!(await (await fetch(`${APP}/api/history`)).json())[0].line, 'no line this time');
    await click('.take .rb-go');
    await waitFor('!!document.querySelector(".take .rtile img, .take .rtile video") && !document.querySelector(".take .rtile.running")', 'rendered', 15000);
    p = comfy.prompts.at(-1).prompt;
    assert(!p['200'] && !p['201'] && JSON.stringify(p['105:16'].inputs.conditioning) === '["105:104",0]', 'Load Audio and Add Guide are gone, the rest wired as before');

    // A workflow that takes no line: step 3 offers the one that does, and the assistant switches by itself.
    const plain = await (await fetch(`${APP}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'minimax-h3', name: 'H3 without sound', source: 'upload', prompt: JSON.parse(await fs.readFile(apiWorkflowFile, 'utf8')), mapping: { prompt: [{ node: '6', input: 'text' }], image: null, video: null, seed: [] } }) })).json();
    await goto(`${APP}/#create`);
    await choose('#wfpSelect', plain.id);
    await waitFor('!document.querySelector("#lineBlock").hidden && !document.querySelector("#lineSwitch").hidden && document.querySelector("#lineForm").hidden', 'the line block offers the workflow that takes a line');
    await click('#lineSwitchBtn');
    await waitFor(`document.querySelector("#wfpSelect").selectedOptions[0]?.textContent === ${q(h3.name)} && !document.querySelector("#lineForm").hidden`, 'one click picks it').catch(async e => { throw new Error(`${e.message} | picked: ${await js('document.querySelector("#wfpSelect").selectedOptions[0]?.textContent')} | form hidden: ${await js('document.querySelector("#lineForm").hidden')} | switch hidden: ${await js('document.querySelector("#lineSwitch").hidden')} | toast: ${await text('#toast')}`); });
    await choose('#wfpSelect', plain.id);
    await waitFor('document.querySelector("#lineForm").hidden', 'back on the plain one');

    // The assistant sets a line and makes voices too (switching the workflow by itself).
    if (!(await visible('#assistant'))) await click('#askBtn');
    await type('#asInput', 'make her say "Hello there, and welcome."');
    await press('Enter');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    const said = await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""');
    assert(said.includes('Narrator says “Hello there, and welcome.”'), `the assistant set the line: ${said}`);
    eq(await value('#lineText'), 'Hello there, and welcome.', 'in step 3');
    eq(await js('document.querySelector("#wfpSelect").selectedOptions[0]?.textContent'), h3.name, 'on the workflow that takes the line');
    await fetch(`${APP}/api/workflows/${plain.id}`, { method: 'DELETE', headers: { Origin: APP } });
    await type('#asInput', 'make a new voice called Sam');
    await press('Enter');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    assert((await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""')).includes('kept the voice “Sam”'), 'and made a voice');
    await type('#asInput', 'make a new voice called Sam');
    await press('Enter');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 20000);
    assert((await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""')).includes('“Sam” is already there'), 'the same name again just uses it (a job run twice keeps going)');
    eq(await js('[...document.querySelectorAll("#lineVoice option")].map(o => o.textContent).join("|")'), 'No line|🎙 Narrator|🎙 Sam', 'which step 3 offers right away');
    await click('#asClear');
    await click('#asClear');
    await click('#asClose');

    // History puts the line back.
    await click('.tabs button[data-view="history"]');
    await waitFor('[...document.querySelectorAll(".hcard")].some(c => c.textContent.includes("looks up from her coffee"))', 'the card');
    const n = await js('[...document.querySelectorAll(".hcard")].findIndex(c => c.textContent.includes("looks up from her coffee")) + 1');
    await click(`.hcard:nth-of-type(${n}) [data-act="open"]`);
    await waitFor('document.querySelector("#lineText").value.startsWith("Every frame")', 'the line is back');
    eq(await value('#lineVoice'), narrator.id, 'in its voice');
    await click('#lineClear');
    await js('document.querySelector("#imageClear").click()');
    await click('.model-card[data-id="krea2-raw"]');

    // Deleting the entry takes the clip too, in the data folder and in ComfyUI's input folder, and the words of the line.
    assert(await fileExists(path.join(comfyRoot, 'input', `prompt-maker_${entry.line.file}`)), "ComfyUI's input folder has the clip before");
    await fetch(`${APP}/api/history/${entry.id}`, { method: 'DELETE' });
    assert(!(await fileExists(path.join(dataDir, 'voice', 'clips', entry.line.file))), 'its clip is gone from the data folder');
    assert(!(await fileExists(path.join(comfyRoot, 'input', `prompt-maker_${entry.line.file}`))), "and ComfyUI's copy of it");
    assert(!(await fs.readFile(path.join(dataDir, 'history.json.bak'), 'utf8')).includes('Nothing ever left my computer'), 'the copy of History from before no longer has the line');
  });

  await test('🎬 join videos: the ones shown in Your renders, in their order, become one video; the assistant joins too', async () => {
    if (!(await clip)) return console.log('    (skipped: no ffmpeg)');
    if (!(await (await fetch(`${APP}/api/workflows`)).json()).some(f => f.modelId === 'minimax-h3')) {
      const prep = await (await fetch(`${APP}/api/workflows/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starter: 'minimax-h3/image-to-video.json' }) })).json();
      await fetch(`${APP}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'minimax-h3', name: prep.name, source: prep.source, prompt: prep.prompt, mapping: prep.mapping, options: prep.options, models: prep.models }) });
      await goto(`${APP}/#create`);
    }
    await click('.tabs button[data-view="create"]');
    await click('.model-card[data-id="minimax-h3"]');
    await js('document.querySelector("#lineClear")?.click()');
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector("#dropzone .dz-preview").hidden', 'image in');
    await click('#varSeg button[data-value="1"]');
    const before = (await (await fetch(`${APP}/api/history`)).json()).length;
    for (const theme of ['MP4TEST clip one, a sunrise', 'MP4TEST clip two, a sunset']) {
      await type('#theme', theme);
      await click('#generateBtn');
      await genDone();
      await click('.take .rb-count button[data-value="1"]');
      await click('.take .rb-go');
      await waitFor('!!document.querySelector(".take .rtile video, .take .rtile img") && !document.querySelector(".take .rtile.running")', 'rendered', 15000).catch(async e => { throw new Error(`${e.message} | stage: ${await text('#stageError')} | tile: ${await js('document.querySelector(".take .rtile")?.outerHTML.slice(0, 400)')}`); });
    }
    const made = (await (await fetch(`${APP}/api/history`)).json()).slice(0, 2);
    assert(made.every(e => e.variations[0].renders?.[0]?.files[0].kind === 'video'), `two little videos: ${JSON.stringify(made.map(e => e.variations[0].renders?.[0]?.files))}`);
    await js('if (document.querySelector("#reelToggle").getAttribute("aria-expanded") !== "true") document.querySelector("#reelToggle").click()');
    await click('#reelKinds [data-kind="video"]');
    await waitFor('!document.querySelector("#reelJoin").hidden', 'the Join button shows with two or more videos');
    const n = Number((await text('#reelJoin')).match(/\d+/)[0]);
    assert(n >= 2, `counts them: ${await text('#reelJoin')}`);
    await click('#reelJoin');
    await toastText('Joined', 60000);
    const joined = (await (await fetch(`${APP}/api/history`)).json())[0];
    eq(joined.modelName, 'Joined video', 'a new render of its own');
    const r = joined.variations[0].renders[0];
    eq(r.joined.length, n, 'from those videos, in order');
    assert(/\.mp4$/.test(r.files[0].file) && await fileExists(path.join(dataDir, 'renders', r.files[0].file)), 'one file in the data folder');
    const probe = await videotools.probe(path.join(dataDir, 'renders', r.files[0].file));
    assert(probe && probe.seconds >= n * 0.9 && probe.seconds <= n * 1.3, `as long as all of them together: ${probe?.seconds}s for ${n}`);
    eq(await count('#reelGrid .reel-card, #reelGrid .rcard, #reelGrid > *') > 0, true, 'it lands in the grid');
    await click('#reelKinds [data-kind=""]');
    await waitFor('document.querySelector("#toast").hidden', 'the toast goes', 12000);

    if (!(await visible('#assistant'))) await click('#askBtn');
    await type('#asInput', 'join the videos shown');
    await press('Enter');
    await waitFor('document.querySelector("#asStop").hidden', 'assistant done', 60000);
    const said = await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""');
    assert(said.includes('Joined') && said.includes('videos into'), `the assistant joins the shown videos: ${said}`);
    await click('#asClear');
    await click('#asClear');
    await click('#asClose');
    const now = await (await fetch(`${APP}/api/history`)).json();
    eq(now.length, before + 4, 'two clips, two joins');
    for (const e of now.slice(0, 4)) await fetch(`${APP}/api/history/${e.id}`, { method: 'DELETE', headers: { Origin: APP } }); // tidy: the tests after this open the newest card
    await goto(`${APP}/#create`);
    await click('.model-card[data-id="krea2-raw"]');
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
    await fs.writeFile(path.join(old, 'history.json'), JSON.stringify([{ id: 'old-1', createdAt: '2026-09-01T00:00:00.000Z', theme: 'an old theme', modelId: 'krea2-raw', imageFile: 'a.jpg', variations: [{ versions: [{ text: 'an old prompt' }], renders: [{ id: 'r1', files: [{ file: 'r.png', kind: 'image' }] }] }] }]));
    await fs.writeFile(path.join(old, 'images', 'a.jpg'), 'jpg');
    await fs.writeFile(path.join(old, 'renders', 'r.png'), 'png');
    await fs.writeFile(path.join(old, 'renders', 'orphan.png'), 'left by a delete in an older version');
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
      assert(!(await fileExists(path.join(dir, 'renders', 'orphan.png'))), 'a render no History entry uses is removed at start-up');
      assert(!(await fileExists(path.join(dir, 'models', 'krea2-raw.json'))), 'an untouched copy of a built-in is dropped');
      const models = await get('/api/models');
      assert(models.some(m => m.id === 'my-model' && !m.builtin), 'your own model is there');
      assert(models.some(m => m.id === 'krea2-raw' && m.builtin && !m.edited), 'built-ins come from the app');
    } finally {
      srv.kill();
    }
  });

  await test('delete: a picture that a prompt in line needs, or one being written from, stays', async () => {
    const send = (p, body, method = 'POST') => fetch(`${APP}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const img = (await (await send('/api/images', { image: `data:image/png;base64,${makePng(37, 41).toString('base64')}` })).json()).file;
    const file = path.join(dataDir, 'images', img);
    const gen = async theme => {
      const out = await (await send('/api/generate', { modelId: 'krea2-raw', variations: 1, theme, imageFile: img, imageRole: 'reference' })).text();
      return JSON.parse(out.split('\n').find(l => l.includes('"saved"')).replace(/^data: /, '')).entry;
    };
    const holds = line => send('/api/holds', { client: 'test-browser-1', form: [], line }, 'PUT');
    // A prompt waiting in line uses the same picture as the card being deleted.
    const first = await gen('a held picture, one');
    await holds([img]);
    await fetch(`${APP}/api/history/${first.id}`, { method: 'DELETE' });
    assert(await fileExists(file), 'the picture stays for the prompt in line');
    await holds([]);
    // A prompt is being written from it while the only card with it is deleted.
    const second = await gen('a held picture, two');
    const third = gen('SLOWTEST a held picture, three');
    await sleep(800);
    await fetch(`${APP}/api/history/${second.id}`, { method: 'DELETE' });
    assert(await fileExists(file), 'the picture stays while a prompt is written from it');
    const saved = await third;
    eq(saved.imageFile, img, 'and the new card has it');
    // Nothing needs it anymore: it goes with its last card.
    await fetch(`${APP}/api/history/${saved.id}`, { method: 'DELETE' });
    assert(!(await fileExists(file)), 'deleted with the last card that used it');
  });

  await test('files are sent piece by piece: a part of a video or picture on request, not the whole file each time', async () => {
    const one = (await fs.readdir(path.join(dataDir, 'renders')))[0];
    const whole = await fs.readFile(path.join(dataDir, 'renders', one));
    const part = await fetch(`${APP}/renders/${one}`, { headers: { Range: 'bytes=10-19' } });
    eq(part.status, 206, 'a part is a part');
    eq(part.headers.get('content-range'), `bytes 10-19/${whole.length}`, 'it says which');
    eq(Buffer.from(await part.arrayBuffer()).equals(whole.subarray(10, 20)), true, 'the right bytes');
    const tail = await fetch(`${APP}/renders/${one}`, { headers: { Range: 'bytes=-5' } });
    eq(Buffer.from(await tail.arrayBuffer()).equals(whole.subarray(whole.length - 5)), true, 'the last bytes');
    eq((await fetch(`${APP}/renders/${one}`, { headers: { Range: `bytes=${whole.length}-` } })).status, 416, 'past the end is refused');
    eq(Buffer.from(await (await fetch(`${APP}/renders/${one}`)).arrayBuffer()).equals(whole), true, 'and the whole file is the whole file');
  });

  await test('a damaged settings or history file does not stop the app: the copy from before the last save is used', async () => {
    const settings = await (await fetch(`${APP}/api/settings`)).json();
    const put = body => fetch(`${APP}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await put({ topP: settings.topP }); // two saves, so the copy from before the last one is as good as the file
    await put({ topP: settings.topP });
    await fs.writeFile(path.join(dataDir, 'settings.json'), ''); // what a power cut could leave
    const after = await fetch(`${APP}/api/settings`);
    eq(after.status, 200, 'settings still load');
    eq((await after.json()).llmModel, settings.llmModel, 'with what you had set');
    assert((await fs.readdir(dataDir)).some(f => f.startsWith('settings.json.damaged-')), 'the damaged file is set aside, not thrown away');
    eq(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).llmModel, settings.llmModel, 'and the file is whole again');
    // History the same way: its entries (and so their renders) are not lost.
    const history = await (await fetch(`${APP}/api/history`)).json();
    const fav = history[0].favorite;
    const patch = favorite => fetch(`${APP}/api/history/${history[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite }) });
    await patch(fav);
    await patch(fav);
    await fs.writeFile(path.join(dataDir, 'history.json'), '{"cut off');
    eq((await (await fetch(`${APP}/api/history`)).json()).length, history.length, 'every entry is still there');
  });

  await test('the built-in instructions are not frozen into your settings; a bypassed subgraph passes its input on', async () => {
    const put = body => fetch(`${APP}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const s = await (await fetch(`${APP}/api/settings`)).json();
    await put({ masterPrompt: s.defaultMasterPrompt, adultPrompt: s.defaultAdultPrompt });
    let file = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert(!('masterPrompt' in file) && !('adultPrompt' in file), 'the built-in text is not written out, so a newer version\'s reaches you');
    eq((await (await fetch(`${APP}/api/settings`)).json()).masterPrompt, s.defaultMasterPrompt, 'and it is still what is used');
    await put({ masterPrompt: 'My own rules.' });
    file = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    eq(file.masterPrompt, 'My own rules.', 'your own edit is kept');
    await put({ masterPrompt: s.masterPrompt });

    const info = OBJECT_INFO;
    const sub = { id: 'sg-1', name: 'Extra', inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [{ name: 'image', type: 'IMAGE', linkIds: [1] }], outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [2] }],
      nodes: [{ id: 5, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [2] }], widgets_values: ['inner.png', 'image'] }],
      links: [{ id: 2, origin_id: 5, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' }] };
    const ui = mode => ({
      nodes: [
        { id: 1, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: ['a.png', 'image'] },
        { id: 2, type: 'sg-1', mode, inputs: [{ name: 'image', type: 'IMAGE', link: 10 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }] },
        { id: 3, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: ['ComfyUI'] },
      ],
      links: [[10, 1, 0, 2, 0, 'IMAGE'], [11, 2, 0, 3, 0, 'IMAGE']],
      definitions: { subgraphs: [sub] },
    });
    eq(JSON.stringify(convertUiWorkflow(ui(0), info)['3'].inputs.images), '["2:5",0]', 'an active subgraph: its inner node feeds the save');
    const bypassed = convertUiWorkflow(ui(4), info);
    eq(JSON.stringify(bypassed['3'].inputs.images), '["1",0]', 'bypassed: what went in goes straight on');
    assert(!Object.keys(bypassed).some(id => id.startsWith('2:')), 'and none of its inner nodes are sent');
  });

  await test('the assistant panel never lies over the page; the top bar\'s menus open over the panel; the Gallery fits the window', async () => {
    const open = async want => { if ((await js('!document.querySelector("#assistant").hidden')) !== want) await click('#askBtn'); await sleep(350); };
    const edges = () => js('(() => { const s = document.querySelector(".stage").getBoundingClientRect(); const a = document.querySelector("#assistant").getBoundingClientRect(); return { stageRight: Math.round(s.right), stageWidth: Math.round(s.width), panelLeft: Math.round(a.left) }; })()');
    await click('.tabs button[data-view="create"]');
    await viewport(1600, 1000);
    await open(true);
    let e = await edges();
    assert(e.stageRight <= e.panelLeft, `nothing of the results is under the panel: ${JSON.stringify(e)}`);
    assert(e.stageWidth > 600 && !(await js('document.body.classList.contains("narrow")')), `and they keep the room that is there: ${JSON.stringify(e)}`);
    await click('#llmPick');
    assert(await js('(() => { const b = document.querySelector("#llmMenu").getBoundingClientRect(); const a = document.querySelector("#assistant").getBoundingClientRect(); return b.right > a.left && !!document.elementFromPoint(b.right - 20, b.top + 60)?.closest("#llmMenu"); })()'), 'the Brain menu opens over the panel');
    await press('Escape');
    await viewport(1100, 800);
    await sleep(200);
    e = await edges();
    assert(await js('document.body.classList.contains("narrow")'), 'beside the panel on a smaller window, the page lays itself out in one column');
    assert(e.stageRight <= e.panelLeft, `so still nothing is under the panel: ${JSON.stringify(e)}`);
    eq(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'and nothing scrolls sideways');
    eq(await js('Math.round(document.querySelector(".as-title").getBoundingClientRect().height) < 30'), true, 'the panel\'s title stays on one line');
    await open(false);
    assert(!(await js('document.body.classList.contains("narrow")')), 'closed: two columns again');
    await viewport(1440, 900);
    await click('.tabs button[data-view="gallery"]');
    await sleep(400);
    eq(await js('document.documentElement.scrollHeight - innerHeight'), 0, 'the Gallery fills the window exactly: only its grid scrolls');
    await click('.tabs button[data-view="create"]');
  });

  await test('the assistant panel stretches: drag its edge, ⤢ fills the window and goes back; the message box grows and can be dragged taller', async () => {
    const drag = async (sel, dx, dy) => {
      const g = await js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x + (dx * k) / 6, y: g.y + (dy * k) / 6, button: 'left', buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x + dx, y: g.y + dy, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(150);
    };
    const width = () => js('Math.round(document.querySelector("#assistant").getBoundingClientRect().width)');
    const edges = () => js('(() => { const s = document.querySelector(".stage").getBoundingClientRect(); const a = document.querySelector("#assistant").getBoundingClientRect(); return { stageRight: Math.round(s.right), panelLeft: Math.round(a.left) }; })()');
    await click('.tabs button[data-view="create"]');
    await viewport(1600, 1000);
    if (await js('document.querySelector("#assistant").hidden')) await click('#askBtn');
    await sleep(350);
    eq(await width(), 420, 'it starts 420 wide');
    await drag('#asGrip', -280, 0);
    eq(await width(), 700, 'dragging its left edge makes it wider');
    const e = await edges();
    assert(e.stageRight <= e.panelLeft, `and the page makes room: ${JSON.stringify(e)}`);
    await click('#asWide');
    eq(await width(), 1600, '⤢ fills the window');
    eq(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'nothing scrolls sideways');
    await viewport(1300, 900);
    await sleep(200);
    eq(await width(), 1300, 'and keeps filling it when the window changes');
    await click('#asWide');
    eq(await width(), 700, 'again: back to the width it had');
    await js('location.reload()');
    await waitFor('document.documentElement.dataset.ready === "1"', 'reloaded');
    await sleep(350);
    eq(await width(), 700, 'the width is remembered');
    await js('document.querySelector("#asGrip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    eq(await width(), 420, 'a double click on the edge: back to normal');
    const height = () => js('Math.round(document.querySelector("#asInput").getBoundingClientRect().height)');
    const h0 = await height();
    await js('(() => { const t = document.querySelector("#asInput"); t.value = "line\\n".repeat(5); t.dispatchEvent(new Event("input", { bubbles: true })); })()');
    assert(await height() > h0 && await height() <= 160, `the message box grows with what is written: ${h0} → ${await height()}`);
    await drag('#asInputGrip', 0, -300);
    assert(await height() >= 400, `and dragging the edge above it makes it as tall as you like: ${await height()}`);
    await js('document.querySelector("#asInputGrip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await js('(() => { const t = document.querySelector("#asInput"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()');
    eq(await height(), h0, 'a double click on that edge: back to normal');
    await click('#asClose');
    await viewport(1440, 900);
  });

  await test('viewer: the stars come first; ⇆ Compare puts two renders side by side, each with its stars', async () => {
    await click('.tabs button[data-view="gallery"]');
    await waitFor('document.querySelectorAll("#reelGrid .reel-cell").length >= 2', 'at least two renders in the Gallery');
    eq(await js('[...document.querySelectorAll("#reelGrid .reel-cell .rate-bar")][0].querySelector("button").dataset.rate'), '1', 'on a card, the stars are in their natural order for the keyboard');
    assert(await js('document.querySelector("#reelGrid .rate-bar button").getBoundingClientRect().width >= 28'), 'and big enough to hit');
    await click('#reelGrid .reel-cell .rtile');
    await waitFor('!document.querySelector("#lightbox").hidden', 'viewer open');
    eq(await js('[...document.querySelector("#lbInfo").children].map(e => e.className.split(" ")[0] || e.tagName).slice(0, 3).join(" ")'), 'H3 lb-rate lb-prompt', 'title, then the stars, then the prompt');
    assert(!(await text('#lbInfo .lb-facts')).includes('—'), 'facts with nothing to say are left out');
    await click('#lbInfo [data-lb="compare"]');
    await waitFor('document.querySelector("#lbStage").classList.contains("pair") && document.querySelectorAll("#lbStage .lb-pane").length === 2', 'two side by side');
    const names = () => js('[...document.querySelectorAll("#lbStage .lb-pane img, #lbStage .lb-pane video")].map(m => m.getAttribute("src")).join(" | ")');
    const [left, right] = (await names()).split(' | ');
    assert(left && right && left !== right, `two different renders: ${await names()}`);
    await click('#lbStage .lb-pane[data-side="right"] [data-rate="2"]');
    await waitFor('document.querySelectorAll("#lbStage .lb-pane[data-side=right] .rate-bar button.on").length === 2', 'the right one is rated where it stands');
    eq(await count('#lbStage .lb-pane[data-side="left"] .rate-bar button.on') < 3, true, 'the left one keeps its own rating');
    await click('#lbStage .lb-pane[data-side="right"] [data-rate="2"]');
    await waitFor('document.querySelectorAll("#lbStage .lb-pane[data-side=right] .rate-bar button.on").length === 0', 'and the rating comes off again');
    await click('#lbStage [data-pane="keep"]');
    await waitFor(`(document.querySelector('#lbStage .lb-pane[data-side="left"] img, #lbStage .lb-pane[data-side="left"] video')?.getAttribute("src")) === ${q(right)}`, '📌 Keep this one moves it to the left');
    await click('#lbInfo [data-lb="compare"]');
    await waitFor('!document.querySelector("#lbStage").classList.contains("pair")', 'back to one at a time');
    await press('Escape');
    await waitFor('document.querySelector("#lightbox").hidden', 'closed');
    await click('.tabs button[data-view="create"]');
  });

  await test('small things: odd addresses are answered properly; renders are private to this app', async () => {
    eq((await fetch(`${APP}/renders/%E0%A4%A`)).status, 404, 'an address that can\'t be read is "not found", not a server error');
    eq((await fetch(`${APP}/renders/x.png`, { headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'another website can\'t fetch your renders');
    const entry = (await (await fetch(`${APP}/api/history`)).json())[0];
    const odd = await fetch(`${APP}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ historyId: entry.id, index: 'length', workflowId: 'x' }) });
    eq(odd.status, 400, 'a take number that isn\'t a number is refused politely');
  });

  await test('the app folder is never written to', async () => {
    eq(JSON.stringify((await fs.readdir(path.join(ROOT, 'playbooks'))).sort()), JSON.stringify(Object.keys(shipped).sort()), 'no files added to or removed from playbooks/');
    for (const [f, before] of Object.entries(shipped)) eq(await fs.readFile(path.join(ROOT, 'playbooks', f), 'utf8'), before, `playbooks/${f} unchanged`);
    eq(await fileExists(path.join(ROOT, 'data')), hadLegacyData, 'no data folder appears in the app folder');
    eq(JSON.stringify((await fs.readdir(path.join(ROOT, 'chains'))).sort()), JSON.stringify(Object.keys(shippedChains).sort()), 'no files added to or removed from chains/');
    for (const [f, before] of Object.entries(shippedChains)) eq(await fs.readFile(path.join(ROOT, 'chains', f), 'utf8'), before, `chains/${f} unchanged`);
  });

  await test('character sheet: written from the picture first, every trait in every take, your edits kept', async () => {
    const send = (p, body) => fetch(`${APP}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const events = async body => (await (await send('/api/generate', body)).text()).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const img = (await (await send('/api/images', { image: `data:image/png;base64,${makePng(30, 40).toString('base64')}` })).json()).file;
    const before = mockCalls();
    let ev = await events({ modelId: 'krea-2-character', variations: 2, theme: 'at a night market', imageFile: img });
    eq(ev.find(e => e.type === 'sheet')?.text, 'Age: woman in her late twenties\nEyes: light green, almond-shaped\nHair: copper-red, shoulder-length, loose waves\nBuild: slim, narrow shoulders\nMarks: none', 'the sheet, without chatter or unseen traits');
    eq(mockCalls() - before, 3, 'one call for the sheet, one per take');
    const sheetCall = mock.log.at(-3);
    assert(JSON.stringify(sheetCall.messages).includes('image_url'), 'the Brain looks at the picture for the sheet');
    assert(JSON.stringify(mock.log.at(-1).messages).includes('CHARACTER SHEET'), 'each take is given the sheet');
    const takes = ev.filter(e => e.type === 'done').map(e => e.text);
    eq(takes.length, 2, 'two takes');
    for (const t of takes) assert(['late twenties', 'light green, almond-shaped', 'copper-red', 'narrow shoulders'].every(w => t.includes(w)), `every trait in the take: ${t}`);
    const entry = ev.find(e => e.type === 'saved').entry;
    assert(entry.characterSheet.includes('copper-red'), 'saved with the prompt');
    // The sheet you edited is used as it is: no new one is written.
    const calls = mockCalls();
    ev = await events({ modelId: 'krea-2-character', variations: 1, theme: 'on a beach', imageFile: img, characterSheet: 'Eyes: violet, round\nHair: platinum pixie cut' });
    assert(!ev.some(e => e.type === 'sheet'), 'no new sheet');
    eq(mockCalls() - calls, 1, 'only the take is written');
    const t = ev.find(e => e.type === 'done').text;
    assert(t.includes('violet, round') && t.includes('platinum pixie cut') && !t.includes('copper'), 'your traits, not the old ones');
    // MiniMax H3 Reference puts the traits in the person's line.
    ev = await events({ modelId: 'minimax-h3-ref', variations: 1, theme: 'running for a tram', imageFile: img, characterSheet: 'Eyes: violet, round' });
    assert(ev.find(e => e.type === 'done').text.includes('violet, round'), 'the trait reaches the video prompt');
    // Without a picture there's no person to keep: no sheet.
    ev = await events({ modelId: 'krea-2-character', variations: 1, theme: 'a lighthouse' });
    assert(!ev.some(e => e.type === 'sheet') && !ev.find(e => e.type === 'saved').entry.characterSheet, 'no picture, no sheet');
    // On the page: the box shows under the picture and fills in at Generate.
    await click('.model-card[data-id="krea-2-character"]');
    await setFiles('#imageInput', [fixture]);
    await waitFor('!document.querySelector(".dz-preview").hidden', 'image preview');
    assert(await visible('#sheetBlock'), 'the sheet box shows');
    eq(await value('#sheetText'), '', 'empty until Generate');
    await click('#varSeg button[data-value="1"]');
    await type('#theme', 'reading in a library');
    await click('#generateBtn');
    await genDone();
    assert((await value('#sheetText')).includes('Eyes: light green'), 'filled in from the picture');
    await click('#sheetRedo');
    eq(await value('#sheetText'), '', '↻ clears it for a fresh one');
    await click('.model-card[data-id="krea2-raw"]');
    assert(!(await visible('#sheetBlock')), 'other models have no sheet');
    await click('#imageClear');
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
