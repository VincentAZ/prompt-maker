// One-click ffmpeg set-up (Settings → Services → ⬇ Set up ffmpeg, Create's motion-video notes, and the first start
// on Windows): a static build of ffmpeg and ffprobe, fetched from the FFmpeg-Builds project on GitHub (BtbN's,
// the GPL build, since the previews and copies use libx264) into ffmpeg/ in the data folder. No password, nothing
// else on the computer touched; a system ffmpeg, when there is one, is left alone and used when this copy isn't
// there. lib/videotools.js looks here first. PM_FFMPEG_URL replaces the download link (the test suite).
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, httpError } from './store.js';
import { download, stream } from './comfy-setup.js';
import { ownBin, ownDir, ffmpegStatus, forget } from './videotools.js';

const WIN = process.platform === 'win32';
const TAR = () => process.env.PM_TAR_BIN || 'tar';
// The archive for this computer: Linux x64/arm64 as tar.xz, Windows x64/arm64 as zip (Windows' own tar unpacks zips).
function archive() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.env.PM_FFMPEG_URL) return { url: process.env.PM_FFMPEG_URL, about: 'a test build', ext: process.env.PM_FFMPEG_URL.endsWith('.zip') ? 'zip' : 'tar.xz' };
  const name = WIN ? `ffmpeg-master-latest-win${arch === 'arm64' ? 'arm64' : '64'}-gpl.zip` : `ffmpeg-master-latest-linux${arch === 'arm64' ? 'arm64' : '64'}-gpl.tar.xz`;
  return { url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${name}`, about: WIN ? 'about 200 MB' : 'about 150 MB', ext: WIN ? 'zip' : 'tar.xz' };
}

const run = (cmd, args, timeout = 20000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), missing: err?.code === 'ENOENT' }));
});

// What the dialog and Services show: whether ffmpeg is there (its own copy, or the system's), and the job if one runs.
export async function status() {
  const supported = process.platform === 'linux' || WIN;
  const st = await ffmpegStatus();
  return { supported, platform: process.platform, ok: st.ok, via: st.via, path: st.path, version: st.version, why: st.error, dir: ownDir(), about: archive().about, tar: supported ? (await run(TAR(), ['--version'])).ok : false, job: view(install.job) };
}

// Fetches the archive and unpacks its bin/ into ffmpeg/ in the data folder. One at a time; what's there is kept
// when a run fails, and a run that finds the copy in place does nothing.
export async function install() {
  if (process.platform !== 'linux' && !WIN) throw httpError(400, 'Setting up ffmpeg is for Linux and Windows for now. On macOS: brew install ffmpeg.');
  if (install.job?.state === 'running') return view(install.job);
  const job = { state: 'running', text: 'Starting…', detail: '', percent: null, startedAt: new Date().toISOString(), error: '', child: null, stopped: false };
  install.job = job;
  (async () => {
    forget();
    if ((await ffmpegStatus()).via === 'own') { job.state = 'done'; job.text = 'ffmpeg is already here.'; return; }
    const { url, about, ext } = archive();
    const dir = ownDir();
    const tmp = path.join(path.dirname(dir), `.ffmpeg-${process.pid}.${ext}`);
    const unpack = path.join(path.dirname(dir), `.ffmpeg-${process.pid}`);
    try {
      job.text = `Getting ffmpeg (${about})…`;
      await download(job, url, tmp);
      job.percent = null;
      job.text = 'Unpacking it…';
      job.detail = '';
      await fs.rm(unpack, { recursive: true, force: true });
      await fs.mkdir(unpack, { recursive: true });
      await stream(job, TAR(), ['-xf', tmp, '--strip-components=1', '-C', unpack]);
      // Only the two programs are kept, from the archive's bin/ (or its root), in bin/ of ffmpeg/ in the data folder.
      const names = ['ffmpeg', 'ffprobe'].map(n => (WIN ? `${n}.exe` : n));
      const from = (await fs.readdir(path.join(unpack, 'bin')).catch(() => null)) ? path.join(unpack, 'bin') : unpack;
      for (const n of names) if (!(await fs.stat(path.join(from, n)).catch(() => null))) throw new Error(`The archive didn't hold ${n}.`);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
      for (const n of names) await fs.copyFile(path.join(from, n), path.join(dir, 'bin', n));
      if (!WIN) for (const n of names) await fs.chmod(path.join(dir, 'bin', n), 0o755);
      for (const n of ['LICENSE.txt', 'LICENSE']) await fs.copyFile(path.join(unpack, n), path.join(dir, n)).catch(() => {}); // the GPL, as the build ships it
      forget();
      const st = await ffmpegStatus();
      if (st.via !== 'own') throw new Error(`ffmpeg was unpacked to ${dir}, but it doesn't run on this computer (${st.error || 'no version came back'}).`);
      job.state = 'done';
      job.text = `ffmpeg is set up (${st.version || 'its own copy'}, in the data folder).`;
      job.detail = '';
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
      await fs.rm(unpack, { recursive: true, force: true }).catch(() => {});
    }
  })().catch(err => {
    job.state = 'error';
    job.error = job.stopped ? 'Stopped before it finished. Set it up again any time.' : err.message;
  }).finally(() => { job.child = null; });
  return view(job);
}
install.job = null;

export function cancel() {
  const job = install.job;
  if (!job || job.state !== 'running') return view(job);
  job.stopped = true;
  if (job.child) { try { job.child.kill('SIGTERM'); } catch { /* gone */ } } else { job.state = 'error'; job.error = 'Stopped.'; }
  return view(job);
}

export const ready = async () => (await ffmpegStatus()).ok;
export const view = job => (job ? { state: job.state, text: job.text, detail: job.detail, percent: job.percent ?? null, startedAt: job.startedAt, error: job.error } : null);
export const current = () => view(install.job);
export { ownBin };
