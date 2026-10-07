// The tests' voice worker: the same JSON-lines protocol as lib/voice/worker.py, without the models. "fetch" makes
// the model folders in HF_HOME (with a little progress), "design" and "say" write a short WAV tone.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HF = process.env.HF_HOME;
const repos = [process.env.PM_VOICE_DESIGN, process.env.PM_VOICE_BASE];
const answer = o => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wav(file, seconds = 1.2, hz = 440) {
  const rate = 24000;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return seconds;
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  try {
    if (req.op === 'fetch') {
      const total = 2000;
      for (let got = 0; got <= total; got += 500) { answer({ progress: { received: got, total } }); await sleep(120); }
      for (const repo of repos) {
        const dir = path.join(HF, 'hub', `models--${repo.replace('/', '--')}`);
        fs.mkdirSync(path.join(dir, 'snapshots', 'abc'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'blobs', 'x'), 'x');
      }
      answer({ ok: true, id: req.id, took: 0.5 });
    } else if (req.op === 'design') {
      if (/fail/i.test(req.instruct)) throw new Error('RuntimeError: the mock refuses this voice');
      await sleep(200);
      answer({ ok: true, id: req.id, took: 0.2, seconds: wav(req.out, 1.2, 440) });
    } else if (req.op === 'say') {
      if (!fs.existsSync(req.ref)) throw new Error('FileNotFoundError: no reference clip');
      await sleep(150);
      answer({ ok: true, id: req.id, took: 0.15, seconds: wav(req.out, Math.max(0.5, req.text.length / 15), 330) });
    } else answer({ ok: true, id: req.id, took: 0 });
  } catch (err) {
    answer({ ok: false, id: req.id, error: err.message });
  }
});
