// What Prompt Maker knows about each LLM ("Brain"): its record in your History, and the pieces of the Quick check.
import zlib from 'node:zlib';

// A Brain's record per job, from History: per kind (image / video) and per target model.
// takes: takes it wrote · rendered: takes you rendered · refined: takes you refined · fav: ⭐ entries.
export function brainRecords(history) {
  const records = {};
  const blank = () => ({ takes: 0, rendered: 0, refined: 0, fav: 0 });
  for (const e of history) {
    if (!e.llmModel) continue;
    const r = (records[e.llmModel] ||= { image: blank(), video: blank(), byModel: {} });
    const kind = e.modelKind === 'video' ? 'video' : 'image';
    const m = (r.byModel[e.modelId] ||= { ...blank(), name: e.modelName });
    for (const tally of [r[kind], m]) {
      tally.takes += e.variations.length;
      tally.rendered += e.variations.filter(v => v.renders?.length).length;
      tally.refined += e.variations.filter(v => v.versions.length > 1).length;
      if (e.favorite) tally.fav += 1;
    }
  }
  return records;
}

// An answer that turns the job down instead of writing the prompt.
export const looksRefused = text => /^(?:I(?:'|’)?m sorry|sorry,|I (?:can(?:'|’)?t|cannot|won(?:'|’)?t|am unable to|'m unable to)\b|as an ai\b)/i.test(String(text).trim());

export const countWords = text => (String(text).match(/\S+/g) || []).length;

// "≈80–130 words" → [80, 130]
export function wordRange(guide) {
  const m = /(\d+)\s*[–-]\s*(\d+)/.exec(guide || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const CHECK_THEMES = {
  image: 'an old fisherman mending a net on a wooden pier at dawn',
  video: 'a dancer spinning in the rain under a streetlight at night',
};

// The vision test: an image whose left half is red and right half is blue, as a PNG data URL.
export function testImageDataUrl(w = 64, h = 64) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      if (x < w / 2) raw[o] = 220; else raw[o + 2] = 220;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
