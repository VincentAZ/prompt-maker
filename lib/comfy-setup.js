// One-click ComfyUI set-up (Settings → Services → ⬇ Set up ComfyUI, and Create's "ComfyUI isn't set up"): fetches
// ComfyUI into the data folder (or a folder you pick), makes its own Python environment with the PyTorch build for
// the graphics card, installs ComfyUI's packages and starts it. Each step is skipped when it's already done, so a
// set-up that stopped halfway (no internet, closed laptop) carries on from where it was.
//
// Linux: the Python comes from uv when it's on this computer (it fetches the Python version ComfyUI likes), else
// from the system's python3 with venv. The NVIDIA driver and Python's venv tool, when missing, are offered through
// the system's package tool behind its own password prompt (pkexec).
// Windows: its own copy of Python (python.org's embeddable build, in ComfyUI's folder, touching nothing else on the
// computer) with pip, the PyTorch build for the card (CUDA for NVIDIA, XPU for Intel Arc, else the processor's),
// ComfyUI as GitHub's archive through Windows' own tar. The first start runs it all from one screen (lib/setup.js).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DATA_DIR, httpError } from './store.js';
import { expandHome } from './folders.js';

const WIN = process.platform === 'win32';
const bin = (env, fallback) => process.env[env] || fallback;
const GIT = () => bin('PM_GIT_BIN', 'git');
const NVIDIA_SMI = () => bin('PM_NVIDIA_SMI_BIN', 'nvidia-smi');
const LSPCI = () => bin('PM_LSPCI_BIN', 'lspci');
const PKEXEC = () => bin('PM_PKEXEC_BIN', 'pkexec');
const TAR = () => bin('PM_TAR_BIN', 'tar');
const COMFY_REPO = process.env.PM_COMFY_REPO || 'https://github.com/comfyanonymous/ComfyUI.git';
const COMFY_TARBALL = process.env.PM_COMFY_TARBALL || 'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.tar.gz';
const PYTHON_WANTED = '3.12'; // what ComfyUI recommends; uv fetches it when the computer has another
// Windows: python.org's embeddable Python (a zip, no installer, nothing registered) and pip's installer.
const PYTHON_EMBED = process.env.PM_PYTHON_EMBED || 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
const GET_PIP = process.env.PM_GET_PIP || 'https://bootstrap.pypa.io/get-pip.py';
// PyTorch for each kind of graphics card. On Linux, PyPI's torch is the CUDA build, so NVIDIA needs no extra index.
const PKGS = ['torch', 'torchvision', 'torchaudio'];
const TORCH = {
  nvidia: { about: 'about 3 GB', args: PKGS },
  amd: { about: 'about 3 GB', args: [...PKGS, '--index-url', 'https://download.pytorch.org/whl/rocm6.4'] },
  cpu: { about: 'about 300 MB', args: [...PKGS, '--index-url', 'https://download.pytorch.org/whl/cpu'] },
};
// On Windows every build comes from PyTorch's own index: CUDA 13 for NVIDIA (CUDA 12.6 on a driver older than the
// 580 series, which CUDA 13 needs), XPU for Intel Arc; AMD has no PyTorch for Windows, so it gets the processor's.
const torchFor = card => {
  if (!WIN) return TORCH[card.kind] || TORCH.cpu;
  if (card.kind === 'nvidia') return { about: 'about 3 GB', args: [...PKGS, '--index-url', `https://download.pytorch.org/whl/${Number(String(card.driver).split('.')[0]) >= 580 ? 'cu130' : 'cu126'}`] };
  if (card.kind === 'intel') return { about: 'about 2 GB', args: [...PKGS, '--index-url', 'https://download.pytorch.org/whl/xpu'] };
  return { about: 'about 300 MB', args: [...PKGS, '--index-url', 'https://download.pytorch.org/whl/cpu'] };
};
// Where ComfyUI goes by default: ComfyUI/ in the data folder; on Windows, where the data folder is the usual one
// (roaming AppData), under the local AppData instead, since a 5 GB environment is nothing to roam.
export const DEFAULT_DIR = WIN && !process.env.PROMPT_MAKER_DATA
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Prompt Maker', 'ComfyUI')
  : path.join(DATA_DIR, 'ComfyUI');
const STAMP = '.prompt-maker-setup'; // written once PyTorch and ComfyUI's packages are in: the set-up is complete

