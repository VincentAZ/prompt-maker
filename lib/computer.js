// The assistant using this computer beyond Prompt Maker (Settings → ✦ Assistant → 💻 Let the assistant use my
// computer): run commands and programs, read and write any file. Off unless the user switches it on; server.js
// checks that before every call. The page asks the user before anything that deletes or replaces a file.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpError } from './store.js';
import { expandHome, tidy } from './folders.js';

const MAX_OUTPUT = 12000; // characters of a command's output the Brain gets back (its end, where errors are)
const MAX_READ = 20000; // characters of a file per read

const full = p => {
  const s = expandHome(String(p || '').trim().replace(/^["']|["']$/g, ''));
  if (!s) throw httpError(400, 'Which file? Give its full path.');
  return path.resolve(os.homedir(), s);
};

// bash with your own PATH (from your login profile), or PowerShell on Windows.
const shell = command => (process.platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
  : [/bash|zsh/.test(process.env.SHELL || '') ? process.env.SHELL : '/bin/bash', ['-lc', command]]);

const tail = s => (s.length > MAX_OUTPUT ? `…(${s.length - MAX_OUTPUT} characters cut)…\n${s.slice(-MAX_OUTPUT)}` : s);

// Runs a command and waits for it (up to seconds). A program it starts in the background (`gimp &`, `xdg-open`)
// keeps running after; one still going when time is up is stopped. Nothing can be typed into it. Its output goes
// to a file rather than a pipe, so a program left running in the background isn't stopped by a closed pipe.
export async function run(command, { folder, seconds = 60 } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw httpError(400, 'What should I run?');
  const limit = Math.min(Math.max(Number(seconds) || 60, 1), 600);
  const cwd = folder ? full(folder) : os.homedir();
  if (!(await fs.stat(cwd).catch(() => null))?.isDirectory()) throw httpError(404, `There's no folder ${tidy(cwd)}.`);
  const log = path.join(os.tmpdir(), `prompt-maker-run-${process.pid}-${Date.now()}.log`);
  const handle = await fs.open(log, 'w');
  const [exe, args] = shell(cmd);
  const started = Date.now();
  let timedOut = false;
  const { code, error } = await new Promise(resolve => {
    const child = spawn(exe, args, { cwd, stdio: ['ignore', handle.fd, handle.fd], detached: process.platform !== 'win32', windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }, limit * 1000);
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, error: err.message }); });
    child.on('exit', c => { clearTimeout(timer); resolve({ code: c }); });
  });
  await handle.close();
  const out = (await fs.readFile(log, 'utf8').catch(() => '')).trim();
  await fs.unlink(log).catch(() => {});
  return {
    command: cmd, folder: tidy(cwd), exit_code: code, seconds: Math.round((Date.now() - started) / 100) / 10,
    output: tail(out) || '(no output)',
    ...(timedOut ? { stopped: `Still running after ${limit} s, so it was stopped. Give more seconds, or start it in the background.` } : {}),
    ...(error ? { error } : {}),
  };
}

// A file's text (or what's in a folder), from its full path or ~/…
export async function read(p, { from = 0 } = {}) {
  const file = full(p);
  const st = await fs.stat(file).catch(() => null);
  if (!st) throw httpError(404, `${tidy(file)} isn't there.`);
  if (st.isDirectory()) {
    const all = await fs.readdir(file, { withFileTypes: true }).catch(err => { throw httpError(403, `Can't open ${tidy(file)}: ${err.code || err.message}`); });
    const names = all.map(d => (d.isDirectory() ? `${d.name}/` : d.name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { path: tidy(file), folder: true, items: names.slice(0, 400), ...(names.length > 400 ? { more: names.length - 400 } : {}) };
  }
  const handle = await fs.open(file, 'r').catch(err => { throw httpError(403, `Can't open ${tidy(file)}: ${err.code || err.message}`); });
  try {
    const start = Math.max(0, Math.floor(Number(from) || 0));
    const buf = Buffer.alloc(Math.min(MAX_READ * 4, Math.max(0, st.size - start)));
    await handle.read(buf, 0, buf.length, start);
    if (buf.subarray(0, 8000).includes(0)) return { path: tidy(file), size: st.size, binary: true, note: 'Not a text file: open it with a program (run_command), or with look_at if it\'s a picture or video.' };
    const shown = buf.toString('utf8').slice(0, MAX_READ);
    const next = start + Buffer.byteLength(shown);
    return { path: tidy(file), size: st.size, text: shown, ...(next < st.size ? { more_from: next } : {}) };
  } finally {
    await handle.close();
  }
}

// Writes text to a file (making its folder if needed). An existing file is only replaced with overwrite: the page
// asks the user first.
export async function write(p, text, { append = false, overwrite = false } = {}) {
  const file = full(p);
  const st = await fs.stat(file).catch(() => null);
  if (st?.isDirectory()) throw httpError(400, `${tidy(file)} is a folder.`);
  if (st && !append && !overwrite) throw httpError(409, `${tidy(file)} is already there.`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = String(text ?? '');
  await (append ? fs.appendFile(file, body) : fs.writeFile(file, body));
  return { path: tidy(file), bytes: Buffer.byteLength(body), ...(st ? (append ? { appended: true } : { replaced: true }) : { created: true }) };
}
