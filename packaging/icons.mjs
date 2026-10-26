// Renders every bitmap app icon from public/icon.svg with the browser's SVG renderer, then rebuilds the Windows
// .ico. Keeping one vector source prevents a bad intermediate resize from reaching browser tabs, docks or desktops.
// Usage: node packaging/icons.mjs   (CHROME_BIN=/path/to/chrome when it is not google-chrome)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const sizes = [16, 32, 48, 64, 128, 256, 512];
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-maker-icons-'));
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(50);
    port = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').then(t => Number(t.split(/\r?\n/)[0]), () => 0);
  }
  if (!port) throw new Error('Chrome did not open its icon-rendering page.');
  const target = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).then(list => list.find(t => t.type === 'page'));
  if (!target) throw new Error('Chrome opened without a page target.');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const cdp = new Cdp(ws);
  const source = await fs.readFile(path.join(ROOT, 'public', 'icon.svg'), 'utf8');
  const expression = `(async () => {
    const source = ${JSON.stringify(source)};
    const url = 'data:image/svg+xml;base64,' + btoa(source);
    return Promise.all(${JSON.stringify(sizes)}.map(size => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('Could not read the SVG icon'));
      image.src = url;
    })));
  })()`;
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  await Promise.all(result.result.value.map((data, i) => fs.writeFile(
    path.join(ROOT, 'public', 'icons', `prompt-maker-${sizes[i]}.png`), Buffer.from(data.split(',')[1], 'base64'),
  )));
  ws.close();
  await new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'packaging', 'windows', 'ico.mjs')], err => err ? reject(err) : resolve()));
  console.log(`Rendered ${sizes.map(n => `${n}px`).join(', ')} PNGs and prompt-maker.ico from public/icon.svg.`);
} finally {
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill();
  await Promise.race([stopped, sleep(2000)]);
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
