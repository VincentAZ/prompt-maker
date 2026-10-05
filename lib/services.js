// Starting and stopping what Prompt Maker works with, from its own page (Settings → Services): LM Studio's
// server, ComfyUI, and Prompt Maker itself. Linux is done; the Windows and macOS parts are marked (roadmap P1/P2).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { httpError } from './store.js';

const SYSTEMCTL = () => process.env.SYSTEMCTL_BIN || 'systemctl';
const SYSTEMD_RUN = () => process.env.SYSTEMD_RUN_BIN || 'systemd-run';
const COMFY_UNIT = 'prompt-maker-comfyui.service'; // ComfyUI, when Prompt Maker started it
const lmsBin = () => process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');
const exists = p => fs.access(p).then(() => true, () => false);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(bin, args, timeout = 60000) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({
      ok: !err,
      out: `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim(),
      missing: err?.code === 'ENOENT',
    }));
  });
}
const lastLine = out => out.split('\n').filter(Boolean).pop() || '';

export const isLocalUrl = url => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/i.test(String(url || '').trim());
function portOf(url) {
  const u = new URL(url);
  return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
}

// ---------- LM Studio ----------

// Unloads every model (frees the GPU), then turns the server off.
export async function stopLmStudio() {
  const unload = await run(lmsBin(), ['unload', '--all']);
  if (unload.missing) throw httpError(502, 'Could not find LM Studio\'s "lms" tool. Quit LM Studio from its own window instead.');
  const stop = await run(lmsBin(), ['server', 'stop']);
  if (!stop.ok) throw httpError(502, `LM Studio didn't stop: ${lastLine(stop.out)}`);
}

// ---------- ComfyUI ----------

// Its Python: the folder's own virtual environment (or the Windows portable build's), else the system's.
async function findPython(dir) {
  const candidates = process.platform === 'win32'
    ? [path.join(dir, '..', 'python_embeded', 'python.exe'), path.join(dir, 'venv', 'Scripts', 'python.exe'), path.join(dir, '.venv', 'Scripts', 'python.exe')]
    : [path.join(dir, 'venv', 'bin', 'python'), path.join(dir, '.venv', 'bin', 'python')];
  for (const c of candidates) if (await exists(c)) return c;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const isComfyDir = async dir => (await exists(path.join(dir, 'main.py'))) && (await exists(path.join(dir, 'comfy')));

// A ComfyUI folder in one of the usual places.
async function findComfyDir() {
  const home = os.homedir();
  const places = ['ComfyUI', 'Apps/ComfyUI', 'apps/ComfyUI', 'AI/ComfyUI', 'ai/ComfyUI', 'comfy/ComfyUI', 'Documents/ComfyUI',
    'src/ComfyUI', 'git/ComfyUI', 'Repos/ComfyUI', 'ComfyUI_windows_portable/ComfyUI', 'Desktop/ComfyUI_windows_portable/ComfyUI'];
  for (const p of places) if (await isComfyDir(path.join(home, p))) return path.join(home, p);
  return null;
}

// What listens on a port on Windows, as { pid, cmd } (its command line), or null. From PowerShell's answer.
export function parseWindowsListener(out) {
  try {
    const p = JSON.parse(out.slice(out.indexOf('{')));
    return Number(p.pid) > 0 ? { pid: Number(p.pid), cmd: String(p.cmd || '') } : null;
  } catch {
    return null;
  }
}
async function windowsListener(port) {
  const script = `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; @{ pid = $p.ProcessId; cmd = $p.CommandLine } | ConvertTo-Json -Compress }`;
  return parseWindowsListener((await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 20000)).out);
}
// Stops a program and everything it started (Windows).
const killTree = pid => run('taskkill', ['/PID', String(pid), '/T', '/F'], 20000);

// The ComfyUI running on this port, if any, and how it was started: { pid, dir, python, pre, args } on Linux,
// { pid } on Windows (enough to stop it). Anything on the port that isn't ComfyUI's main.py is left alone.
export async function comfyProcess(url) {
  if (!isLocalUrl(url)) return null;
  if (process.platform === 'win32') {
    const p = await windowsListener(portOf(url));
    return p && /(^|[\s\\/"'])main\.py(\s|"|'|$)/.test(p.cmd) ? { pid: p.pid } : null;
  }
  if (process.platform !== 'linux') return null;
  const ss = await run('ss', ['-ltnpH', `sport = :${portOf(url)}`]);
  const pid = Number(/pid=(\d+)/.exec(ss.out)?.[1]);
  if (!pid) return null;
  try {
    const cmd = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    const at = cmd.findIndex(a => /(^|[/\\])main\.py$/.test(a));
    if (at < 1) return null;
    const cwd = await fs.readlink(`/proc/${pid}/cwd`);
    const dir = path.dirname(path.resolve(cwd, cmd[at]));
    let python = cmd[0];
    if (!path.isAbsolute(python)) {
      const venv = /(?:^|\0)VIRTUAL_ENV=([^\0]+)/.exec(await fs.readFile(`/proc/${pid}/environ`, 'utf8').catch(() => ''))?.[1];
      python = venv ? path.join(venv, 'bin', 'python') : await findPython(dir);
    }
    return { pid, dir, python, pre: cmd.slice(1, at), args: cmd.slice(at + 1) };
  } catch {
    return null; // not ours to look at
  }
}

const splitArgs = s => (String(s || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map(a => a.replace(/^(["'])(.*)\1$/, '$2'));

// How Prompt Maker would start ComfyUI: { dir, python, pre, args, from } where from says where that came from:
// 'set' (Settings), 'learned' (how you last ran it), 'found' (a usual place) or null (no ComfyUI found).
export async function comfyLaunch(settings) {
  const learned = settings.comfyLaunch?.dir ? settings.comfyLaunch : null;
  const dir = settings.comfyDir || learned?.dir || (await findComfyDir());
  if (!dir) return { dir: null, python: null, pre: [], args: [], from: null };
  const sameAsLearned = learned && path.resolve(learned.dir) === path.resolve(dir);
  const port = portOf(settings.comfyUrl);
  const args = settings.comfyArgs ? splitArgs(settings.comfyArgs)
    : sameAsLearned ? learned.args
    : ['--listen', '127.0.0.1', '--port', String(port), '--preview-method', 'auto'];
  return {
    dir,
    python: (sameAsLearned && learned.python) || (await findPython(dir)),
    pre: sameAsLearned ? learned.pre || [] : [],
    args: args.includes('--port') || port === 8188 ? args : [...args, '--port', String(port)],
    from: settings.comfyDir || settings.comfyArgs ? 'set' : sameAsLearned ? 'learned' : 'found',
  };
}

async function comfyUnitActive() {
  if (process.platform !== 'linux') return false;
  return lastLine((await run(SYSTEMCTL(), ['--user', 'is-active', COMFY_UNIT])).out) === 'active';
}

let comfyChild = null; // ComfyUI started without systemd (other platforms): its process

// Starts ComfyUI in the background, on its own: it keeps running if Prompt Maker restarts. Doesn't wait for it to
// be ready (that takes from a few seconds to a minute); the page watches for it.
export async function startComfy(settings) {
  if (!isLocalUrl(settings.comfyUrl)) throw httpError(400, 'Can only start ComfyUI on this computer. Start it on the other machine instead.');
  const launch = await comfyLaunch(settings);
  if (!launch.dir) throw httpError(400, "Couldn't find ComfyUI on this computer. Enter its folder in Settings → ComfyUI.");
  if (!(await isComfyDir(launch.dir))) throw httpError(400, `"${launch.dir}" doesn't look like a ComfyUI folder (no main.py). Check the folder in Settings → ComfyUI.`);
  const argv = [...launch.pre, 'main.py', ...launch.args];
  if (process.platform === 'linux' && !(await run(SYSTEMD_RUN(), ['--version'])).missing) {
    if (await comfyUnitActive()) return launch; // already starting
    await run(SYSTEMCTL(), ['--user', 'reset-failed', COMFY_UNIT]);
    const r = await run(SYSTEMD_RUN(), ['--user', `--unit=${COMFY_UNIT}`, '--collect', `--working-directory=${launch.dir}`,
      '--setenv=PYTHONUNBUFFERED=1', '--', launch.python, ...argv]);
    if (!r.ok) throw httpError(502, `ComfyUI didn't start: ${lastLine(r.out)}`);
  } else {
    const child = spawn(launch.python, argv, { cwd: launch.dir, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    comfyChild = child;
  }
  return launch;
}

// Stops ComfyUI however it was started: by Prompt Maker, or by you (in a terminal, Linux). Waits until it's gone.
export async function stopComfy(settings, isUp) {
  if (await comfyUnitActive()) await run(SYSTEMCTL(), ['--user', 'stop', COMFY_UNIT]);
  else if (comfyChild && comfyChild.exitCode === null) { if (process.platform === 'win32') await killTree(comfyChild.pid); else comfyChild.kill(); } else {
    const proc = await comfyProcess(settings.comfyUrl);
    if (!proc) {
      if (await isUp()) throw httpError(400, 'ComfyUI is running, but not as a program Prompt Maker can stop. Close it where you started it.');
      return;
    }
    if (process.platform === 'win32') await killTree(proc.pid); else process.kill(proc.pid, 'SIGTERM');
  }
  for (let i = 0; i < 30 && (await isUp()); i++) await sleep(500);
  // Said plainly, instead of "stopped" while it still holds the GPU.
  if (await isUp()) throw httpError(502, 'ComfyUI is still running: it didn\'t stop when asked. Close it where you started it.');
}

// ---------- Prompt Maker ----------

// Stops this server. Under its service it stops the service (else it would come straight back), in a moment,
// so the answer to this request still goes out.
export async function stopApp() {
  const main = await run(SYSTEMCTL(), ['--user', 'show', '-p', 'MainPID', '--value', 'prompt-maker.service']);
  setTimeout(() => {
    if (Number(main.out) === process.pid) spawn(SYSTEMCTL(), ['--user', 'stop', 'prompt-maker.service'], { detached: true, stdio: 'ignore' }).unref();
    else process.exit(0);
  }, 300);
}

// Whether this server runs as the start-with-the-computer service.
export async function underService() {
  if (process.platform !== 'linux') return false;
  return Number((await run(SYSTEMCTL(), ['--user', 'show', '-p', 'MainPID', '--value', 'prompt-maker.service'])).out) === process.pid;
}

export { comfyUnitActive };
