#!/usr/bin/env node
// Try the Brains on shot lists: how often each Brain fills the list in right the first time, from a few requests of
// the kind the guide shows, without rendering anything. The real app runs in a throwaway folder against the real
// LM Studio, in a headless Chrome, and each request is typed into ✦ Ask the way a person would; the list the Brain
// fills in (as the app checked and saved it) is compared with what the request asked for.
//
//   node tests/brain-eval.mjs [--brains id,id,…] [--cases name,name,…] [--repeat N] [--out folder] [--timeout seconds]
//
// Brains: the ones used in the last 14 days and rated Good or better in your data folder, plus the one picked now
// (--brains names others, by their LM Studio id). Cases: all below unless --cases names some. Results: a table on
// the screen and <out>/brain-eval-<date>.json + .md (out: the data folder's brain-eval/). Needs LM Studio running
// with the Brains downloaded, and google-chrome; voices are made by the suite's stand-in engine (a tone), so a list
// that makes a voice goes through as in the real app. Nothing in your data folder is touched or read beyond settings.json
// (the LM Studio address, thinking, max tokens) and brains.json (ratings, use, how each Brain takes tools).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = (await fs.stat(path.join(HERE, '..', 'server.js')).catch(() => null)) ? path.resolve(HERE, '..') : process.cwd();
const HOME_DATA = process.env.PROMPT_MAKER_DATA || path.join(os.homedir(), '.local', 'share', 'prompt-maker');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null)).filter(Boolean));
const PORT = Number(args.port || 5341);
const CDP = PORT + 1000;
const REPEAT = Math.max(1, Number(args.repeat) || 1);
const TIMEOUT = Math.max(60, Number(args.timeout) || 600) * 1000;
const OUT = args.out || path.join(HOME_DATA, 'brain-eval');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lower = s => String(s || '').toLowerCase();

