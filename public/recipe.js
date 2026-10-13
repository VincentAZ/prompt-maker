// Reads how a picture or video was made from the file itself, before anything is uploaded:
//   PNG:  ComfyUI's "prompt" and "workflow" text chunks, A1111's / Forge's "parameters" (tEXt, iTXt or zTXt).
//   JPEG, WebP: EXIF (A1111 and Civitai's UserComment; ComfyUI's WebP "prompt:" and "workflow:" tags).
//   MP4, MOV: the movie's metadata (ComfyUI's "prompt" / "workflow" keys, a "comment" holding both).
//   Anything else (WebM, MKV…), or when those come up empty: the JSON found near the start or the end of the file.
// Returns { prompt, workflow, parameters } (a ComfyUI API graph, an editor workflow, A1111's text: each or null), or
// null when the file carries none of them. The server makes sense of it (POST /api/recipe).

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

async function inflate(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function json(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { /* ComfyUI may write NaN */ }
  try { return JSON.parse(t.replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null')); } catch { return null; }
}
const isGraph = o => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).some(n => n && typeof n.class_type === 'string');
const isEditor = o => o && typeof o === 'object' && Array.isArray(o.nodes) && 'links' in o;

// Sorts named texts (a PNG chunk's keyword, an MP4 key, an EXIF value's "prompt:" prefix) into the recipe.
function collect(found, name, text) {
  const key = String(name || '').toLowerCase().replace(/^©/, '');
  const value = json(text);
  if (key === 'parameters' || (!value && /^usercomment|description|comment$/.test(key) && /\bSteps:\s*\d+/.test(text || ''))) {
    found.parameters ||= String(text).trim();
    return;
  }
  if (value && typeof value === 'object') {
    if (isGraph(value.prompt) || isEditor(value.workflow)) { // a "comment" carrying both (Video Helper Suite)
      if (isGraph(value.prompt)) found.prompt ||= value.prompt;
      if (isEditor(value.workflow)) found.workflow ||= value.workflow;
      return;
    }
    if (isGraph(value)) found.prompt ||= value;
    else if (isEditor(value)) found.workflow ||= value;
  }
}

// ---------- PNG ----------
async function readPng(b) {
  const found = {};
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 8; p + 8 <= b.length;) {
    const len = view.getUint32(p);
    const type = ascii(b, p + 4, 4);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IEND') break;
    try {
      const zero = d.indexOf(0);
      const key = latin1.decode(d.subarray(0, zero));
      if (type === 'tEXt') {
        const raw = d.subarray(zero + 1);
        let text = utf8.decode(raw); // ComfyUI writes UTF-8 where PNG says Latin-1
        if (text.includes('�')) text = latin1.decode(raw);
        collect(found, key, text);
      } else if (type === 'zTXt') {
        collect(found, key, utf8.decode(await inflate(d.subarray(zero + 2))));
      } else if (type === 'iTXt') {
        const compressed = d[zero + 1] === 1;
        let at = zero + 3;
        at = d.indexOf(0, at) + 1; // language
        at = d.indexOf(0, at) + 1; // translated keyword
        const raw = d.subarray(at);
        collect(found, key, utf8.decode(compressed ? await inflate(raw) : raw));
      }
    } catch { /* a chunk we can't read: the others still count */ }
    p += 12 + len;
  }
  return found;
}

// ---------- EXIF (JPEG's APP1, WebP's EXIF chunk) ----------
const EXIF_TAGS = { 0x010e: 'description', 0x010f: 'make', 0x0110: 'model', 0x9286: 'usercomment', 0x9c9c: 'comment' };
function userComment(raw) {
  const head = ascii(raw, 0, 8);
  const body = raw.subarray(8);
  if (head.startsWith('UNICODE')) {
    // UTF-16, its byte order not said: the zero bytes fall on the even places for big-endian text.
    let even = 0, odd = 0;
    for (let i = 0; i < Math.min(body.length, 400); i++) if (!body[i]) (i % 2 ? odd++ : even++);
    return new TextDecoder(even > odd ? 'utf-16be' : 'utf-16le').decode(body);
  }
  if (head.startsWith('ASCII') || /^\0{8}$/.test(head)) return utf8.decode(body);
  return utf8.decode(raw);
}
function readExif(found, tiff) {
  if (ascii(tiff, 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
  const little = ascii(tiff, 0, 2) === 'II';
  if (!little && ascii(tiff, 0, 2) !== 'MM') return;
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = at => v.getUint16(at, little);
  const u32 = at => v.getUint32(at, little);
  const seen = new Set();
  const ifd = at => {
    if (!at || seen.has(at) || at + 2 > tiff.length) return;
    seen.add(at);
    const n = u16(at);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > tiff.length) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === 0x8769) { ifd(u32(e + 8)); continue; } // the Exif sub-IFD, where UserComment lives
      const name = EXIF_TAGS[tag];
      if (!name) continue;
      const size = count * (type === 3 ? 2 : 1);
      const start = size > 4 ? u32(e + 8) : e + 8;
      const raw = tiff.subarray(start, start + size);
      let text = tag === 0x9286 ? userComment(raw) : tag === 0x9c9c ? new TextDecoder('utf-16le').decode(raw) : utf8.decode(raw);
      text = text.replace(/\0+$/, '');
      const prefixed = /^(prompt|workflow|parameters):\s*/i.exec(text); // ComfyUI's WebP: "prompt:{…}" in Model, "workflow:{…}" in Make
      if (prefixed) collect(found, prefixed[1], text.slice(prefixed[0].length));
      else collect(found, name, text);
    }
    ifd(u32(at + 2 + n * 12));
  };
  try { ifd(u32(4)); } catch { /* a broken EXIF: what was read counts */ }
}
function readJpeg(b) {
  const found = {};
  for (let p = 2; p + 4 <= b.length && b[p] === 0xff;) {
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) break; // the picture itself starts: no more metadata
    const len = (b[p + 2] << 8) | b[p + 3];
    const d = b.subarray(p + 4, p + 2 + len);
    if (marker === 0xe1 && ascii(d, 0, 4) === 'Exif') readExif(found, d);
    else if (marker === 0xfe) collect(found, 'comment', utf8.decode(d)); // a JPEG comment
    p += 2 + len;
  }
  return found;
}
function readWebp(b) {
  const found = {};
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let p = 12; p + 8 <= b.length;) {
    const type = ascii(b, p, 4);
    const len = v.getUint32(p + 4, true);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === 'EXIF') readExif(found, d);
    p += 8 + len + (len % 2);
  }
  return found;
}

