// The first start on Windows sets everything up from one screen (the page's "Setting up Prompt Maker"), with
// nothing to type and nothing usable behind it until it's done: ComfyUI in its own folder with its own Python and
// the PyTorch build for the graphics card (lib/comfy-setup.js), LM Studio through its own installer run quietly
// (for this user, no password), and a Brain that can see (Qwen3-VL, fetched by LM Studio's own lms tool). Each
// part is skipped when it's already there, so a set-up that stopped (no internet, the laptop closed) carries on
// from where it was. Linux keeps its ComfyUI dialog for now: status() says supported: false there.
// PM_NO_FIRST_SETUP=1 switches it off (the test suite, the installer's check: never a 5 GB download there).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as comfySetup from './comfy-setup.js';
import { comfyLog } from './services.js';
import { listLlms, startServer } from './lmstudio.js';
import { httpError } from './store.js';

const WIN = process.platform === 'win32';
const LMS_INSTALLER = process.env.PM_LMS_INSTALLER || 'https://lmstudio.ai/download/latest/win32/x64'; // LM Studio's own "latest" link
const lmsApp = () => process.env.PM_LMS_APP || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'LM Studio', 'LM Studio.exe');
const lmsBin = () => process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio', 'bin', WIN ? 'lms.exe' : 'lms');
// The Brain: Qwen3-VL, which reads pictures, at a size the computer's memory can take (LM Studio picks the quant).
export const brainFor = () => process.env.PM_FIRST_BRAIN || (os.totalmem() >= 20e9 ? 'qwen/qwen3-vl-8b' : 'qwen/qwen3-vl-4b');

export const STEPS = [
  { id: 'comfy', name: 'ComfyUI', what: 'the free program that makes the pictures and videos, with its own Python and PyTorch for your graphics card' },
  { id: 'lms', name: 'LM Studio', what: 'the free program that runs the Brain' },
  { id: 'brain', name: 'A Brain that can see', what: 'Qwen3-VL, which looks at your pictures and writes your prompts' },
];

const exists = p => fs.access(p).then(() => true, () => false);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, timeout = 60000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim(), missing: err?.code === 'ENOENT' }));
});
const off = () => !WIN || process.env.PM_NO_FIRST_SETUP === '1';

const lmsReady = () => exists(lmsBin());
// A Brain that sees: asked of LM Studio's server when it's up, else of lms (which wakes LM Studio's service).
async function brainReady(settings) {
  try { return (await listLlms(settings.lmStudioUrl)).some(m => m.vision); } catch { /* the server is off */ }
  if (!(await lmsReady())) return false;
  const r = await run(lmsBin(), ['ls', '--json'], 120000);
  try { return JSON.parse(r.out.slice(r.out.indexOf('['))).some(m => m.type === 'llm' && m.vision); } catch { return false; }
}

// What the screen shows before and while it runs: each part, done or not, and the job.
export async function status(settings) {
  if (off()) return { supported: false, needed: false, job: view(start.job) };
  const dir = comfySetup.comfyDirOf(settings);
  const [comfy, lms] = await Promise.all([comfySetup.ready(dir), lmsReady()]);
  const brain = lms && (await brainReady(settings));
  const done = { comfy, lms, brain };
  const steps = STEPS.map(s => ({ ...s, done: done[s.id] }));
  return { supported: true, needed: steps.some(s => !s.done), steps, dir, gpu: await comfySetup.gpu(), brain: brainFor(), job: view(start.job) };
}

// Mirrors the ComfyUI set-up's job into this one until it ends.
async function follow(job) {
  for (;;) {
    const c = comfySetup.current();
    if (!c) throw new Error("The ComfyUI set-up didn't start.");
    job.text = c.text;
    job.detail = c.detail;
    job.percent = c.percent;
    if (c.state === 'done') return;
    if (c.state === 'error') throw new Error(c.error);
    await sleep(500);
  }
}

