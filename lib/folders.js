// Folders of pictures on this computer, for the assistant's jobs ("use the pictures in folder ABC").
// Read-only: it finds folders, lists a folder's images and hands one over; nothing here writes or deletes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpError, getSettings, RENDERS_DIR, IMAGES_DIR, VIDEOS_DIR } from './store.js';

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
export const VIDEO_FILE = /\.(mp4|m4v|webm|mov|mkv)$/i; // motion videos (character animation)
const MAX_IMAGES = 500;

// Where a bare folder name is looked for first: your home folder and the usual ones in it.
const roots = () => {
  const home = os.homedir();
  return [home, ...['Pictures', 'Desktop', 'Downloads', 'Documents', 'Videos'].map(d => path.join(home, d))];
};
const isDir = async p => (await fs.stat(p).catch(() => null))?.isDirectory() || false;
export const tidy = p => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
export const expandHome = p => (p === '~' || /^~[/\\]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// Other drives: USB sticks, a second disk, network shares that are mounted (or C:, D:, … on Windows).
export async function drives() {
  const user = os.userInfo().username;
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`);
    return (await Promise.all(letters.map(async d => ((await isDir(d)) ? d : null)))).filter(Boolean);
  }
  const parents = process.platform === 'darwin' ? ['/Volumes'] : [`/media/${user}`, `/run/media/${user}`, '/mnt', '/media'];
  const out = [];
  for (const parent of parents) {
    for (const d of await fs.readdir(parent, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(parent, d.name);
      if (d.isDirectory() && full !== `/media/${user}` && !out.includes(full)) out.push(full);
    }
  }
  return out;
}

// How well a file or folder's name fits what was asked, 0 (not at all) to 3 (the same name): "renderings" fits
// "renders" (same word), "Hermes" fits "Hermes ImgVid Agents" (part of it).
const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const stem = s => { const n = norm(s); const t = n.replace(/(ings|ing|es|s)$/, ''); return t.length >= 3 ? t : n; };
export function nameFit(name, query) {
  const a = norm(name);
  const b = norm(query);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (stem(name) === stem(query)) return 2;
  return Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)) ? 1 : 0;
}

// Folders nobody means: program code, caches, system folders.
const SKIP = new Set(['node_modules', '__pycache__', 'site-packages', 'venv', '.venv', 'proc', 'sys', 'dev', 'snap', 'Windows', '$Recycle.Bin', 'System Volume Information', 'AppData', 'Library']);

// Files or folders whose name fits the query, anywhere in your home folder and on your other drives, best first.
// kind: 'folder', 'file' or 'any'. Gives up after a few seconds on a very big disk, with what it found so far.
export async function search(query, { kind = 'folder', limit = 20, seconds = 6, from = null } = {}) {
  const q = String(query || '').trim();
  if (!q) throw httpError(400, 'What should I look for?');
  const hidden = q.startsWith('.');
  const start = from ? [path.resolve(expandHome(from))] : [os.homedir(), ...(await drives())];
  const until = Date.now() + seconds * 1000;
  const hits = [];
  const seen = new Set();
  let queue = start.map(dir => ({ dir, depth: 0 }));
  let finished = true;
  while (queue.length) {
    const next = [];
    for (const { dir, depth } of queue) {
      if (Date.now() > until) { finished = false; break; }
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if ((d.name.startsWith('.') && !hidden) || SKIP.has(d.name)) continue;
        const full = path.join(dir, d.name);
        const isFolder = d.isDirectory();
        const fit = nameFit(d.name, q);
        if (fit && (kind === 'any' || (kind === 'folder') === isFolder)) hits.push({ path: full, shown: tidy(full), folder: isFolder, fit, depth });
        if (isFolder && depth < 8) next.push({ dir: full, depth: depth + 1 });
      }
    }
    if (!finished) break;
    queue = next;
  }
  hits.sort((a, b) => b.fit - a.fit || a.depth - b.depth);
  return { found: hits.slice(0, limit), more: Math.max(0, hits.length - limit), finished, looked_in: start.map(tidy) };
}

// Prompt Maker's own folders and ComfyUI's output, looked at before anything else: "my renders" is most likely these.
async function appPlaces() {
  const s = await getSettings().catch(() => ({}));
  const comfy = [s.comfyOutputDir, s.comfyDir && path.join(s.comfyDir, 'output'), s.comfyLaunch?.dir && path.join(s.comfyLaunch.dir, 'output')].filter(Boolean);
  return [RENDERS_DIR, IMAGES_DIR, VIDEOS_DIR, ...comfy];
}

// A folder by its full path, ~/…, or just its name (in any case, or close to it: "renderings" finds "renders"):
// first Prompt Maker's and ComfyUI's folders and the usual places, then your whole home folder and other drives.
// Returns { dir, others } (others: more folders that fit, best first).
export async function locateFolder(query) {
  const q = expandHome(String(query || '').trim().replace(/^["']|["']$/g, ''));
  if (!q) throw httpError(400, 'Which folder?');
  if (path.isAbsolute(q)) {
    if (await isDir(q)) return { dir: path.resolve(q), others: [] };
    // A path that's slightly off (~/Hermes when it's in ~/Documents): the folder by that name, wherever it is.
    const found = await locateFolder(path.basename(q)).catch(() => null);
    if (found) return { ...found, missing: tidy(q) };
    throw httpError(404, `There's no folder ${tidy(q)}, nor one called “${path.basename(q)}” in your home folder or on your other drives.`);
  }
  if (/[/\\]/.test(q)) for (const root of roots()) if (await isDir(path.join(root, q))) return { dir: path.join(root, q), others: [] };
  const near = [];
  for (const place of await appPlaces()) if (nameFit(path.basename(place), q) && (await isDir(place))) near.push({ path: place, fit: nameFit(path.basename(place), q) });
  for (const root of roots()) {
    for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      const fit = d.isDirectory() && !d.name.startsWith('.') && nameFit(d.name, q);
      if (fit) near.push({ path: path.join(root, d.name), fit });
    }
  }
  const exact = near.filter(x => x.fit === 3);
  const deep = exact.length ? [] : (await search(q, { kind: 'folder', limit: 10 })).found;
  const all = [...near, ...deep].sort((a, b) => b.fit - a.fit).map(x => x.path).filter((p, i, list) => list.indexOf(p) === i);
  if (all.length) return { dir: all[0], others: all.slice(1, 8) };
  throw httpError(404, `I can't find a folder like “${query}” in your home folder${(await drives()).length ? ' or on your other drives' : ''}. Give its full path, e.g. ~/Pictures/${q}.`);
}