// ---------- the cases: a request, and what the list has to say ----------
// Model names as the app has them; seconds as a range (judged from the action, so no single right answer);
// a line's text as a pattern. A case with `tools` instead of `expect` is about the routing: which tools, which not.
const CASES = [
  {
    name: 'cabin-promo',
    ask: `job:
1. Make a female voice named Sarah: late thirties, calming but authoritative.
2. Scene 1: on Krea 2 RAW t2i, a woman in her late thirties in a cozy cabin, sitting at a desk with a laptop and a cup of coffee, typing away: 4 takes, 1 render each. Pick the best still: she is the woman for every scene. Animate it on LTX 2.3: she types away on her laptop. 1 take, 1 render.
3. Scene 2: on Krea 2 Character with scene 1's still as the person, the same woman at the desk, looking up from the laptop toward the camera: 4 takes, 1 render each. Pick the best still and animate it on MiniMax H3 i2v: she looks up and speaks to the camera. 1 take, 1 render. Sarah says, word for word: "For image and video creation there's only one clear choice: Prompt Maker. An autonomous image and video generator that runs your own workflows, on your own computer. One hundred percent free. One hundred percent offline. One hundred percent open source. Try it, and tell us what you think."
4. Scene 3: on Krea 2 Character with scene 1's still as the person, the same woman at the desk reaching for her coffee: 4 takes, 1 render each. Pick the best still and animate it on LTX 2.3: she picks up her coffee, takes a sip and gets back to typing. 1 take, 1 render.
5. Judge how long each clip needs to be from what happens in it.
6. Join the three videos in order into one film called "Cabin promo".`,
    expect: { voice: 'Sarah', join: true, scenes: [
      { pick: /woman|every scene|face|natural/i, still: { model: 'Krea 2 RAW', takes: 4, renders: 1, person: null }, video: { model: 'LTX 2.3', takes: 1, renders: 1, seconds: [3, 12], line: null } },
      { still: { model: 'Krea 2 Character', takes: 4, renders: 1, person: 1 }, video: { model: 'MiniMax H3 (Hailuo 03)', takes: 1, renders: 1, seconds: [3, 20], line: { voice: 'Sarah', text: /only one clear choice/ } } },
      { still: { model: 'Krea 2 Character', takes: 4, renders: 1, person: 1 }, video: { model: 'LTX 2.3', takes: 1, renders: 1, seconds: [4, 15], line: null } },
    ] },
  },
  {
    name: 'lighthouse',
    ask: 'job: scene 1 on Krea 2 RAW: a lighthouse on a cliff at dusk, waves breaking below, 4 takes, 1 render each. Pick the most dramatic sky. Animate it on LTX 2.3: the beam sweeps across the sea while the waves roll in.',
    expect: { voice: null, join: false, scenes: [
      { pick: /dramatic|sky/i, still: { model: 'Krea 2 RAW', takes: 4, renders: 1, person: null }, video: { model: 'LTX 2.3', seconds: [3, 12], line: null } },
    ] },
  },
  {
    name: 'bicycle',
    ask: 'job: 1. scene 1 on Z-Image Turbo: a red bicycle leaning against a white wall, just 1 take. Animate it on LTX 2.3: the front wheel slowly spins. 2. scene 2 on Z-Image Turbo: the same red bicycle seen from above, 2 takes, 2 renders each; pick the cleanest one and animate it on LTX 2.3: autumn leaves blow past. 3. join the two videos.',
    expect: { voice: null, join: true, scenes: [
      { still: { model: 'Z-Image Turbo', takes: 1, renders: 1 }, video: { model: 'LTX 2.3', seconds: [2, 10] } },
      { pick: /clean/i, still: { model: 'Z-Image Turbo', takes: 2, renders: 2 }, video: { model: 'LTX 2.3', seconds: [2, 10] } },
    ] },
  },
  {
    name: 'chef',
    ask: 'job: first make a voice called Marco: an Italian man in his fifties, warm and unhurried. Scene 1 on Krea 2 RAW: a chef in a small kitchen plating a dish, 3 takes, 1 render each; pick the best and animate it on LTX 2.3: he wipes the rim of the plate. Scene 2 has no still of its own: start from scene 1\'s still on MiniMax H3 i2v, he looks up at the camera, and Marco says "Dinner is served." Join them.',
    expect: { voice: 'Marco', join: true, scenes: [
      { still: { model: 'Krea 2 RAW', takes: 3, renders: 1 }, video: { model: 'LTX 2.3', seconds: [2, 10], line: null } },
      { still: null, video: { model: 'MiniMax H3 (Hailuo 03)', from: 1, seconds: [2, 12], line: { voice: 'Marco', text: /Dinner is served/ } } },
    ] },
  },
  {
    name: 'rooftop',
    ask: 'job: a woman on a rooftop at night on krea 2 raw, 4 takes, and animate the best one with ltx 2.3: she turns toward the city lights.',
    expect: { voice: null, join: false, scenes: [
      { still: { model: 'Krea 2 RAW', takes: 4, renders: 1 }, video: { model: 'LTX 2.3', seconds: [2, 10] } },
    ] },
  },
  {
    name: 'fisherman',
    ask: `job:
1. Scene 1 on Krea 2 RAW: an old fisherman mending a net on a pier at dawn, 4 takes, 1 render each; pick the best, he is the man for every scene; animate it on LTX 2.3: his hands work the net.
2. Scene 2 on Krea 2 Character with scene 1's still as the person: he stands and looks out to sea, 2 takes; animate on LTX 2.3: he shields his eyes from the sun.
3. Scene 3 on Krea 2 Character with scene 1's still as the person: he walks along the pier carrying the net, 2 takes; animate on LTX 2.3: he walks away from the camera.
4. Scene 4 on Krea 2 Character with scene 1's still as the person: he sits in his boat, 2 takes; animate on LTX 2.3: he starts the motor.
5. Scene 5 on Krea 2 Character with scene 1's still as the person: the boat leaves the harbour, seen from the pier, 2 takes; animate on LTX 2.3: the boat shrinks toward the horizon.
6. Join all five in order.`,
    expect: { voice: null, join: true, scenes: [
      { pick: /man|every scene|best/i, still: { model: 'Krea 2 RAW', takes: 4, renders: 1, person: null }, video: { model: 'LTX 2.3', seconds: [2, 12] } },
      { still: { model: 'Krea 2 Character', takes: 2, person: 1 }, video: { model: 'LTX 2.3', seconds: [2, 12] } },
      { still: { model: 'Krea 2 Character', takes: 2, person: 1 }, video: { model: 'LTX 2.3', seconds: [2, 12] } },
      { still: { model: 'Krea 2 Character', takes: 2, person: 1 }, video: { model: 'LTX 2.3', seconds: [2, 12] } },
      { still: { model: 'Krea 2 Character', takes: 2, person: 1 }, video: { model: 'LTX 2.3', seconds: [2, 15] } },
    ] },
  },
  {
    name: 'folder',
    ask: 'job: for each picture in ~/Pictures/eval-nothing-here: 2 takes on Krea 2 RAW Edit, the first with a soft look, the second dramatic, 1 render each. Skip any problems and log them.',
    tools: { some: ['list_folder', 'start_job'], none: ['shot_list'] },
  },
];

