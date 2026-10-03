// Optional help with motion videos, from ffmpeg when this computer has it (Prompt Maker doesn't need it): what's in a
// video (codec, shape, frame rate, black bars), a small H.264 preview the browser can play when it can't play the
// original (H.265 phone videos, mostly), a 24 fps copy of a fast video, a copy without its black bars and a part of a
// long one. ComfyUI still gets the original unless you pick a copy.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const bin = name => process.env[`${name.toUpperCase()}_BIN`] || name;

// Resolves with what the command printed (its log, with stderr: true).
function run(cmd, args, { timeout = 300000, stderr = false } = {}) {
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
      if (code === 0) resolve(stderr ? err : out);
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

// The picture inside black bars (a webcam or screen recording in a wider frame, a letterboxed film), from ffmpeg's
// cropdetect at three points of the video: { width, height, x, y }, or null when the bars are thin or there are none.
export async function bars(file, info) {
  if (!info?.width || !info?.height || !(await hasFfmpeg())) return null;
  const seconds = info.seconds || 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const at of [0.2, 0.5, 0.8]) {
    const log = await run('ffmpeg', ['-v', 'info', '-nostats', '-ss', String(Math.max(0, seconds * at - 0.5)), '-i', file, '-t', '1', '-an', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-'], { timeout: 60000, stderr: true }).catch(() => '');
    const found = [...log.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
    if (!found) return null;
    const [w, h, x, y] = found.slice(1).map(Number);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  const box = { width: x1 - x0, height: y1 - y0, x: x0, y: y0 };
  return box.width >= 64 && box.height >= 64 && (box.width * box.height) / (info.width * info.height) < 0.9 ? box : null;
}

// The video cut to the picture inside its black bars (sound kept), as a new file next to it. Returns its path.
export async function crop(file, box) {
  const out = path.join(path.dirname(file), `crop-${process.pid}-${Date.now()}.tmp.mp4`);
  const even = n => Math.max(2, Math.floor(n / 2) * 2); // H.264 wants even sizes
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', `crop=${even(box.width)}:${even(box.height)}:${box.x}:${box.y}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  return out;
}

// A part of the video (from start, this many seconds; sound kept), as a new file next to it. Returns its path.
export async function trim(file, start, seconds) {
  const out = path.join(path.dirname(file), `trim-${process.pid}-${Date.now()}.tmp.mp4`);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-i', file, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  return out;
}