export const findFolder = async query => (await locateFolder(query)).dir;

// The images in a folder (not its subfolders), in natural order: img2 before img10.
export async function listFolder(query) {
  const { dir, others, missing } = await locateFolder(query);
  const all = await fs.readdir(dir, { withFileTypes: true });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const files = all.filter(d => d.isFile() && IMAGE_FILE.test(d.name) && !d.name.startsWith('.')).sort(byName);
  const images = await Promise.all(files.slice(0, MAX_IMAGES).map(async d => {
    const full = path.join(dir, d.name);
    return { name: d.name, path: full, size: (await fs.stat(full).catch(() => ({ size: 0 }))).size };
  }));
  const folders = all.filter(d => d.isDirectory() && !d.name.startsWith('.')).sort(byName).slice(0, 50).map(d => d.name);
  const videos = all.filter(d => d.isFile() && VIDEO_FILE.test(d.name) && !d.name.startsWith('.')).sort(byName).slice(0, 200).map(d => d.name);
  const note = [missing && `There's no folder ${missing}: this is the one by that name.`, dir === RENDERS_DIR && 'This is where Prompt Maker keeps every render it made: look_at with what "gallery" (and find) shows them with their prompts.'].filter(Boolean).join(' ') || undefined;
  return { folder: dir, shown: tidy(dir), images, more: Math.max(0, files.length - MAX_IMAGES), folders, videos, ...(others.length ? { others: others.map(tidy) } : {}), ...(note ? { note } : {}) };
}

// One image from a folder, for the page to load into step 3: by its full path, or a folder (as findFolder takes it)
// and the file's name in it. Only image files.
export async function imagePath(p, { folder, name, video = false } = {}) {
  const what = video ? 'video' : 'image';
  const given = expandHome(String(p || ''));
  const file = folder && name ? path.join(await findFolder(folder), path.basename(String(name))) : path.resolve(given);
  if (!(folder && name) && !path.isAbsolute(given)) throw httpError(400, `Give the ${what}'s full path, or its folder and name.`);
  if (!(video ? VIDEO_FILE : IMAGE_FILE).test(file)) throw httpError(400, `${path.basename(file)} isn't ${video ? 'a video' : 'an image'} file.`);
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw httpError(404, `${tidy(file)} isn't there.`);
  return file;
}
