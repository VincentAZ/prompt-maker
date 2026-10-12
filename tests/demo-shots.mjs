// Builds the DEMO (5320) and CLEAN (5321) copies tests/screenshots.mjs needs, from the mocks and docs/renders, takes
// the named shots, then stops everything. No personal data: sample renders, empty prompts, seed 0, neutral paths.
//   node tests/demo-shots.mjs create gallery models voices comfy-setup ask   → /tmp/promptmaker-demo/shots/*.png
// Then copy the pngs into docs/screenshots (gallery and ask as .jpg: ffmpeg -q:v 4), and look at every one first.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMock } from './mock-lmstudio.mjs';
import { startMockComfy } from './mock-comfyui.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = '/tmp/promptmaker-demo';
const names = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
await fs.rm(BASE, { recursive: true, force: true });
for (const d of ['demo/renders', 'data', 'home', 'comfy', 'shots', 'chrome']) await fs.mkdir(path.join(BASE, d), { recursive: true });

const MOCK = 12420, COMFY = 12421;
const mock = startMock(MOCK); await mock.start();
const comfy = startMockComfy(COMFY, { png: await fs.readFile(path.join(ROOT, 'docs/screenshots/create.png')), root: path.join(BASE, 'comfy') }); await comfy.start();

// DEMO: nine rated sample renders, no prompts.
const demo = path.join(BASE, 'demo');
await fs.writeFile(path.join(demo, 'settings.json'), JSON.stringify({ lmStudioUrl: `http://127.0.0.1:${MOCK}`, comfyUrl: `http://127.0.0.1:${COMFY}`, llmModel: 'mock/vision-8b', checkTheme: false }));
const pics = ['mountain-lake', 'lighthouse-storm', 'hands-dough', 'street-musician', 'surfer-sunset', 'old-man-dog', 'woman-cafe', 'woman-bicycle-rain', 'fisherman-dock'];
const titles = ['Mountain lake', 'Lighthouse in a storm', 'Hands kneading dough', 'Street musician', 'Surfer at sunset', 'Old man and his dog', 'Woman in a café', 'Bicycle in the rain', 'Fisherman on the dock']; // plain titles, not prompts: they caption the tiles
const history = [];
let t = Date.now() - 3600e3 * 20;
for (const [i, name] of pics.entries()) {
  const id = randomUUID();
  const file = `${randomUUID()}_0.webp`;
  await fs.copyFile(path.join(ROOT, 'docs/renders', `${name}.webp`), path.join(demo, 'renders', file));
  const createdAt = new Date(t += 3600e3).toISOString();
  history.unshift({ id, createdAt, favorite: false, modelId: 'krea2-raw', modelName: 'Krea 2 RAW', modelKind: 'image', theme: titles[i], variations: [{ versions: [{ text: '', instruction: null, createdAt }], renders: [{ id: randomUUID(), seed: 0, files: [{ file, kind: 'image', name: file }], rating: [3, 2, 3, 1, 2, 3, 2, 1, 3][i], count: 1, seedMode: 'random', overrides: {}, createdAt }] }] });
}
await fs.writeFile(path.join(demo, 'history.json'), JSON.stringify(history, null, 2));

const env = { ...process.env, HOME: path.join(BASE, 'home'), XDG_CONFIG_HOME: path.join(BASE, 'home/.config'), XDG_DATA_HOME: path.join(BASE, 'home/.local/share'), SYSTEMCTL_BIN: '/bin/true', LMS_BIN: '/bin/true', PM_RAM_DIR: path.join(BASE, 'ram') };
const servers = [];
const startApp = (port, data) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, PORT: String(port), PROMPT_MAKER_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(p);
  let log = '';
  p.stdout.on('data', d => { log += d; if (log.includes('running at')) resolve(); });
  p.stderr.on('data', d => { log += d; });
  setTimeout(() => reject(new Error(`no start on ${port}:\n${log}`)), 20000);
});
await startApp(5320, demo);
await startApp(5321, path.join(BASE, 'data'));
await sleep(1500);
const shots = spawn(process.execPath, ['tests/screenshots.mjs', ...names], { cwd: ROOT, env: { ...process.env, OUT: path.join(BASE, 'shots'), CDP_PORT: '9445', CHROME_DIR: path.join(BASE, 'chrome') }, stdio: 'inherit' });
const code = await new Promise(r => shots.on('close', r));
for (const p of servers) p.kill('SIGTERM');
await mock.stop?.(); await comfy.stop?.();
console.log(`shots done (${code}): ${path.join(BASE, 'shots')}`);
process.exit(code || 0);
