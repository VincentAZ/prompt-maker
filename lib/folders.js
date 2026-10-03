// Folders of pictures on this computer, for the assistant's jobs ("use the pictures in folder ABC").
// Read-only: it lists a folder's images and hands one over; nothing here writes or deletes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpError } from './store.js';

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
export const VIDEO_FILE = /\.(mp4|m4v|webm|mov|mkv)$/i; // motion videos (character animation)
const MAX_IMAGES = 500;

// Where a bare folder name is looked for: your home folder and the usual ones in it.
const roots = () => {
  const home = os.homedir();
  return [home, ...['Pictures', 'Desktop', 'Downloads', 'Documents', 'Videos'].map(d => path.join(home, d))];
};
const isDir = async p => (await fs.stat(p).catch(() => null))?.isDirectory() || false;
const tidy = p => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

// A folder by its full path, ~/…, or just its name (in any case), looked for in the usual places.
export async function findFolder(query) {
  let q = String(query || '').trim().replace(/^["']|["']$/g, '');
  if (!q) throw httpError(400, 'Which folder?');
  if (q === '~' || /^~[/\\]/.test(q)) q = path.join(os.homedir(), q.slice(1));
  if (path.isAbsolute(q)) {
    if (await isDir(q)) return path.resolve(q);
    throw httpError(404, `There's no folder ${tidy(q)}.`);
  }
  for (const root of roots()) if (await isDir(path.join(root, q))) return path.join(root, q);
  const want = q.toLowerCase();
  for (const root of roots()) {
    const hit = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).find(d => d.isDirectory() && d.name.toLowerCase() === want);
    if (hit) return path.join(root, hit.name);
  }
  throw httpError(404, `I can't find a folder “${query}”. I looked in ${roots().map(tidy).join(', ')}. Give its full path, e.g. ~/Pictures/${q}.`);
}

// The images in a folder (not its subfolders), in natural order: img2 before img10.
export async function listFolder(query) {
  const dir = await findFolder(query);
  const all = await fs.readdir(dir, { withFileTypes: true });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const files = all.filter(d => d.isFile() && IMAGE_FILE.test(d.name) && !d.name.startsWith('.')).sort(byName);
  const images = await Promise.all(files.slice(0, MAX_IMAGES).map(async d => {
    const full = path.join(dir, d.name);
    return { name: d.name, path: full, size: (await fs.stat(full).catch(() => ({ size: 0 }))).size };
  }));
  const folders = all.filter(d => d.isDirectory() && !d.name.startsWith('.')).sort(byName).slice(0, 50).map(d => d.name);
  const videos = all.filter(d => d.isFile() && VIDEO_FILE.test(d.name) && !d.name.startsWith('.')).sort(byName).slice(0, 200).map(d => d.name);
  return { folder: dir, shown: tidy(dir), images, more: Math.max(0, files.length - MAX_IMAGES), folders, videos };
}

// One image from a folder, for the page to load into step 3: by its full path, or a folder (as findFolder takes it)
// and the file's name in it. Only image files.
export async function imagePath(p, { folder, name, video = false } = {}) {
  const what = video ? 'video' : 'image';
  const file = folder && name ? path.join(await findFolder(folder), path.basename(String(name))) : path.resolve(String(p || ''));
  if (!(folder && name) && !path.isAbsolute(String(p || ''))) throw httpError(400, `Give the ${what}'s full path, or its folder and name.`);
  if (!(video ? VIDEO_FILE : IMAGE_FILE).test(file)) throw httpError(400, `${path.basename(file)} isn't ${video ? 'a video' : 'an image'} file.`);
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw httpError(404, `${tidy(file)} isn't there.`);
  return file;
}
