// Writes public/icons/prompt-maker.ico from the PNG sizes in public/icons: the Start menu shortcut and the Windows
// installer want an .ico. An .ico holds PNG images as they are (Vista and later), so nothing is decoded here.
// Run it again when the icon changes:  node packaging/windows/ico.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', '..', 'public', 'icons');
const sizes = [32, 48, 64, 128, 256]; // an .ico entry is at most 256 px
const pngs = await Promise.all(sizes.map(n => fs.readFile(path.join(dir, `prompt-maker-${n}.png`))));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1: icon
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const e = 6 + 16 * i;
  header[e] = w >= 256 ? 0 : w; // 0 means 256
  header[e + 1] = h >= 256 ? 0 : h;
  header[e + 2] = 0; // colours in palette: none
  header[e + 3] = 0; // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
await fs.writeFile(path.join(dir, 'prompt-maker.ico'), Buffer.concat([header, ...pngs]));
console.log(`Wrote ${path.join(dir, 'prompt-maker.ico')} (${sizes.join(', ')} px)`);
