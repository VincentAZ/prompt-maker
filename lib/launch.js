// The Windows launcher's helper (start.bat): starts Prompt Maker in the background, with no window of its own, and
// opens it as its own app window, so nobody keeps a terminal open. Linux has start.sh and a service for this.
//   node lib/launch.js open    start Prompt Maker if it isn't running, then open it (what the Start menu entry does)
//   node lib/launch.js start   start it if it isn't running, and open nothing (the Startup entry at sign-in, the
//                              installer, and the page's Start button: the page reconnects on its own)
// The server runs on this Node (the one that came with the installer, or the one on this computer), detached and
// hidden, and what it prints goes nowhere: to see it, run "node server.js" in a terminal instead.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT) || 5317;
const URL = `http://127.0.0.1:${PORT}`;
// The data folder, as lib/store.js picks it on Windows (not imported: it sets the folder up as a side effect).
const DATA = process.env.PROMPT_MAKER_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Prompt Maker');
const exists = p => fs.access(p).then(() => true, () => false);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (bin, args) => new Promise(resolve => execFile(bin, args, { timeout: 30000, windowsHide: true }, (err, out, errOut) => resolve({ ok: !err, out: `${out}${errOut}` })));

export const running = () => fetch(`${URL}/api/settings`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);

// LM Studio's local server, on, when LM Studio is installed and it's off (as start.sh does). Never blocks the start.
async function startLmStudio() {
  const lms = process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio', 'bin', 'lms.exe');
  if (!(await exists(lms))) return;
  const st = await run(lms, ['server', 'status']);
  if (/not running/i.test(st.out)) await run(lms, ['server', 'start']);
}

// Starts the server, detached and hidden, and waits for it to answer (up to a minute). True once it does.
export async function start() {
  if (await running()) return true;
  await startLmStudio();
  spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await running()) return true;
  }
  return false;
}

// The browsers that do app windows, in the order start.sh tries them (Edge last: it's on every Windows, so the
// window always opens as a window). PM_BROWSER=<path> forces one; PM_BROWSER=default opens a tab in the usual browser.
const browsers = () => {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Chromium', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
};
async function findBrowser() {
  if (process.env.PM_BROWSER) return process.env.PM_BROWSER === 'default' ? null : process.env.PM_BROWSER;
  for (const b of browsers()) if (await exists(b)) return b;
  return null;
}

// Opens the page as its own app window, with its own browser profile in the data folder, so it behaves like a
// desktop app. Without a Chromium-family browser, a tab in the default one.
export async function open() {
  const bin = await findBrowser();
  if (!bin) {
    spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'default';
  }
  const profile = path.join(DATA, 'browser');
  await fs.mkdir(profile, { recursive: true });
  spawn(bin, [`--app=${URL}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-component-update', '--disable-sync'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return bin;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cmd = process.argv[2] || 'open';
  if (!(await start())) {
    console.error('Prompt Maker didn\'t start. Run "node server.js" in this folder to see why.');
    process.exit(1);
  }
  if (cmd === 'open') await open();
  console.log(`Prompt Maker is running at ${URL}`);
}