const exists = p => fs.access(p).then(() => true, () => false);
const strip = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const run = (cmd, args, timeout = 20000) => new Promise(resolve => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: strip(`${stdout}${stderr}`).trim(), missing: err?.code === 'ENOENT' }));
});
const isComfyDir = async dir => (await exists(path.join(dir, 'main.py'))) && (await exists(path.join(dir, 'comfy')));
const venvPython = dir => (WIN ? path.join(dir, 'python', 'python.exe') : path.join(dir, 'venv', 'bin', 'python'));
// Set up all the way (ComfyUI, its Python, PyTorch and its packages in): what the first-start screen checks.
export const ready = async dir => (await isComfyDir(dir)) && (await exists(venvPython(dir))) && (await exists(path.join(dir, STAMP)));

// ---------- what this computer has ----------

// The graphics card: { kind: nvidia|amd|intel|cpu, name, driver } where driver is the NVIDIA driver's version, or
// null when an NVIDIA card is there without one (then the set-up offers it; on Windows, says to get it from NVIDIA).
export async function gpu() {
  const smi = await run(NVIDIA_SMI(), ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  if (smi.ok && smi.out) {
    const [name, driver] = smi.out.split('\n')[0].split(',').map(s => s.trim());
    if (name) return { kind: 'nvidia', name, driver: driver || '?' };
  }
  if (WIN) {
    // Windows knows its display adapters; the NVIDIA driver also brings nvidia-smi (looked for above), so an NVIDIA
    // card seen here only has no driver yet. Intel Arc (and the Arc in Core Ultra chips) has PyTorch's XPU build.
    const ps = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "`n"'], 30000);
    const cards = ps.out.split('\n').map(s => s.trim()).filter(Boolean);
    const nvidia = cards.find(c => /NVIDIA/i.test(c));
    const intel = cards.find(c => /Intel.*(Arc|Iris Xe)/i.test(c));
    const amd = cards.find(c => /AMD|Radeon/i.test(c));
    if (nvidia) return { kind: 'nvidia', name: nvidia, driver: null };
    if (intel) return { kind: 'intel', name: intel, driver: 'built in' };
    if (amd) return { kind: 'amd', name: amd, driver: 'built in' };
    return { kind: 'cpu', name: cards[0] || '', driver: null };
  }
  const pci = await run(LSPCI(), []);
  const cards = pci.out.split('\n').filter(l => /VGA|3D|Display/i.test(l));
  const nvidia = cards.find(l => /NVIDIA/i.test(l));
  const amd = cards.find(l => /AMD|ATI|Radeon/i.test(l));
  const tidyName = l => (l.match(/\[([^\]]+)\]\s*(?:\(rev [^)]*\))?\s*$/)?.[1] || l.split(': ').slice(1).join(': ')).trim();
  if (nvidia) return { kind: 'nvidia', name: tidyName(nvidia), driver: (await exists('/proc/driver/nvidia/version')) ? 'installed' : null };
  if (amd) return { kind: 'amd', name: tidyName(amd), driver: 'built in' };
  return { kind: 'cpu', name: cards[0] ? tidyName(cards[0]) : '', driver: null };
}

// uv, when it's on this computer (PATH, or where its installer puts it).
async function findUv() {
  if (process.env.PM_UV_BIN === 'none') return null;
  if (process.env.PM_UV_BIN) return process.env.PM_UV_BIN;
  for (const p of [path.join(os.homedir(), '.local', 'bin', 'uv'), path.join(os.homedir(), '.cargo', 'bin', 'uv')]) if (await exists(p)) return p;
  return (await run('uv', ['--version'])).ok ? 'uv' : null;
}

// The system's Python to make the environment with: ComfyUI's favourite versions first. { bin, version, venv }
// where venv says whether its venv tool works (Ubuntu ships python3 without it: python3-venv is a package).
async function findPython() {
  const names = process.env.PM_PYTHON_BIN ? [process.env.PM_PYTHON_BIN] : ['python3.12', 'python3.13', 'python3.11', 'python3.10', 'python3'];
  for (const name of names) {
    const v = await run(name, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])']);
    if (!v.ok) continue;
    const venv = (await run(name, ['-c', 'import venv, ensurepip'])).ok;
    return { bin: name, version: v.out.trim(), venv };
  }
  return null;
}

