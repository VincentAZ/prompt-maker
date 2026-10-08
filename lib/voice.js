// 🎙 Voices: speech made on this computer with Qwen3-TTS. Describe a voice once and keep it by name; then any line of
// text is said in that voice (a sound file a video model like MiniMax H3 takes as its soundtrack).
//
// It runs with ComfyUI's Python (the one Prompt Maker would start ComfyUI with), plus a few packages of its own in
// the data folder (voice/site, on PYTHONPATH): ComfyUI's packages are never changed, so it can't break ComfyUI.
// The models live in voice/hf (Hugging Face's cache, kept there with HF_HOME) and work offline once fetched.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { comfyLaunch } from './services.js';

const { httpError } = store;
export const VOICE_DIR = path.join(store.DATA_DIR, 'voice');
const SITE = path.join(VOICE_DIR, 'site');
const HF = path.join(VOICE_DIR, 'hf');
const VOICES_FILE = path.join(VOICE_DIR, 'voices.json');
export const CLIPS_DIR = path.join(VOICE_DIR, 'clips'); // kept voices' sample clips, and every line said
const WORKER = process.env.PROMPT_MAKER_VOICE_WORKER || path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice', 'worker.py');
const PACKAGES = ['qwen-tts==0.1.1', 'transformers==4.57.3', 'accelerate==1.12.0', 'huggingface_hub==0.36.2', 'sox==1.5.0'];
const MODELS = { design: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', base: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base' };
const MODELS_BYTES = 9.2e9; // about, for the progress bar before the worker says the real total
const IDLE_MS = 90e3; // the worker (and the graphics memory it holds) goes after this long unused
export const LANGUAGES = ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'];
export const CLIP_NAME = /^[a-f0-9]{16}\.wav$/;
const clipName = () => `${crypto.randomBytes(8).toString('hex')}.wav`;

const exists = p => fs.access(p).then(() => true, () => false);

// ---------- what's installed ----------

async function pythonFor(settings) {
  if (process.env.PROMPT_MAKER_VOICE_PYTHON) return process.env.PROMPT_MAKER_VOICE_PYTHON; // the tests' stand-in
  const launch = await comfyLaunch(settings);
  return launch.python || (process.platform === 'win32' ? 'python' : 'python3');
}

const packagesInstalled = () => exists(path.join(SITE, 'qwen_tts', '__init__.py'));
// Both models fetched: their snapshot folders are there and no download is half done.
async function modelsInstalled() {
  for (const repo of Object.values(MODELS)) {
    const dir = path.join(HF, 'hub', `models--${repo.replace('/', '--')}`);
    const snaps = await fs.readdir(path.join(dir, 'snapshots')).catch(() => []);
    if (!snaps.length) return false;
    const blobs = await fs.readdir(path.join(dir, 'blobs')).catch(() => []);
    if (blobs.some(b => b.endsWith('.incomplete'))) return false;
  }
  return true;
}

export async function status(settings) {
  const [packages, models] = await Promise.all([packagesInstalled(), modelsInstalled()]);
  return { installed: packages && models, packages, models, installing: install.job && install.job.state === 'running' ? install.job : null, python: await pythonFor(settings), languages: LANGUAGES, gigabytes: Math.round(MODELS_BYTES / 1e8) / 10 };
}

// ---------- installing: the packages, then the models ----------

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', reject);
  child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(out.trim().split('\n').slice(-6).join('\n') || `${cmd} exited with ${code}`))));
});

// One install at a time. The job: { state: running|done|error, phase: packages|models, received, total, error }.
export async function install(settings) {
  if (install.job?.state === 'running') return install.job;
  const job = { state: 'running', phase: 'packages', received: 0, total: MODELS_BYTES, error: '', startedAt: new Date().toISOString() };
  install.job = job;
  (async () => {
    const python = await pythonFor(settings);
    await fs.mkdir(VOICE_DIR, { recursive: true });
    await fs.mkdir(CLIPS_DIR, { recursive: true });
    if (!(await packagesInstalled())) {
      try {
        await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--target', SITE, '--no-deps', ...PACKAGES], { timeout: 1800e3 });
      } catch (err) {
        throw new Error(`Couldn't install the voice packages with ${python}: ${err.message}`);
      }
      if (!(await packagesInstalled())) throw new Error(`The voice packages didn't install (with ${python}).`);
    }
    job.phase = 'models';
    if (!(await modelsInstalled())) {
      await worker(settings).request({ op: 'fetch' }, p => { job.received = p.received; job.total = p.total || job.total; });
    }
    job.received = job.total;
    job.state = 'done';
  })().catch(err => { job.state = 'error'; job.error = err.message; });
  return job;
}
install.job = null;