// ---------- what to run ----------
const wanted = args.cases ? args.cases.split(',').map(s => s.trim()) : null;
const cases = CASES.filter(c => !wanted || wanted.includes(c.name));
if (!cases.length) { console.error(`No such case: ${args.cases}. Cases: ${CASES.map(c => c.name).join(', ')}`); process.exit(2); }
const homeSettings = await fs.readFile(path.join(HOME_DATA, 'settings.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const homeBrains = await fs.readFile(path.join(HOME_DATA, 'brains.json'), 'utf8').then(JSON.parse).catch(() => ({}));
function defaultBrains() {
  const since = Date.now() - 14 * 86400e3;
  const used = Object.entries(homeBrains).filter(([id, b]) => !id.startsWith('cloud:') && !/embed/.test(id) && (b.rating || 0) >= 2 && Date.parse(b.stats?.lastUsed || 0) > since).sort((a, b) => (b[1].stats?.runs || 0) - (a[1].stats?.runs || 0)).map(([id]) => id);
  const now = homeSettings.llmModel && !homeSettings.llmModel.startsWith('cloud:') ? [homeSettings.llmModel] : [];
  return [...new Set([...now, ...used])];
}
const brainIds = args.brains ? args.brains.split(',').map(s => s.trim()).filter(Boolean) : defaultBrains();
if (!brainIds.length) { console.error('No Brains to try: name some with --brains id,id (ids as LM Studio lists them).'); process.exit(2); }

// ---------- a throwaway app, the real LM Studio ----------
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-brain-eval-'));
for (const d of ['data', 'xdg-config', 'xdg-data', 'ram', 'chrome']) await fs.mkdir(path.join(TMP, d), { recursive: true });
await fs.writeFile(path.join(TMP, 'data', 'settings.json'), JSON.stringify({ lmStudioUrl: homeSettings.lmStudioUrl || 'http://127.0.0.1:1234', ...(homeSettings.thinking ? { thinking: homeSettings.thinking } : {}), ...(homeSettings.maxTokens ? { maxTokens: homeSettings.maxTokens } : {}) }));
await fs.copyFile(path.join(HOME_DATA, 'brains.json'), path.join(TMP, 'data', 'brains.json')).catch(() => {});
const env = { ...process.env, PORT: String(PORT), PROMPT_MAKER_DATA: path.join(TMP, 'data'), XDG_CONFIG_HOME: path.join(TMP, 'xdg-config'), XDG_DATA_HOME: path.join(TMP, 'xdg-data'), PM_RAM_DIR: path.join(TMP, 'ram'), LMS_BIN: '/bin/true', SYSTEMCTL_BIN: '/bin/true', PM_MODEL_HOSTS: '127.0.0.1', PM_UV_BIN: 'none', PM_NVIDIA_SMI_BIN: '/bin/true', PM_LSPCI_BIN: '/bin/true', PROMPT_MAKER_VOICE_PYTHON: path.join(ROOT, 'tests', 'mock-voice-python.sh'), PROMPT_MAKER_VOICE_WORKER: path.join(ROOT, 'tests', 'mock-voice-worker.mjs') };
const APP = `http://127.0.0.1:${PORT}`;
const app = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', d => { appLog += d; });
app.stderr.on('data', d => { appLog += d; });
let chrome = null;
async function stop(code) {
  chrome?.kill('SIGKILL');
  app.kill();
  await sleep(300);
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => stop(130));
let up = false;
for (let i = 0; i < 100 && !up; i++) { await sleep(200); up = await fetch(`${APP}/`).then(r => r.ok).catch(() => false); }
if (!up) { console.error(`The app didn't start:\n${appLog}`); await stop(1); }
const api = (p, opts = {}) => fetch(`${APP}${p}`, { ...opts, headers: { 'content-type': 'application/json', Origin: APP, ...(opts.headers || {}) }, body: opts.body != null ? JSON.stringify(opts.body) : undefined }).then(async r => { const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } if (!r.ok) throw new Error(`${p}: ${r.status} ${typeof j === 'string' ? j.slice(0, 200) : j.error || JSON.stringify(j).slice(0, 200)}`); return j; });
// The suite's stand-in voice engine (a tone for every voice), so a Brain that makes the voice with make_voice before
// the list, instead of on it, is judged the way the real app would take it, not as a failure of a missing engine.
await api('/api/voice/install', { method: 'POST' }).catch(() => {});
for (let i = 0; i < 100; i++) { if ((await api('/api/voice').catch(() => ({}))).installed) break; await sleep(100); }
const llms = await api('/api/llms').catch(err => ({ ok: false, error: err.message, models: [] }));
if (!llms.ok) { console.error(`LM Studio isn't answering at ${llms.url || homeSettings.lmStudioUrl}: ${llms.error || ''}`); await stop(1); }
const brains = brainIds.map(id => llms.models.find(m => m.id === id) || { id, name: id, missing: true });
for (const b of brains.filter(b => b.missing)) console.log(`(LM Studio doesn't list ${b.id}: skipped)`);
const tried = brains.filter(b => !b.missing);
if (!tried.length) { console.error('None of those Brains is in LM Studio.'); await stop(1); }

// ---------- headless Chrome ----------
// Every call to the browser has a deadline (BROWSER_WAIT): a tab whose renderer wedges (seen once overnight, between
// two Brains, after a job ran in the page: no dialog, no CPU, every call unanswered for eleven hours) is a hang, not
// a wait, and the run goes on by starting Chrome afresh. A "leave this page?" or any other dialog is answered at
// once, since nobody is there to click it.
const BROWSER_WAIT = 30000;
class BrowserHang extends Error { hang = true; }
let ws = null;
let msgId = 0;
let pending = new Map();
let chromeDir = 0;
async function startChrome() {
  for (const { rej } of pending.values()) rej(new BrowserHang('The browser was started afresh'));
  pending = new Map();
  try { ws?.close(); } catch {}
  chrome?.kill('SIGKILL');
  chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(TMP, `chrome${chromeDir++ || ''}`)}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) { await sleep(150); target = await fetch(`http://127.0.0.1:${CDP}/json/list`).then(r => r.json()).then(l => l.find(t => t.type === 'page')).catch(() => null); }
  if (!target) throw new Error('Chrome did not start (google-chrome needed).');
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; setTimeout(() => j(new Error('Chrome did not answer')), BROWSER_WAIT); });
  sock.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); }
    else if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  };
  ws = sock;
  await Promise.all(['Page.enable', 'Runtime.enable'].map(m => send(m)));
}
const send = (method, params = {}) => {
  const i = ++msgId;
  const sock = ws;
  return new Promise((res, rej) => {
    pending.set(i, { res, rej });
    try { sock.send(JSON.stringify({ id: i, method, params })); } catch (err) { pending.delete(i); rej(err); return; }
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new BrowserHang(`The browser didn't answer ${method} in ${BROWSER_WAIT / 1000} s`)); } }, BROWSER_WAIT);
  });
};
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function waitFor(expr, timeout, label) {
  const t = Date.now();
  for (;;) {
    const v = await js(expr).catch(err => { if (err.hang) throw err; return null; });
    if (v) return v;
    if (Date.now() - t > timeout) throw new Error(`Timed out waiting for ${label || expr}`);
    await sleep(200);
  }
}
try { await startChrome(); } catch (err) { console.error(err.message); await stop(1); }
async function openPage() {
  await send('Page.navigate', { url: `${APP}/#create` });
  await sleep(800);
  await js(`localStorage.setItem('pm.assistantOpen', 'true'); localStorage.setItem('pm.deleteWarned', 'true'); localStorage.setItem('pm.jobsAsk', 'true'); 1`);
  await send('Page.reload');
  await waitFor('document.documentElement.dataset.ready === "1" && !!document.querySelector("#asInput")', 30000, 'the app to boot').catch(() => {});
  await sleep(500);
  await js(`document.querySelectorAll('dialog[open]').forEach(d => d.close?.()); 1`);
}
await openPage();