// Everything the set-up dialog shows before it starts, plus the job if one runs.
export async function status(settings) {
  if (process.platform !== 'linux' && !WIN) return { supported: false, platform: process.platform, job: view(install.job) };
  const [card, uv, python, git] = await Promise.all([gpu(), WIN ? null : findUv(), WIN ? null : findPython(), run(GIT(), ['--version'])]);
  const dir = comfyDirOf(settings);
  return {
    supported: true,
    platform: process.platform,
    dir, // where it goes: the folder from Settings → ComfyUI, else the default
    installed: (await isComfyDir(dir)) ? dir : null,
    ready: await ready(dir),
    gpu: card,
    torchAbout: torchFor(card).about,
    python: WIN ? { via: 'embedded', version: PYTHON_WANTED, ok: true } // its own copy, fetched by the set-up
      : uv ? { via: 'uv', version: PYTHON_WANTED, ok: true } : python ? { via: 'system', bin: python.bin, version: python.version, ok: python.venv, venv: python.venv } : { via: null, ok: false },
    git: git.ok,
    pkexec: !WIN && !(await run(PKEXEC(), ['--version'])).missing,
    job: view(install.job),
  };
}
// ComfyUI's folder: the one from Settings → ComfyUI, else the default.
export const comfyDirOf = settings => (path.resolve(expandHome(settings.comfyDir || '')) === path.resolve('') ? DEFAULT_DIR : path.resolve(expandHome(settings.comfyDir)));

// ---------- the root fixes: the NVIDIA driver, Python's venv tool ----------

// Ubuntu's own driver tool when there is one (it picks the right driver), else Debian's package.
async function driverCommand() {
  if ((await run('ubuntu-drivers', ['--help'])).ok) return 'ubuntu-drivers autoinstall';
  return 'apt-get update && apt-get install -y nvidia-driver firmware-misc-nonfree';
}
export const ROOT_FIXES = {
  driver: driverCommand,
  python: async () => 'apt-get update && apt-get install -y python3-venv python3-pip',
};

export async function fix(what) {
  if (process.platform !== 'linux') throw httpError(400, 'The ComfyUI set-up is for Linux for now.');
  const make = ROOT_FIXES[what];
  if (!make) throw httpError(400, 'Nothing to install by that name.');
  const cmd = await make();
  const r = await run(PKEXEC(), ['sh', '-c', cmd], 1800e3); // waits for the password prompt, then the download
  if (!r.ok) {
    const why = r.missing ? 'the system has no password prompt for this (pkexec)' : /dismissed|not authorized|cancel/i.test(r.out) ? 'the password prompt was dismissed' : r.out.split('\n').slice(-3).join(' ') || 'it failed';
    throw httpError(502, `Couldn't install it: ${why}. As an administrator, run: sudo sh -c ${JSON.stringify(cmd)}`);
  }
  return { ok: true, restart: what === 'driver', command: cmd };
}

// ---------- the set-up itself ----------

// Runs a program and streams its last line into the job (what pip is downloading, what git is doing). On Windows
// pip is asked for its plain progress lines ("Progress 1234 of 5678"), which become the job's percent.
export function stream(job, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', PIP_PROGRESS_BAR: WIN ? 'raw' : 'off', PIP_DISABLE_PIP_VERSION_CHECK: '1', UV_PYTHON_PREFERENCE: 'managed', ...opts.env } });
    job.child = child;
    let tail = '';
    const onData = d => {
      tail = (tail + strip(String(d))).slice(-4000);
      const line = tail.split(/\r|\n/).filter(l => l.trim()).pop() || ''; // progress bars redraw with a bare \r
      const progress = /Progress (\d+) of (\d+)/.exec(line);
      if (progress && Number(progress[2]) > 0) {
        job.percent = Math.round(Number(progress[1]) / Number(progress[2]) * 100);
        job.detail = `${mb(Number(progress[1]))} of ${mb(Number(progress[2]))}`;
      } else if (opts.progress) {
        const p = opts.progress(line); // the caller reads this program's own progress lines (lms get)
        if (p != null) job.percent = p;
        job.detail = line.trim().slice(0, 160);
      } else job.detail = line.trim().slice(0, 160);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => reject(err.code === 'ENOENT' ? new Error(`${cmd} isn't on this computer.`) : err));
    child.on('close', code => {
      job.child = null;
      if (job.stopped) return reject(new Error('Stopped.'));
      if (code === 0) resolve();
      else reject(new Error(tail.trim().split('\n').filter(l => l.trim()).slice(-4).join(' ').slice(0, 600) || `${cmd} exited with ${code}`));
    });
  });
}