// ---------- MP4 / MOV ----------
// Only the boxes' headers are read on the way to the movie box, so a big video costs a few small reads.
async function readMp4(file) {
  const found = {};
  const at = async (p, n) => new Uint8Array(await file.slice(p, p + n).arrayBuffer());
  let moov = null;
  for (let p = 0; p + 8 <= file.size;) {
    const h = await at(p, 16);
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = ascii(h, 4, 4);
    let head = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); head = 16; } else if (size === 0) size = file.size - p;
    if (size < head) break;
    if (type === 'moov') { if (size < 64 * 1024 * 1024) moov = await at(p, size); break; }
    p += size;
  }
  if (!moov) return found;
  const dv = new DataView(moov.buffer);
  const boxes = (from, to) => {
    const out = [];
    for (let p = from; p + 8 <= to;) {
      const size = dv.getUint32(p);
      if (size < 8 || p + size > to) break;
      out.push({ type: ascii(moov, p + 4, 4), start: p + 8, end: p + size });
      p += size;
    }
    return out;
  };
  const metas = [];
  const walk = (from, to) => {
    for (const box of boxes(from, to)) {
      if (box.type === 'udta' || box.type === 'trak') walk(box.start, box.end);
      else if (box.type === 'meta') {
        // ISO's meta has a version and flags first; QuickTime's doesn't.
        const full = ascii(moov, box.start + 4, 4) !== 'hdlr';
        metas.push({ start: box.start + (full ? 4 : 0), end: box.end });
      }
    }
  };
  walk(8, moov.length);
  for (const meta of metas) {
    const inside = boxes(meta.start, meta.end);
    const keysBox = inside.find(x => x.type === 'keys');
    const keys = [];
    if (keysBox) for (const k of boxes(keysBox.start + 8, keysBox.end)) keys.push(utf8.decode(moov.subarray(k.start, k.end))); // (each key's "type" is its namespace)
    const list = inside.find(x => x.type === 'ilst');
    if (!list) continue;
    for (const item of boxes(list.start, list.end)) {
      const data = boxes(item.start, item.end).find(x => x.type === 'data');
      if (!data) continue;
      const index = dv.getUint32(item.start - 8 + 4); // a keyed item's "type" is its key's number, from 1
      const name = keysBox && index >= 1 && index <= keys.length ? keys[index - 1] : item.type;
      collect(found, name, utf8.decode(moov.subarray(data.start + 8, data.end)));
    }
  }
  return found;
}

// ---------- anything else: JSON in the first and last few megabytes ----------
function scanJson(found, text) {
  let tries = 0;
  let after = -1; // the end of the last object read: the ones inside it are part of it
  for (const { index: start } of text.matchAll(/\{\s*"/g)) {
    if ((found.prompt && found.workflow) || ++tries > 400) break;
    if (start < after) continue;
    let depth = 0, inStr = false, end = -1;
    for (let i = start; i < text.length && i - start < 8e6; i++) {
      const c = text[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && !--depth) { end = i; break; }
    }
    if (end > start + 100) {
      const slice = text.slice(start, end + 1);
      if (json(slice)) { after = end; collect(found, '', slice); }
    }
  }
  if (!found.parameters) {
    const m = /parameters\0?([\s\S]{0,20000}?\bSteps:\s*\d+[^\0\n]*)/.exec(text);
    if (m) found.parameters = m[1].trim();
  }
}
async function scanEnds(file) {
  const found = {};
  const n = 4 * 1024 * 1024;
  const head = utf8.decode(await file.slice(0, n).arrayBuffer());
  scanJson(found, head);
  if (file.size > n && !found.prompt && !found.workflow) scanJson(found, utf8.decode(await file.slice(Math.max(n, file.size - n)).arrayBuffer()));
  return found;
}

export async function readRecipe(file) {
  if (!file?.size) return null;
  let found = {};
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const sig = ascii(head, 0, 12);
    const whole = async () => new Uint8Array(await file.arrayBuffer());
    if (head[0] === 0x89 && sig.slice(1, 4) === 'PNG') found = await readPng(await whole());
    else if (head[0] === 0xff && head[1] === 0xd8) found = readJpeg(await whole());
    else if (sig.startsWith('RIFF') && sig.slice(8, 12) === 'WEBP') found = readWebp(await whole());
    else if (/^(ftyp|moov|mdat|wide|free|skip)$/.test(sig.slice(4, 8))) found = await readMp4(file);
    if (!found.prompt && !found.workflow && !found.parameters) found = await scanEnds(file);
  } catch {
    return null;
  }
  const out = { prompt: found.prompt || null, workflow: found.workflow || null, parameters: found.parameters || null };
  return out.prompt || out.workflow || out.parameters ? out : null;
}
