// Optional help with motion videos, from ffmpeg when this computer has it (Prompt Maker doesn't need it): what's in a
// video (codec, shape, frame rate), a small H.264 preview the browser can play when it can't play the original (H.265
// phone videos, mostly), and a 24 fps copy of a fast video. ComfyUI still gets the original unless you pick the copy.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const bin = name => process.env[`${name.toUpperCase()}_BIN`] || name;

function run(cmd, args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(bin(cmd), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `${cmd} failed (${code})`));
    });
  });
}

let available = null;
// Whether ffmpeg and ffprobe are installed (asked once).
export async function hasFfmpeg() {
  available ??= Promise.all([run('ffmpeg', ['-version'], { timeout: 10000 }), run('ffprobe', ['-version'], { timeout: 10000 })]).then(() => true, () => false);
  return available;
}

// { codec, width, height, fps, seconds } as it plays (a phone video's rotation applied), or null.
export async function probe(file) {
  if (!(await hasFfmpeg())) return null;
  try {
    const data = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration', '-of', 'json', file], { timeout: 30000 }));
    const s = data.streams?.[0];
    if (!s) return null;
    const rate = r => { const [a, b] = String(r || '').split('/').map(Number); return a > 0 && b > 0 ? a / b : null; };
    const rotation = Number(s.side_data_list?.find(x => x.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0);
    const turned = Math.abs(rotation) % 180 === 90;
    return {
      codec: s.codec_name || '',
      width: turned ? s.height : s.width,
      height: turned ? s.width : s.height,
      fps: Math.round((rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 0) * 100) / 100 || null,
      seconds: Math.round(Number(data.format?.duration || 0) * 100) / 100 || null,
    };
  } catch {
    return null;
  }
}

// A small, upright H.264 copy for the page to show and take frames from (no sound). Made once; returns its path.
export async function preview(file) {
  const out = file.replace(/\.\w+$/, '.preview.mp4');
  if (await fs.access(out).then(() => true, () => false)) return out;
  const tmp = `${out}.${process.pid}.tmp.mp4`;
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-an', '-vf', "scale='min(720,iw)':-2,fps=24", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]);
  await fs.rename(tmp, out);
  return out;
}

// The video at a lower frame rate (sound kept), as a new file next to it. Returns the new file's path.
export async function retime(file, fps) {
  const out = path.join(path.dirname(file), `retime-${process.pid}-${Date.now()}.tmp.mp4`);
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', `fps=${fps}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  return out;
}