// Where ComfyUI goes: the default, or a folder you picked (made if needed; an existing one must be empty or ComfyUI's).
async function pickDir(wanted) {
  const dir = path.resolve(expandHome(String(wanted || '').trim()) || DEFAULT_DIR);
  if (!path.isAbsolute(dir) || dir === path.parse(dir).root || dir === os.homedir()) throw httpError(400, 'Pick a folder of its own for ComfyUI, e.g. ~/ComfyUI.');
  if (await isComfyDir(dir)) return dir;
  const inside = await fs.readdir(dir).catch(err => (err.code === 'ENOENT' ? [] : null));
  if (inside === null) throw httpError(400, `Can't look into ${dir}.`);
  if (inside.length) throw httpError(400, `${dir} has other things in it. Pick an empty folder, or ComfyUI's own.`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const mb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
// Downloads url to file, the job's percent and detail following along (a progress bar's worth), stopping with the job.
export async function download(job, url, file) {
  const res = await fetch(url, { redirect: 'follow' }).catch(err => { throw new Error(`Couldn't reach ${new URL(url).host}: ${err.cause?.message || err.message}`); });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} for ${path.basename(new URL(url).pathname) || url}.`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(`${file}.part`, 'w');
  let got = 0;
  try {
    for await (const chunk of res.body) {
      if (job.stopped) throw new Error('Stopped.');
      await handle.write(chunk);
      got += chunk.length;
      job.percent = total ? Math.round(got / total * 100) : null;
      job.detail = `${mb(got)} of ${total ? mb(total) : '?'}`;
    }
  } finally {
    await handle.close();
  }
  await fs.rename(`${file}.part`, file);
}

// ComfyUI's code: git clone when git is there, else GitHub's tarball through tar (Windows has tar too).
async function fetchComfy(job, dir) {
  job.text = 'Getting ComfyUI from GitHub…';
  if ((await run(GIT(), ['--version'])).ok) {
    await fs.rm(dir, { recursive: true, force: true }); // clone wants the folder empty or absent
    await stream(job, GIT(), ['clone', '--depth', '1', '--progress', COMFY_REPO, dir]);
    return;
  }
  const tgz = path.join(path.dirname(dir), `.comfyui-${process.pid}.tar.gz`);
  await fs.mkdir(dir, { recursive: true });
  await download(job, COMFY_TARBALL, tgz);
  job.percent = null;
  try {
    await stream(job, TAR(), ['-xzf', tgz, '--strip-components=1', '-C', dir]);
  } finally {
    await fs.unlink(tgz).catch(() => {});
  }
}

// Windows: python.org's embeddable Python, unpacked into python/ in ComfyUI's folder, told to use site-packages
// (its ._pth file keeps "import site" commented out), then pip through pip's own installer. Nothing is registered
// with Windows and no other Python on the computer is touched or needed.
async function makeEmbeddedPython(job, dir) {
  const py = path.join(dir, 'python');
  if ((await exists(venvPython(dir))) && (await exists(path.join(py, 'Scripts', 'pip.exe')))) return;
  job.text = `Getting Python ${PYTHON_WANTED} (its own copy, for ComfyUI only)…`;
  const zip = path.join(dir, '.python-embed.zip');
  await download(job, PYTHON_EMBED, zip);
  job.percent = null;
  await fs.rm(py, { recursive: true, force: true });
  await fs.mkdir(py, { recursive: true });
  await stream(job, TAR(), ['-xf', zip, '-C', py]);
  await fs.unlink(zip).catch(() => {});
  const pth = (await fs.readdir(py)).find(f => /^python\d+\._pth$/i.test(f));
  if (!pth) throw new Error("The Python archive didn't hold what was expected (no ._pth file).");
  // The ._pth file is the whole module path: add ComfyUI's folder (.. from python\), as ComfyUI's portable build
  // does, or main.py can't import its own packages; and "import site", for pip's site-packages.
  const text = await fs.readFile(path.join(py, pth), 'utf8');
  await fs.writeFile(path.join(py, pth), text.replace(/^#\s*import site\s*$/m, '..\nimport site'));
  job.text = 'Getting pip, which installs PyTorch and ComfyUI\'s packages…';
  const getPip = path.join(py, 'get-pip.py');
  await download(job, GET_PIP, getPip);
  job.percent = null;
  await stream(job, venvPython(dir), [getPip, '--no-warn-script-location'], { cwd: py });
  await fs.unlink(getPip).catch(() => {});
}

// The environment: venv/ inside ComfyUI's folder, from uv (with Python 3.12) or the system's python3.
async function makeVenv(job, dir) {
  if (WIN) return makeEmbeddedPython(job, dir);
  const venv = path.join(dir, 'venv');
  if (await exists(venvPython(dir))) return;
  const uv = await findUv();
  if (uv) {
    job.text = `Making its own Python ${PYTHON_WANTED} environment…`;
    await stream(job, uv, ['venv', '--python', PYTHON_WANTED, '--seed', venv], { cwd: dir });
    return;
  }
  const py = await findPython();
  if (!py) throw new Error('No Python on this computer. Install python3 and python3-venv with the system\'s package tool, then try again.');
  if (!py.venv) throw new Error("Python's environment tool is missing (python3-venv). Install it with the button above, then try again.");
  job.text = `Making its own Python ${py.version} environment…`;
  await stream(job, py.bin, ['-m', 'venv', venv]);
  if (!(await exists(venvPython(dir)))) throw new Error('The Python environment didn\'t get made.');
}

const pipInstall = (job, dir, args) => stream(job, venvPython(dir), ['-m', 'pip', 'install', ...args], { cwd: dir });
const hasModule = async (dir, mod) => (await run(venvPython(dir), ['-c', `import ${mod}`], 60000)).ok;

// One set-up at a time. The job: { state: running|done|error, text (the step, in plain words), detail (the last
// line of what runs), percent (of the download under way, or null), dir, startedAt, error }. Everything already
// there is skipped, so a retry picks up where it was.
export async function install(settings, { dir: wanted, start } = {}) {
  if (process.platform !== 'linux' && !WIN) throw httpError(400, 'The one-click set-up is for Linux and Windows for now. On macOS, install ComfyUI Desktop from comfy.org, then enter its folder in Settings → ComfyUI.');
  if (install.job?.state === 'running') return install.job;
  const dir = await pickDir(wanted || settings.comfyDir);
  const job = { state: 'running', text: 'Starting…', detail: '', percent: null, dir, startedAt: new Date().toISOString(), error: '', child: null, stopped: false };
  install.job = job;
  (async () => {
    const card = await gpu();
    if (!(await isComfyDir(dir))) await fetchComfy(job, dir);
    job.percent = null;
    await makeVenv(job, dir);
    job.percent = null;
    const torch = torchFor(card);
    if (!(await hasModule(dir, 'torch'))) {
      job.text = `Fetching PyTorch for ${card.kind === 'cpu' || (WIN && card.kind === 'amd') ? 'the processor' : `your ${card.name || card.kind.toUpperCase()} card`} (${torch.about}; this is the long part)…`;
      await pipInstall(job, dir, torch.args);
    }
    job.percent = null;
    job.text = "Installing ComfyUI's packages…";
    await pipInstall(job, dir, ['-r', 'requirements.txt']);
    await fs.writeFile(path.join(dir, STAMP), JSON.stringify({ torch: card.kind, at: new Date().toISOString() }));
    job.percent = null;
    job.text = 'Starting ComfyUI…';
    job.detail = '';
    await start(dir);
    job.state = 'done';
    job.text = 'ComfyUI is set up and starting.';
  })().catch(err => {
    job.state = 'error';
    job.error = job.stopped ? 'Stopped before it finished. Set it up again any time: it carries on from where it was.' : err.message;
  }).finally(() => { job.child = null; });
  return view(job);
}
install.job = null;

// Stops a running set-up (the step that runs is killed; what's done stays for next time).
export function cancel() {
  const job = install.job;
  if (!job || job.state !== 'running') return view(job);
  job.stopped = true;
  if (job.child) { try { job.child.kill('SIGTERM'); } catch { /* gone */ } } else { job.state = 'error'; job.error = 'Stopped.'; }
  return view(job);
}

// The job without its process handle.
export const view = job => (job ? { state: job.state, text: job.text, detail: job.detail, percent: job.percent ?? null, dir: job.dir, startedAt: job.startedAt, error: job.error } : null);
export const current = () => view(install.job);