// ---------- the worker: one Python process, requests one after another, gone after a while idle ----------

let current = null;
function worker(settings) {
  if (current && !current.dead) return current;
  const w = { dead: false, queue: Promise.resolve(), child: null, pending: new Map(), idle: null, settings };
  current = w;
  const start = async () => {
    const python = await pythonFor(settings);
    const env = { ...process.env, PYTHONPATH: SITE, PYTHONUNBUFFERED: '1', HF_HOME: HF, HF_HUB_ETAG_TIMEOUT: '5', HF_HUB_DISABLE_TELEMETRY: '1', PM_VOICE_DESIGN: MODELS.design, PM_VOICE_BASE: MODELS.base };
    w.child = spawn(python, [WORKER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let errTail = '';
    w.child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    readline.createInterface({ input: w.child.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = w.pending.get(msg.id ?? w.pending.keys().next().value);
      if (!p) return;
      if (msg.progress) return p.onProgress?.(msg.progress);
      w.pending.delete(p.id);
      if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'The voice worker failed.'));
    });
    w.child.on('close', code => {
      w.dead = true;
      if (current === w) current = null;
      const why = code === 0 || code === null ? 'The voice worker stopped.' : `The voice worker stopped (exit ${code}): ${errTail.trim().split('\n').slice(-4).join(' ').slice(0, 500)}`;
      for (const p of w.pending.values()) p.reject(new Error(why));
      w.pending.clear();
    });
    w.child.on('error', err => { w.dead = true; if (current === w) current = null; for (const p of w.pending.values()) p.reject(err); w.pending.clear(); });
  };
  const started = start();
  let n = 0;
  w.request = (req, onProgress) => {
    const job = w.queue.then(async () => {
      await started;
      if (w.dead) throw new Error('The voice worker stopped before it could start.');
      clearTimeout(w.idle);
      const id = ++n;
      return new Promise((resolve, reject) => {
        w.pending.set(id, { id, resolve, reject, onProgress });
        w.child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
      });
    });
    w.queue = job.catch(() => {}).finally(() => { clearTimeout(w.idle); w.idle = setTimeout(() => stop(w), IDLE_MS); });
    return job;
  };
  return w;
}
function stop(w) {
  if (!w || w.dead) return;
  w.dead = true;
  if (current === w) current = null;
  try { w.child?.stdin.end(); } catch {}
  setTimeout(() => { try { w.child?.kill(); } catch {} }, 5000).unref();
}
export const stopWorker = () => stop(current);

async function ready(settings) {
  const s = await status(settings);
  if (!s.installed) throw httpError(409, s.packages ? 'The voice models aren\'t fetched yet: 🎙 Voices → Install voices.' : 'Voices aren\'t installed yet: 🎙 Voices → Install voices.');
}

// ---------- voices and lines ----------

const cleanText = s => String(s || '').replace(/\s+/g, ' ').trim();
const language = l => (LANGUAGES.includes(l) && l !== 'Auto' ? l : null);

export async function listVoices() {
  const list = JSON.parse(await fs.readFile(VOICES_FILE, 'utf8').catch(() => '[]'));
  return Array.isArray(list) ? list : [];
}
async function saveVoices(list) {
  await fs.mkdir(VOICE_DIR, { recursive: true });
  await fs.writeFile(VOICES_FILE, JSON.stringify(list, null, 2) + '\n');
}
export async function findVoice(idOrName) {
  const list = await listVoices();
  const s = String(idOrName || '').trim().toLowerCase();
  return list.find(v => v.id === s) || list.find(v => v.name.toLowerCase() === s) || list.find(v => v.name.toLowerCase().includes(s)) || null;
}

