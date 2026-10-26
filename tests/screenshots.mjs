// Takes the guide's screenshots (docs/screenshots): sharp 1760x1100, no prompt text on screen.
// Needs two running copies of the app and Chrome (google-chrome) on this machine:
//   DEMO  (port 5320): an isolated folder with approved sample renders, empty prompts and seed 0.
//         Start it with PORT=5320 PROMPT_MAKER_DATA=<folder> node server.js
//   CLEAN (port 5321): an empty data folder, isolated XDG_CONFIG_HOME/XDG_DATA_HOME, and service commands disabled.
//   Override DEMO, CLEAN and CDP_PORT for other local ports, CHROME_DIR for the browser profile. No conversation is generated for the Ask screenshot.
// Then:  node tests/screenshots.mjs create gallery models voices comfy-setup lms-setup model-files hugging-face ask   (pngs go to OUT, default /tmp/promptmaker-demo/shots)
// Look at every picture before it ships: no prompts or personal names. Models shows the chooser, not example prompts.
// shots.mjs: sharp 1760x1100 screenshots of the running demo apps, no prompt text on screen.
// usage: node shots.mjs <name>...   (names: create gallery models voices comfy-setup lms-setup model-files ask)
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/promptmaker-demo/shots';
const DEMO = process.env.DEMO || 'http://127.0.0.1:5320'; // scrubbed demonstration data only
const CLEAN = process.env.CLEAN || 'http://127.0.0.1:5321'; // empty data folder
const sleep = ms => new Promise(r => setTimeout(r, ms));
await fs.mkdir(OUT, { recursive: true });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.on = {};
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const { res, rej } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
  }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return new Cdp(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
}

const PORT = Number(process.env.CDP_PORT) || 9333;
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.CHROME_DIR || '/tmp/promptmaker-demo/chrome'}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*', '--window-size=1760,1100', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 60 && !target; i++) { await sleep(150); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).then(l => l.find(t => t.type === 'page')).catch(() => null); }
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await Promise.all(['Page.enable', 'Runtime.enable'].map(m => cdp.send(m)));
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1100, deviceScaleFactor: 1, mobile: false });
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const js = async expr => { const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const shot = async (name, clip) => { await js("if (document.querySelector('#theme')) document.querySelector('#theme').placeholder = 'Describe your idea…'"); const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { x: 0, y: 0, width: 1760, height: clip, scale: 1 } } : {}) }); await fs.writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64')); console.log('saved', name); };
const open = async (url, assistant = false) => {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await cdp.send('Page.navigate', { url });
  await sleep(1500);
  await js(`localStorage.setItem('pm.assistantOpen', ${JSON.stringify(String(assistant))}); localStorage.setItem('pm.deleteWarned','true'); localStorage.setItem('pm.uiTheme', JSON.stringify('sage'))`);
  await cdp.send('Page.reload');
  await sleep(3500);
  await js(`document.querySelector('#theme').placeholder = 'Describe your idea…'; 1`);
};

// show only pictures, a bit smaller so more of them fit
const clickBtn = (re) => js(`(() => { const vis = e => e.offsetParent; const b = [...document.querySelectorAll('button')].find(b => ${re}.test(b.textContent) && vis(b)); b?.click(); return !!b; })()`);
const pictures = async size => {
  await clickBtn('/^\\s*(📷\\s*)?Images\\s*$/'); await sleep(500);
  await clickBtn('/^\\s*★ & up\\s*$/'); await sleep(500);
  await js(`(() => { const r = [...document.querySelectorAll('input[aria-label="Picture size"]')].find(e => e.offsetParent); if (r) { r.value = ${size}; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); } return !!r; })()`);
};

const steps = {
  async create() {
    await open(`${DEMO}/#create`);
    await js(`[...document.querySelectorAll('.model-card')].find(e => e.textContent.includes('Krea 2 RAW') && !e.textContent.includes('Edit'))?.click(); 1`);
    await sleep(1200);
    await js(`document.querySelector('#theme').value=''; document.querySelector('#theme').dispatchEvent(new Event('input',{bubbles:true})); 1`);
    await js("document.querySelector('#tabRenders').click(); 1");
    await pictures(240);
    await js(`document.querySelector('#modelGuide').open = false; document.querySelector('#modelChoice').open = false; document.querySelector('.director-steps').scrollTop = 0; 1`);
    await sleep(1200); await shot('create');
  },
  async ['fine-tune']() {
    await open(`${DEMO}/#create`);
    await js("document.querySelector('#openCreateOptions').click(); 1");
    await sleep(1000); await shot('fine-tune');
  },
  async gallery() {
    await open(`${DEMO}/#gallery`);
    await pictures(210);
    await sleep(1800); await shot('gallery');
  },
  async ask() {
    await open(`${DEMO}/#gallery`, true);
    await pictures(190);
    // Show the optional entry point without saving a conversation or exposing prompts.
    await sleep(800); await shot('ask');
  },
  async ['prompt-sets']() {
    await open(`${DEMO}/#settings`);
    await js("document.querySelector('[data-settings-tab=instructions]').click(); document.querySelector('#addPromptSet').click(); 1");
    await sleep(700); await shot('prompt-sets');
  },
  async models() { await open(`${DEMO}/#models`); await sleep(1500); await shot('models'); },
  async voices() { await open(`${DEMO}/#voices`); await js("document.querySelector('#vDesc').value = ''; document.querySelector('#vText').value = ''; 1"); await sleep(1500); await shot('voices'); },
  async themes() { await open(`${DEMO}/#create`); await js("document.querySelector('#uiThemeButton').click(); document.querySelector('[data-ui-theme-choice=midnight]').click(); document.querySelector('#uiThemeButton').click(); 1"); await sleep(700); await shot('themes'); },
  async ['comfy-setup']() {
    await open(`${CLEAN}/#settings`);
    await js(`document.querySelector('[data-act="comfy-setup"]')?.click(); 1`);
    await sleep(2500); await shot('comfy-setup');
  },
  // LM Studio not on the computer (the CLEAN copy's LMS_BIN points nowhere): what the set-up offers.
  async ['lms-setup']() {
    await open(`${CLEAN}/#settings`);
    await js(`document.querySelector('[data-act="lms-setup"]')?.click(); 1`);
    await sleep(2500); await shot('lms-setup');
  },
  // Every model's files (the DEMO copy has each model's starter workflows); sizes come from Hugging Face.
  async ['model-files']() {
    await open(`${DEMO}/#models`);
    await js(`document.querySelector('#catalogFiles').click(); 1`);
    await sleep(6000); await shot('model-files');
  },
  async ['hugging-face']() {
    await open(`${DEMO}/#models`);
    await js(`document.querySelector('#catalogFiles').click(); 1`);
    await sleep(6000);
    await js(`document.querySelector('#mfHf [data-act="mf-hf-on"]')?.click(); 1`);
    await sleep(700); await shot('hugging-face');
  },
};
for (const n of process.argv.slice(2)) { if (steps[n]) await steps[n](); else console.log('unknown', n); }
chrome.kill();
process.exit(0);