// ---------- one request, one Brain ----------
const toolName = c => c.function?.name || c.name;
const parse = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s; } };
async function runCase(c) {
  await js(`document.querySelector('#asStop')?.click(); 1`).catch(() => {}); // whatever the last case left running
  await api('/api/assistant/chat', { method: 'PUT', body: { messages: [], plan: null } });
  for (const j of await api('/api/jobs').catch(() => [])) await api(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
  await openPage();
  const t0 = Date.now();
  await js(`document.querySelector('#asInput').focus(); 1`);
  await send('Input.insertText', { text: c.ask });
  await sleep(100);
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  let timedOut = false;
  await waitFor('!document.querySelector("#asStop").hidden', 15000, 'the request to go out').catch(() => {});
  await waitFor('document.querySelector("#asStop").hidden', TIMEOUT, 'the Brain to finish').catch(async () => { timedOut = true; await js(`document.querySelector('#asStop')?.click(); 1`); await sleep(2000); });
  const seconds = Math.round((Date.now() - t0) / 10) / 100;
  await sleep(1500); // the chat is saved as it goes: give the last save a moment
  const chat = await api('/api/assistant/chat').catch(() => ({ messages: [] }));
  const shownReply = await js('[...document.querySelectorAll("#asLog .as-msg.bot")].at(-1)?.textContent || ""').catch(() => '');
  const msgs = chat.messages || [];
  const results = new Map(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, parse(m.content)]));
  const calls = msgs.filter(m => m.role === 'assistant' && m.tool_calls?.length).flatMap(m => m.tool_calls.map(tc => {
    const r = results.get(tc.id);
    const error = r && typeof r === 'object' ? r.error || (r.ok === false ? r.summary || 'failed' : null) : typeof r === 'string' && /^(error|⚠)/i.test(r) ? r : null;
    return { tool: toolName(tc), args: parse(tc.function?.arguments ?? tc.arguments), error: error || null, summary: r && typeof r === 'object' ? r.summary || null : null };
  }));
  const reply = [...msgs].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && !m.tool_calls?.length)?.content.trim() || shownReply.trim();
  const drafts = (await api('/api/jobs').catch(() => [])).filter(j => j.status === 'draft' && j.shot);
  const shot = drafts[0]?.shot || null;
  const lists = calls.filter(x => x.tool === 'shot_list');
  const good = lists.findIndex(x => !x.error);
  const out = { case: c.name, seconds, timedOut, tools: calls.map(x => x.tool), attempts: lists.length, firstTime: lists.length > 0 && !lists[0].error, errors: lists.filter(x => x.error).map(x => x.error), firstList: lists[0]?.error ? lists[0].args : undefined, stopped: good >= 0 && calls.slice(calls.indexOf(lists[good]) + 1).length === 0 && reply.length > 0, reply: reply.slice(0, 400), shot };
  if (c.tools) {
    const names = new Set(out.tools);
    out.diffs = [...c.tools.some.some(t => names.has(t)) ? [] : [`none of ${c.tools.some.join('/')} called`], ...c.tools.none.filter(t => names.has(t)).map(t => `${t} called`)];
    out.right = !out.diffs.length;
  } else {
    out.diffs = shot ? diffShot(shot, c.expect) : ['no list was saved'];
    out.right = !out.diffs.length && out.firstTime;
  }
  return out;
}
function diffShot(shot, expect) {
  const diffs = [];
  const same = (a, b) => lower(a) === lower(b);
  if (expect.voice !== undefined && (Boolean(shot.voice) !== Boolean(expect.voice) || (expect.voice && !same(shot.voice?.name, expect.voice)))) diffs.push(`voice: ${shot.voice?.name || 'none'}, wanted ${expect.voice || 'none'}`);
  if (expect.join !== undefined && Boolean(shot.join) !== expect.join) diffs.push(`join: ${Boolean(shot.join)}, wanted ${expect.join}`);
  if (shot.scenes.length !== expect.scenes.length) diffs.push(`${shot.scenes.length} scenes, wanted ${expect.scenes.length}`);
  expect.scenes.forEach((ex, i) => {
    const sc = shot.scenes[i];
    if (!sc) return;
    const at = `scene ${i + 1}`;
    if (ex.pick instanceof RegExp && !ex.pick.test(sc.pick || '')) diffs.push(`${at} pick: ${JSON.stringify(sc.pick || '')}, wanted ${ex.pick}`);
    for (const part of ['still', 'video']) {
      const want = ex[part];
      const got = sc[part];
      if (want === null) { if (got) diffs.push(`${at}: has a ${part}, wanted none`); continue; }
      if (!want) continue;
      if (!got) { diffs.push(`${at}: no ${part}`); continue; }
      for (const [k, v] of Object.entries(want)) {
        const g = got[k];
        if (k === 'model') { if (!same(g, v)) diffs.push(`${at} ${part} model: ${g}, wanted ${v}`); }
        else if (k === 'line') {
          if (v === null) { if (g) diffs.push(`${at}: has a line, wanted none`); }
          else if (!g) diffs.push(`${at}: no line`);
          else { if (v.voice && !same(g.voice, v.voice)) diffs.push(`${at} line voice: ${g.voice}, wanted ${v.voice}`); if (v.text && !v.text.test(g.text || '')) diffs.push(`${at} line text: ${JSON.stringify(g.text)}`); }
        } else if (Array.isArray(v)) { if (!(g >= v[0] && g <= v[1])) diffs.push(`${at} ${part} ${k}: ${g}, wanted ${v[0]}–${v[1]}`); }
        else if ((g ?? null) !== (v ?? null)) diffs.push(`${at} ${part} ${k}: ${JSON.stringify(g ?? null)}, wanted ${JSON.stringify(v ?? null)}`);
      }
    }
  });
  return diffs;
}