// ComfyUI, once started, has to answer before the part counts as done: it can die at once, and the screen would
// say "all set" over a ComfyUI that isn't there. Its log says why. One cause is handled here: Windows' Smart App
// Control refuses a freshly written file the first time it's loaded (its verdict comes from the cloud and arrives
// late; seen with scipy's) and lets the same file through a moment later, so that case gets a second start.
async function waitComfy(job, settings, startComfy, dir) {
  const up = () => fetch(new URL('/system_stats', settings.comfyUrl), { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
  const alive = async () => (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*main.py*' }).Count`], 30000)).out.trim() !== '0';
  for (let attempt = 1; attempt <= 3; attempt++) {
    job.text = attempt === 1 ? 'Starting ComfyUI (up to a minute or two)…' : `Starting ComfyUI again (try ${attempt} of 3)…`;
    job.detail = '';
    job.percent = null;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      if (await up()) { job.detail = ''; return; }
      if (i % 5 === 4 && !(await alive())) break; // it died: its log says why
    }
    const log = await fs.readFile(comfyLog(), 'utf8').catch(() => '');
    const tail = log.trim().split(/\r?\n/).filter(l => l.trim()).pop() || 'no output';
    if (/Application Control policy has blocked/i.test(log) && attempt < 3) {
      job.detail = "Windows' Smart App Control refused one of its files the first time; waiting for its verdict, then starting again…";
      await sleep(20000);
      await startComfy(dir);
      continue;
    }
    throw new Error(`ComfyUI didn't start: ${tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 300)}. Its log is ${comfyLog()}.`);
  }
}

// LM Studio: its installer, run quietly for this user; then LM Studio opened once, since that is what puts its lms
// tool in the home folder (and registers the install), and closed again. From then on lms runs LM Studio's service
// in the background with no window, and the app talks to that.
async function installLmStudio(job) {
  if (!(await exists(lmsApp()))) {
    job.text = 'Downloading LM Studio…';
    const file = path.join(os.tmpdir(), 'LM-Studio-setup.exe');
    await comfySetup.download(job, LMS_INSTALLER, file);
    job.percent = null;
    job.text = 'Installing LM Studio (for your user only, no password needed)…';
    job.detail = '';
    const r = await run(file, ['/S', '/currentuser'], 900000);
    await fs.unlink(file).catch(() => {});
    if (!r.ok) throw new Error(`LM Studio's installer didn't finish: ${r.out.split('\n').pop() || 'it exited with an error'}.`);
    if (!(await exists(lmsApp()))) throw new Error(`LM Studio didn't land where expected (${lmsApp()}).`);
  }
  if (await lmsReady()) return;
  job.text = 'Opening LM Studio once, so its lms tool gets set up (it closes again by itself)…';
  job.detail = '';
  const app = spawn(lmsApp(), [], { detached: true, stdio: 'ignore' });
  app.on('error', () => {});
  app.unref();
  for (let i = 0; i < 120 && !(await lmsReady()); i++) await sleep(1000);
  await sleep(5000); // let it finish writing its first-run files
  await run('taskkill', ['/IM', 'LM Studio.exe', '/F'], 30000);
  if (!(await lmsReady())) throw new Error("LM Studio is installed, but its lms tool didn't appear in your home folder. Open LM Studio once yourself, close it, then press Try again.");
}

// The Brain, through lms get (LM Studio's own downloader, which picks the quant for this computer).
async function getBrain(job, settings) {
  const brain = brainFor();
  job.text = `Getting the Brain, ${brain} (about ${/8b/.test(brain) ? 6 : 3} GB; the last long part)…`;
  job.detail = '';
  job.percent = null;
  await comfySetup.stream(job, lmsBin(), ['get', brain, '-y'], {
    progress: line => {
      const pct = /(\d+(?:\.\d+)?)\s*%/.exec(line);
      return pct ? Math.min(100, Math.round(Number(pct[1]))) : null;
    },
  });
  job.percent = null;
  if (!(await brainReady(settings))) throw new Error(`${brain} was downloaded, but LM Studio doesn't list it as a Brain that can see. Open LM Studio to look, then press Try again.`);
}

// Runs it all, one part after the other, skipping what's there. startComfy(dir): what starts ComfyUI once it's in.
export async function start(settings, { startComfy }) {
  if (off()) throw httpError(400, 'The first-start set-up is for Windows for now.');
  if (start.job?.state === 'running') return view(start.job);
  const job = { state: 'running', step: null, steps: Object.fromEntries(STEPS.map(s => [s.id, 'todo'])), text: 'Starting…', detail: '', percent: null, error: '', startedAt: new Date().toISOString() };
  start.job = job;
  (async () => {
    const dir = comfySetup.comfyDirOf(settings);
    job.step = 'comfy';
    if (await comfySetup.ready(dir)) job.steps.comfy = 'done';
    else {
      job.steps.comfy = 'running';
      if (comfySetup.current()?.state !== 'running') await comfySetup.install(settings, { dir, start: startComfy });
      await follow(job);
      await waitComfy(job, settings, startComfy, dir);
      job.steps.comfy = 'done';
    }
    job.step = 'lms';
    job.steps.lms = 'running';
    await installLmStudio(job);
    job.steps.lms = 'done';
    job.step = 'brain';
    job.steps.brain = 'running';
    job.text = "Starting LM Studio's server…";
    job.detail = '';
    await startServer(settings.lmStudioUrl).catch(() => {}); // the download works without it; the check below says
    if (!(await brainReady(settings))) await getBrain(job, settings);
    job.steps.brain = 'done';
    job.step = null;
    job.state = 'done';
    job.text = 'All set.';
    job.detail = '';
  })().catch(err => {
    job.state = 'error';
    job.error = err.message;
    if (job.step) job.steps[job.step] = 'error';
  });
  return view(job);
}
start.job = null;

export const view = job => (job ? { state: job.state, step: job.step, steps: { ...job.steps }, text: job.text, detail: job.detail, percent: job.percent ?? null, error: job.error, startedAt: job.startedAt } : null);
export const current = () => view(start.job);
