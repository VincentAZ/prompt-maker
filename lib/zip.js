// ⬇ Download several renders as one .zip: the files as they are (stored, not compressed: pictures and videos are
// compressed already), streamed straight from disk, with Zip64 where a file or the whole archive passes 4 GB.
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;

// zlib.crc32 is in Node 20.15+ and 22.2+; a table does it on older ones.
let table;
function crc32(buf, crc = 0) {
  if (zlib.crc32) return zlib.crc32(buf, crc);
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  crc = ~crc;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

async function crcOf(file) {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = crc32(chunk, crc);
  return crc;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/**
 * Lays out the archive for files ([{ path, name }], the name being what it's called inside): which exist, where
 * each goes and how long the whole is (so the browser can show progress). Missing files are left out.
 */
export async function planZip(files) {
  const entries = [];
  const names = new Set();
  let offset = 0;
  for (const f of files) {
    const st = await fs.stat(f.path).catch(() => null);
    if (!st?.isFile()) continue;
    let name = f.name;
    for (let i = 2; names.has(name); i++) name = f.name.replace(/(\.[^.]*)?$/, ext => ` (${i})${ext}`);
    names.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const big = st.size >= MAX32;
    const local = 30 + nameBuf.length + (big ? 20 : 0);
    entries.push({ path: f.path, nameBuf, size: st.size, mtime: st.mtime, offset, big, local });
    offset += local + st.size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const e of entries) {
    e.cdExtra = (e.big ? 16 : 0) + (e.offset >= MAX32 ? 8 : 0);
    cdSize += 46 + e.nameBuf.length + (e.cdExtra ? 4 + e.cdExtra : 0);
  }
  const zip64 = entries.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32 || entries.some(e => e.big || e.offset >= MAX32);
  const length = cdStart + cdSize + (zip64 ? 56 + 20 : 0) + 22;
  return { entries, cdStart, cdSize, zip64, length };
}

/** Writes the planned archive to out (a writable stream, e.g. the HTTP response); stops if it closes. */
export async function writeZip(plan, out) {
  const write = buf => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('closed'));
    out.write(buf) ? resolve() : out.once('drain', resolve);
  });
  for (const e of plan.entries) {
    e.crc = await crcOf(e.path);
    const { time, date } = dosTime(e.mtime);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(e.big ? 45 : 20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.big ? MAX32 : e.size, 18);
    h.writeUInt32LE(e.big ? MAX32 : e.size, 22);
    h.writeUInt16LE(e.nameBuf.length, 26);
    h.writeUInt16LE(e.big ? 20 : 0, 28);
    const extra = e.big ? Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(e.size), u64(e.size)]) : Buffer.alloc(0);
    await write(Buffer.concat([h, e.nameBuf, extra]));
    if (e.size) for await (const chunk of createReadStream(e.path, { start: 0, end: e.size - 1 })) await write(chunk);
  }
  const cd = [];
  for (const e of plan.entries) {
    const { time, date } = dosTime(e.mtime);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(0x0300 | (e.cdExtra ? 45 : 20), 4); // made on Unix
    h.writeUInt16LE(e.cdExtra ? 45 : 20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.big ? MAX32 : e.size, 20);
    h.writeUInt32LE(e.big ? MAX32 : e.size, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt16LE(e.cdExtra ? 4 + e.cdExtra : 0, 30);
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a plain file, rw-r--r--
    h.writeUInt32LE(e.offset >= MAX32 ? MAX32 : e.offset, 42);
    const extra = !e.cdExtra ? [] : [Buffer.from([1, 0, e.cdExtra, 0]), ...(e.big ? [u64(e.size), u64(e.size)] : []), ...(e.offset >= MAX32 ? [u64(e.offset)] : [])];
    cd.push(h, e.nameBuf, ...extra);
  }
  const n = plan.entries.length;
  if (plan.zip64) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(45, 12);
    r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(n), 24);
    r.writeBigUInt64LE(BigInt(n), 32);
    r.writeBigUInt64LE(BigInt(plan.cdSize), 40);
    r.writeBigUInt64LE(BigInt(plan.cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(plan.cdStart + plan.cdSize), 8);
    loc.writeUInt32LE(1, 16);
    cd.push(r, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(plan.zip64 ? 0xffff : n, 8);
  end.writeUInt16LE(plan.zip64 ? 0xffff : n, 10);
  end.writeUInt32LE(plan.zip64 ? MAX32 : plan.cdSize, 12);
  end.writeUInt32LE(plan.zip64 ? MAX32 : plan.cdStart, 16);
  cd.push(end);
  await write(Buffer.concat(cd));
  out.end();
}