// ---------- every Brain, every case ----------
const report = { at: new Date().toISOString(), app: JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version, repeat: REPEAT, cases: cases.map(c => c.name), brains: [] };
// ---------- the table (written after every Brain) ----------
const stamp = report.at.slice(0, 16).replace(/[:T]/g, '-');
function tableLines() {
  const lines = [`# Brains on shot lists — ${report.at.slice(0, 16).replace('T', ' ')} (app ${report.app})`, ''];
  if (report.brains.length < tried.length) lines.push(`Unfinished: ${report.brains.length} of ${tried.length} Brains so far.`, '');
  lines.push('| Brain | Right first time | Right in the end | Seconds a request |', '|---|---|---|---|');
  for (const row of report.brains) lines.push(`| ${row.name} | ${row.right ?? '–'}/${row.runs.length} | ${row.valid ?? '–'}/${row.runs.length} | ${row.avgSeconds ?? '–'} |`);
  lines.push('', '## By case', '');
  for (const row of report.brains) {
    lines.push(`### ${row.name}`, '');
    for (const r of row.runs) lines.push(`- ${r.right ? '✓' : '✗'} **${r.case}** (${r.seconds} s; ${r.tools.join(' → ') || 'no tools'}${r.attempts > 1 ? `; ${r.attempts} tries` : ''})${r.diffs?.length ? `: ${r.diffs.join('; ')}` : ''}${r.errors?.length ? `\n  - sent back: ${r.errors.map(e => e.slice(0, 160)).join(' | ')}` : ''}`);
    lines.push('');
  }
  return lines;
}
async function writeReport() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `brain-eval-${stamp}.json`), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(OUT, `brain-eval-${stamp}.md`), tableLines().join('\n'));
}

