// What a render file says about itself. ComfyUI writes its whole job into every file it saves (the prompt word for
// word, the model, LoRA and other file names, the seed and settings): a PNG in a "prompt" text chunk, a video in its
// tags, a WebP in its EXIF. Anyone given the file could read the prompt. Prompt Maker's copy keeps one thing: which
// model made it, the way Civitai reads it when the model is one it knows (see civitai.js), else the model's name.
// The pixels and frames are untouched (a video is copied, not encoded again).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { shredFile } from './store.js';
import * as videotools from './videotools.js';
import { renderTags } from './civitai.js';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Latin-1 only in a PNG tEXt chunk: anything else becomes "?".
const latin1 = s => Buffer.from(String(s).replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), 'latin1');

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

// A PNG's tEXt chunk `key` (ComfyUI's job is "prompt"), or null.
export function pngText(buf, key) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  for (let i = 8; i + 12 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    if (buf.toString('latin1', i + 4, i + 8) === 'tEXt') {
      const data = buf.subarray(i + 8, i + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0 && data.toString('latin1', 0, nul) === key) return data.toString('latin1', nul + 1);
    }
    i += 12 + len;
  }
  return null;
}

// A PNG without its text and EXIF chunks, with a tEXt chunk for each of `tags` before the end. null if it isn't one.
export function cleanPng(buf, tags = {}) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const parts = [PNG_SIG];
  for (let i = 8; i + 12 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return null;
    if (type === 'IEND') for (const [k, v] of Object.entries(tags)) parts.push(pngChunk('tEXt', Buffer.concat([latin1(k), Buffer.from([0]), latin1(v)])));
    if (!PNG_TEXT.has(type)) parts.push(buf.subarray(i, end));
    if (type === 'IEND') return Buffer.concat(parts);
    i = end;
  }
  return null;
}

// A WebP without its EXIF and XMP chunks (where ComfyUI's animated WebP keeps the job). null if it isn't a WebP.
export function cleanWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const parts = [];
  for (let i = 12; i + 8 <= buf.length;) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = Math.min(buf.length, i + 8 + len + (len & 1));
    if (type === 'VP8X') {
      const chunk = Buffer.from(buf.subarray(i, end));
      chunk[8] &= ~0x0c; // no EXIF (0x08), no XMP (0x04)
      parts.push(chunk);
    } else if (type !== 'EXIF' && type !== 'XMP ') parts.push(buf.subarray(i, end));
    i = end;
  }
  const head = Buffer.from('RIFF0000WEBP', 'latin1');
  const body = Buffer.concat(parts);
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

// A JPEG without its EXIF/XMP (APP1) and comment segments, with one comment "Model: …". null if it isn't a JPEG.
export function cleanJpeg(buf, model) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let comment = null;
  if (model) {
    const text = Buffer.from(`Model: ${model}`, 'utf8');
    comment = Buffer.alloc(4 + text.length);
    comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(text.length + 2, 2);
    text.copy(comment, 4);
  }
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    // The comment goes after the APPn segments (JFIF's must come first).
    if (comment && !(marker >= 0xe0 && marker <= 0xef)) { parts.push(comment); comment = null; }
    if (marker === 0xda) break; // the picture itself, to the end
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (marker !== 0xe1 && marker !== 0xfe) parts.push(buf.subarray(i, end));
    i = end;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

// Without ffmpeg, an MP4 or MOV loses its tags in place: the "udta" and "meta" boxes in "moov" are zeroed and turned
// into "free" boxes of the same size, so nothing else in the file moves. It can't say the model then.
export function blankMp4Tags(buf) {
  let changed = false;
  const walk = (start, stop, inMoov) => {
    for (let i = start; i + 8 <= stop;) {
      let size = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      let head = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(i + 8)); head = 16; } else if (size === 0) size = stop - i;
      if (size < head || i + size > stop) return;
      if (type === 'moov') walk(i + head, i + size, true);
      else if (inMoov && (type === 'udta' || type === 'meta')) {
        buf.fill(0, i + head, i + size);
        buf.write('free', i + 4, 'latin1');
        changed = true;
      }
      i += size;
    }
  };
  walk(0, buf.length, false);
  return changed;
}

const MEDIA = /\.(mp4|mov|m4v|webm|mkv|flac|mp3|ogg|opus|m4a)$/i;

// Writes `data` (or ffmpeg's copy) in place of `file`: the new file is written next to it, the old one is shredded
// (it holds the prompt), then the new one takes its name.
async function replaceWith(file, write) {
  const tmp = path.join(path.dirname(file), `.clean-${crypto.randomBytes(6).toString('hex')}${path.extname(file)}`);
  try {
    await write(tmp);
    await shredFile(file);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// Leaves `file` saying only which model made it (`model`: its name in Prompt Maker, when Civitai doesn't know it). True when it's done (or there was nothing to take out), false
// when it couldn't be (a WebM or sound file with no ffmpeg on this computer, or a file it can't read).
export async function cleanRender(file, model) {
  const ext = path.extname(file).toLowerCase();
  if (MEDIA.test(ext)) {
    if (await videotools.hasFfmpeg()) {
      const tags = renderTags(await videotools.tag(file, 'prompt'), model);
      await replaceWith(file, tmp => videotools.keepOnlyTags(file, tmp, tags));
      return true;
    }
    if (!/^\.(mp4|mov|m4v)$/.test(ext)) return false;
    const buf = await fs.readFile(file);
    if (blankMp4Tags(buf)) {
      const fh = await fs.open(file, 'r+');
      try { await fh.write(buf, 0, buf.length, 0); await fh.sync(); } finally { await fh.close(); }
    }
    return true;
  }
  const clean = { '.png': cleanPng, '.webp': cleanWebp, '.jpg': cleanJpeg, '.jpeg': cleanJpeg }[ext];
  if (!clean) return true; // a GIF or WAV: ComfyUI writes no job into them
  const buf = await fs.readFile(file);
  const out = ext === '.png' ? cleanPng(buf, renderTags(pngText(buf, 'prompt'), model)) : clean(buf, model);
  if (!out) return false;
  if (!out.equals(buf)) await replaceWith(file, tmp => fs.writeFile(tmp, out));
  return true;
}