// A new voice from a description, saying the sample text: a clip to listen to (kept only when you keep the voice).
export async function design(settings, { description, text, language: lang }) {
  await ready(settings);
  const instruct = cleanText(description).slice(0, 600);
  const say = cleanText(text).slice(0, 400);
  if (!instruct) throw httpError(400, 'Describe the voice first.');
  if (!say) throw httpError(400, 'Give it a sentence to say.');
  await fs.mkdir(CLIPS_DIR, { recursive: true });
  const file = clipName();
  const r = await worker(settings).request({ op: 'design', instruct, text: say, language: language(lang), out: path.join(CLIPS_DIR, file) });
  return { file, seconds: r.seconds, took: r.took };
}

// Keeps a designed voice by name: its clip is the reference every line is said from.
export async function keepVoice({ name, description, text, file, language: lang }) {
  const list = await listVoices();
  const clean = cleanText(name).slice(0, 60);
  if (!clean) throw httpError(400, 'Give the voice a name.');
  if (!CLIP_NAME.test(String(file || '')) || !(await exists(path.join(CLIPS_DIR, file)))) throw httpError(400, 'Hear the voice first, then keep it.');
  if (list.some(v => v.name.toLowerCase() === clean.toLowerCase())) throw httpError(400, `There's already a voice called “${clean}”.`);
  const voice = { id: crypto.randomBytes(6).toString('hex'), name: clean, description: cleanText(description).slice(0, 600), text: cleanText(text).slice(0, 400), file, language: language(lang) || 'Auto', createdAt: new Date().toISOString() };
  list.push(voice);
  await saveVoices(list);
  return voice;
}

export async function renameVoice(id, name) {
  const list = await listVoices();
  const v = list.find(x => x.id === id);
  if (!v) throw httpError(404, 'No such voice.');
  const clean = cleanText(name).slice(0, 60);
  if (!clean) throw httpError(400, 'Give the voice a name.');
  if (list.some(x => x !== v && x.name.toLowerCase() === clean.toLowerCase())) throw httpError(400, `There's already a voice called “${clean}”.`);
  v.name = clean;
  await saveVoices(list);
  return v;
}

export async function deleteVoice(id) {
  const list = await listVoices();
  const v = list.find(x => x.id === id);
  if (!v) throw httpError(404, 'No such voice.');
  await saveVoices(list.filter(x => x !== v));
  await store.shredFile(path.join(CLIPS_DIR, v.file)).catch(() => {});
  return v;
}

// A line of text said in a kept voice: { file, seconds }. The clip stays in voice/clips (sweepClips tidies).
export async function say(settings, { voice: which, text, language: lang }) {
  await ready(settings);
  const voice = await findVoice(which);
  if (!voice) throw httpError(404, which ? `No voice like “${which}”. The voices are: ${(await listVoices()).map(v => v.name).join(', ') || 'none yet'}.` : 'Pick a voice.');
  const line = cleanText(text).slice(0, 600);
  if (!line) throw httpError(400, 'Give it a line to say.');
  if (!(await exists(path.join(CLIPS_DIR, voice.file)))) throw httpError(409, `The voice “${voice.name}” lost its sample clip. Make it again.`);
  await fs.mkdir(CLIPS_DIR, { recursive: true });
  const file = clipName();
  const r = await worker(settings).request({ op: 'say', ref: path.join(CLIPS_DIR, voice.file), ref_text: voice.text, text: line, language: language(lang) || language(voice.language), out: path.join(CLIPS_DIR, file) });
  return { file, seconds: r.seconds, took: r.took, voice: { id: voice.id, name: voice.name } };
}

export const clipPath = file => (CLIP_NAME.test(String(file || '')) ? path.join(CLIPS_DIR, file) : null);

// Clips no voice and no History entry refers to any more, older than an hour, are removed.
export async function sweepClips(inUse) {
  const keep = new Set([...(await listVoices()).map(v => v.file), ...inUse]);
  for (const f of await fs.readdir(CLIPS_DIR).catch(() => [])) {
    if (!CLIP_NAME.test(f) || keep.has(f)) continue;
    const st = await fs.stat(path.join(CLIPS_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 3600e3) await store.shredFile(path.join(CLIPS_DIR, f)).catch(() => {});
  }
}

// The clip of a deleted entry's line is shredded, unless another entry says the same clip (inUse) or it's a kept
// voice's own sample.
export async function forgetLine(file, inUse = []) {
  if (!CLIP_NAME.test(String(file || '')) || inUse.includes(file)) return false;
  if ((await listVoices()).some(v => v.file === file)) return false;
  return store.shredFile(path.join(CLIPS_DIR, file));
}