console.log(`Trying ${tried.length} Brain${tried.length === 1 ? '' : 's'} on ${cases.length} case${cases.length === 1 ? '' : 's'}${REPEAT > 1 ? `, ${REPEAT} times each` : ''} (app ${report.app}).`);
for (const b of tried) {
  console.log(`\n🧠 ${b.name}${b.id !== b.name ? ` (${b.id})` : ''}`);
  const row = { id: b.id, name: b.name, runs: [] };
  report.brains.push(row);
  try {
    await api('/api/settings', { method: 'PUT', body: { llmModel: b.id } });
  } catch (err) {
    console.log(`  couldn't pick it: ${err.message}`);
    row.error = err.message;
    continue;
  }
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const c of cases) {
      let r;
      try {
        let late;
        r = await Promise.race([runCase(c), new Promise((_, j) => { late = setTimeout(() => j(new BrowserHang(`Nothing came back in ${Math.round(TIMEOUT / 1000) + 120} s`)), TIMEOUT + 120000); })]).finally(() => clearTimeout(late));
      } catch (err) {
        r = { case: c.name, seconds: 0, error: err.message, right: false, firstTime: false, attempts: 0, diffs: [err.message], tools: [] };
        if (err.hang) { console.log(`  (the browser hung: ${err.message}; starting it afresh)`); await startChrome().then(openPage).catch(e => console.log(`  (couldn't: ${e.message})`)); }
      }
      row.runs.push(r);
      const mark = r.right ? '✓' : r.timedOut ? '⏱' : '✗';
      const why = r.right ? '' : r.error ? r.error : [r.attempts > 1 ? `${r.attempts} tries` : r.attempts === 0 && !c.tools ? 'no shot_list' : '', ...r.diffs.slice(0, 3), ...(r.errors?.length ? [`sent back: ${r.errors[0].slice(0, 160)}`] : [])].filter(Boolean).join('; ');
      console.log(`  ${mark} ${c.name.padEnd(12)} ${String(r.seconds).padStart(6)} s  ${r.tools.join(' → ') || '(no tools)'}${why ? `\n      ${why}` : ''}`);
    }
  }
  const n = row.runs.length;
  row.right = row.runs.filter(r => r.right).length;
  row.valid = row.runs.filter(r => !r.diffs?.length).length;
  row.avgSeconds = n ? Math.round(row.runs.reduce((a, r) => a + (r.seconds || 0), 0) / n) : 0;
  console.log(`  → right first time ${row.right}/${n}, right in the end ${row.valid}/${n}, about ${row.avgSeconds} s a request`);
  await writeReport().catch(err => console.log(`  (couldn't save the table yet: ${err.message})`)); // after every Brain: a run that stops early keeps what it had
}

// ---------- the table ----------
await writeReport();
const lines = tableLines();
const top = lines.indexOf('| Brain | Right first time | Right in the end | Seconds a request |');
console.log(`\n${lines.slice(top, top + 2 + report.brains.length).join('\n')}\n\nSaved: ${path.join(OUT, `brain-eval-${stamp}.md`)} (and .json)`);
await stop(0);
