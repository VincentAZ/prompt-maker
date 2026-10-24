// ⬆ Getting a newer Prompt Maker from Settings, without a terminal. Four kinds of copy:
//   git      cloned from GitHub: `git fetch` says what's new, `git pull --ff-only` gets it.
//   deb      installed from the .deb (/opt/prompt-maker): the newest release's .deb is downloaded and installed
//            behind the system's own password prompt (pkexec).
//   windows  installed with the Windows installer (the app beside its own node folder and the uninstaller): the
//            newest release's installer is downloaded and run silently once this copy has stopped; it puts the new
//            files in and starts Prompt Maker again. Per-user, so no password.
//   folder   a downloaded zip: nothing can be done in place, so it points at the releases page.
// Nothing here touches the internet until the person clicks Check: Prompt Maker is offline by default.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DATA_DIR, httpError } from './store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const GIT = () => process.env.PM_GIT_BIN || 'git';
const PKEXEC = () => process.env.PM_PKEXEC_BIN || 'pkexec';
const REPO = process.env.PM_UPDATE_REPO || 'VincentAZ/prompt-maker';
const FEED = () => process.env.PM_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const exists = p => fs.access(p).then(() => true, () => false);
function run(bin, args, { cwd = ROOT, timeout = 120000 } = {}) {
  return new Promise(resolve => {
    execFile(bin, args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), missing: err?.code === 'ENOENT' }));
  });
}
const parseVersion = v => (String(v || '').match(/\d+(?:\.\d+){1,3}/) || [''])[0];
export function newer(a, b) { // a is newer than b
  const x = parseVersion(a).split('.').map(Number), y = parseVersion(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export async function current() {
  return JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
}

// Which kind of copy this is.
export async function how() {
  if (ROOT.startsWith('/opt/prompt-maker')) return 'deb';
  if (process.platform === 'win32' && await exists(path.join(ROOT, '..', 'node', 'node.exe')) && await exists(path.join(ROOT, '..', 'unins000.exe'))) return 'windows';
  if (await exists(path.join(ROOT, '.git'))) return 'git';
  return 'folder';
}

export async function status() {
  return { how: await how(), current: await current(), releases: RELEASES_PAGE };
}

// Asks GitHub (or the git remote) what the newest version is. Only on a click.
export async function check() {
  const kind = await how();
  const now = await current();
  if (kind === 'git') {
    const fetched = await run(GIT(), ['fetch', '--quiet', 'origin', 'main']);
    if (!fetched.ok) throw httpError(502, fetched.missing ? 'git isn\'t installed on this computer, so this copy can\'t check for updates.' : `Couldn't reach GitHub: ${fetched.out.split('\n').pop() || 'no answer'}.`);
    const shown = await run(GIT(), ['show', 'origin/main:package.json']);
    if (!shown.ok) throw httpError(502, `Couldn't read the newest version: ${shown.out.split('\n').pop()}`);
    const latest = JSON.parse(shown.out).version;
    const behind = (await run(GIT(), ['rev-list', '--count', 'HEAD..origin/main'])).out;
    return { how: kind, current: now, latest, newer: newer(latest, now) || Number(behind) > 0, commitsBehind: Number(behind) || 0 };
  }
  const res = await fetch(FEED(), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'prompt-maker' }, signal: AbortSignal.timeout(20000) }).catch(err => { throw httpError(502, `Couldn't reach GitHub: ${err.message}`); });
  if (!res.ok) throw httpError(502, `GitHub answered ${res.status} when asked for the newest release.`);
  const rel = await res.json();
  const latest = parseVersion(rel.tag_name || rel.name);
  const wanted = kind === 'windows' ? /-setup\.exe$/i : /\.deb$/i;
  const asset = (rel.assets || []).find(a => wanted.test(a.name || ''));
  return { how: kind, current: now, latest, newer: newer(latest, now), ...(asset ? { asset: { name: asset.name, url: asset.browser_download_url, size: asset.size } } : {}), page: rel.html_url || RELEASES_PAGE };
}

// Downloads a release file into dir; the path it landed at.
async function download(asset, dir) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, asset.name.replace(/[^\w.-]/g, '_'));
  const res = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(600000) }).catch(err => { throw httpError(502, `The download failed: ${err.message}`); });
  if (!res.ok) throw httpError(502, `The download failed: GitHub answered ${res.status}.`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// Runs the downloaded Windows installer, silently: it stops this copy if it still runs, puts the new files in and
// starts Prompt Maker again. The server calls it once its answer is out and the session is closed.
export function runInstaller(file) {
  spawn(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Gets the newer version in place (git, deb, windows). Resolves with what happened; a restart finishes it (on
// Windows the installer does the restart: the answer says so, with the installer's path for the server to run).
let applying = null;
export function apply(onStatus = () => {}) {
  if (applying) return applying;
  applying = (async () => {
    const kind = await how();
    if (kind === 'git') {
      onStatus('Getting the newest version from GitHub…');
      const r = await run(GIT(), ['pull', '--ff-only', 'origin', 'main']);
      if (!r.ok) throw httpError(500, /local changes|would be overwritten|not possible to fast-forward|diverg/i.test(r.out) ? 'This copy has changes of its own, so the update can\'t be put over them. Set them aside (git stash) or get a fresh copy.' : `The update didn't go through: ${r.out.split('\n').pop() || 'git pull failed'}`);
      return { how: kind, version: await current(), restart: true };
    }
    if (kind === 'deb') {
      const info = await check();
      if (!info.asset) throw httpError(404, 'The newest release has no .deb package yet.');
      onStatus(`Downloading ${info.asset.name}…`);
      const file = await download(info.asset, DATA_DIR);
      onStatus('Installing (the system asks for your password)…');
      let r = await run(PKEXEC(), ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', file], { timeout: 600000 });
      if (!r.ok && !r.missing && !/dismissed|not authorized|cancel/i.test(r.out)) r = await run(PKEXEC(), ['/usr/bin/dpkg', '-i', file], { timeout: 600000 });
      await fs.rm(file, { force: true });
      if (!r.ok) throw httpError(500, r.missing ? 'The system has no password prompt for this (pkexec), so the package can\'t be installed from here. Double-click the .deb from the releases page instead.' : /dismissed|not authorized|cancel/i.test(r.out) ? 'The password prompt was dismissed, so nothing was installed.' : `The install didn't go through: ${r.out.split('\n').slice(-2).join(' ')}`);
      return { how: kind, version: info.latest, restart: true };
    }
    if (kind === 'windows') {
      const info = await check();
      if (!info.asset) throw httpError(404, 'The newest release has no Windows installer yet.');
      onStatus(`Downloading ${info.asset.name}…`);
      // The system's temp folder, not the session folder: the installer outlives this copy and the session.
      const file = await download(info.asset, os.tmpdir());
      return { how: kind, version: info.latest, restart: 'installer', installer: file };
    }
    throw httpError(400, `This copy was downloaded as a folder, so it can't update itself. Get the newest version from ${RELEASES_PAGE} and replace the folder (your work is in the data folder, not here).`);
  })().finally(() => { applying = null; });
  return applying;
}
