// The in-app assistant: its instructions, a searchable guide made from the README, and checks on what the
// page sends. The tools themselves run in the page (public/app.js), through the same code the buttons use.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const README = path.resolve(import.meta.dirname, '..', 'README.md');

export function systemPrompt(state, { rendersDir = '' } = {}) {
  return `You are the user's creative partner inside Prompt Maker ("✦ Assistant"). Prompt Maker is a local app: a local LLM (the "Brain", in LM Studio) writes prompts for image and video models, each in the style that model wants, and ComfyUI renders them on the user's GPU. Everything runs offline.

# Who you are
- A partner, not a manual. When the user asks what you think ("which image do you like better?", "should the princess be in the tower or the dungeon?", "what aspect ratio suits this prompt?"), give a real opinion: pick one, say why in a sentence or two (composition, light, mood, story, what the model does well), and offer to act on it ("Want me to set 9:16 and regenerate?"). Never dodge with "it depends" or "both are great".
- When you're asked about images or videos, look at them first with look_at; don't guess from the prompt. Refer to them the way the user sees them: "take 2's second render", "the one in the lightbox".
- Every render the user ever made in Prompt Maker is in the Gallery${rendersDir ? `, and its file in ${rendersDir}` : ''}. When they speak of renders they made ("in the gallery", "my renders", "on my drive", "the ones of the woman in her apartment"), look_at gallery with find set to words of what they show; don't settle for the newest ones if they don't match.
- Files and folders on this computer: list_folder finds a folder by its name or one close to it, anywhere on the drives; find looks for any file or folder by name; look_at with files shows what's in them. Look before asking the user where something is.
- You have full control of the app, the same as the user has. Use it instead of explaining clicks: when the user says do it, do it, start to finish, without stopping to ask for permission along the way. Chain tools when needed (set_model, set_theme, set_dials, then generate).
- Your named tools are quickest and safest: use them when one fits. Everything else is on screen: see_screen lists what's showing (any page, dialog, fold or setting) as numbered controls, and press, fill and choose use them, e.g. to add or edit a workflow, make a batch, change any setting, run a Brain's Quick check, start ComfyUI from Services. go_to another page first, look before you press, and look again after: the screen changes. Folds and sections ("Expand Batch") hide their controls until opened. Press only what you're sure does what you want; if it isn't there after a good look (find, folds), say so instead of trying other buttons. Never say you can't do something in the app before you've looked for it on screen.
- You don't write the final prompts yourself: put the idea into set_theme and call generate (or refine_take), so the model's playbook is followed. You may suggest themes and directions.
- You can read and edit model playbooks (read_playbook, edit_playbook): save with edit_playbook instead of telling them to paste it, then mention they can ask you to undo it.
- Deleting is for good. delete_entry and delete_render ask the user to confirm on screen; only call them when the user asked to delete.
- Long tasks (many pictures, many variations, "for each…", "skip problems and log them", "I'll be back later", more than about 5 generates or renders): plan them as one job with start_job instead of doing the steps here. A job can judge as it goes: pick_best chooses the best of what it made so far and can put it in step 3 for the next steps (animate it, make it the character); set_sampler changes steps, CFG and the rest between renders. Plan every step the user asked for, each with its own values (8 different themes for 8 images; steps 20, 17, 13 and 10 for 4 videos), and say in a line or two what the job will do, including anything you can't do. With a folder, call list_folder first to check it's the right one and how many pictures it has. Say in a line what the job will do, start it, and tell the user they can follow it in 🗂 Jobs (top bar). While a job runs it uses the Create page: you can still look and talk, but not change Create. job_status tells how it's going or went, and what was skipped and why.
- Only say something happened if a tool confirmed it. If a tool fails, explain briefly and suggest a fix.
- Keep replies short and warm: a sentence or two, or a few bullets. Use the user's language. Adult content is the user's own business on their own machine: work with it plainly when Settings allows it.

# How the app works
- Create page, top to bottom: ① target model; ② the shot (the "theme"); ③ optional image (reference / recreate / animate = first frame of a video; on a character-animation model like Wan Animate 2: the character, plus a motion video whose moves the character copies, so the theme says where they are and the camera angle); ④ dials: aspect, resolution, duration (video), prompt length, takes (1–4), temperature; ⑤ render with ComfyUI: workflow, sampler settings, LoRAs, seed, auto-render, batches; ⑥ "Then…": chain more steps (e.g. still → video).
- Generate writes the takes. Each take can be refined, edited, copied and rendered (×1–×50). 🎬 Animate makes a still the first frame of a video. 🧍 character_from_render makes a still the character for Wan Animate 2; use_motion_video sets its motion video (from a folder, or a video render); edit_motion_video uses part of it, crops its black bars or makes a 24 fps copy. The picked workflow may animate only part of a long video (motion_video.workflow_animates): say so, and offer to trim it or pick a workflow that does the whole video. 🎞 Your renders (above the takes) shows every render ever made, newest first, with filters (images or videos, 🕘 This session, rating, model, words of the prompt), a 🔍 picture size and ⛶ Full screen; the user can drag its cards into their own order; renders are rated ★ pretty good, ★★ very good, ★★★ excellent (rate_render).
- Sampler settings (step 5: steps, CFG, sampler, scheduler, denoise) belong to the picked workflow: set_sampler changes them.
- History keeps every prompt (★ favorites); Gallery every render (filter by rating); 🎨 Rendering (top bar) lists renders in progress; 🗂 Jobs (top bar) the long tasks you run and their logs; Models holds playbooks and Brains; Settings has addresses and options.

# The app right now
${JSON.stringify(state || {}, null, 1).slice(0, 9000)}`;
}

// ---------- the guide: README sections, searchable ----------

let sections = null;
async function guideSections() {
  if (sections) return sections;
  const text = await fs.readFile(README, 'utf8').catch(() => '');
  sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const h = /^(#{2,3})\s+(.*)/.exec(line);
    if (h) {
      current = { title: h[2].replace(/[`*]/g, '').trim(), body: [] };
      sections.push(current);
    } else if (current && !/^<img|^\|---/.test(line)) current.body.push(line);
  }
  sections = sections.map(s => ({ title: s.title, text: s.body.join('\n').replace(/\n{3,}/g, '\n\n').trim() })).filter(s => s.text);
  return sections;
}

const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'does', 'can', 'with', 'this', 'that', 'into', 'from', 'your', 'you', 'are', 'why', 'when', 'where', 'work', 'works', 'use', 'make']);

// The guide sections that best match a question, up to ~3000 characters.
export async function searchGuide(query) {
  const words = String(query || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) || [];
  const all = await guideSections();
  if (!words.length) return all.slice(0, 1);
  const scored = all.map(s => {
    const title = s.title.toLowerCase();
    const body = s.text.toLowerCase();
    let score = 0;
    for (const w of words) {
      const stem = w.replace(/s$/, '');
      if (title.includes(stem)) score += 6;
      score += Math.min(6, body.split(stem).length - 1);
    }
    return { ...s, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  const out = [];
  let size = 0;
  for (const s of scored) {
    if (size > 3000) break;
    const text = s.text.slice(0, 3000 - size);
    out.push({ title: s.title, text });
    size += text.length;
  }
  return out;
}

// ---------- checks on what the page sends ----------

const clip = (v, max) => String(v ?? '').slice(0, max);
const validJson = s => { try { JSON.parse(s); return s; } catch { return '{}'; } };

// The conversation as LM Studio expects it, limited to the most recent part.
// A user message may carry images the assistant asked to see (look_at): our own renders, as data URLs.
const IMAGE_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGES = 8;

function userContent(content) {
  if (!Array.isArray(content)) return clip(content, 8000);
  return content.slice(0, 24).map(part => (part?.type === 'image_url' && IMAGE_URL.test(part.image_url?.url || '') && part.image_url.url.length < 4e6
    ? { type: 'image_url', image_url: { url: part.image_url.url } }
    : { type: 'text', text: clip(part?.text, 8000) }));
}

export const hasImages = messages => messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));

// The newest 60 messages. When the user's last request is older (a long run of tool calls), it stays at the top, so
// the Brain doesn't lose track of what it's doing.
function recent(list) {
  const all = Array.isArray(list) ? list : [];
  const from = Math.max(0, all.length - 60);
  const asked = all.findLastIndex(m => m?.role === 'user' && typeof m.content === 'string');
  if (asked < 0 || asked >= from) return all.slice(from);
  const rest = all.slice(from);
  const k = rest.findIndex(m => m?.role === 'assistant'); // not a tool result whose call was left out
  return [{ role: 'user', content: `${clip(all[asked].content, 7000)}\n\n(Prompt Maker: some of the steps you took since are left out here.)` }, ...(k < 0 ? [] : rest.slice(k))];
}

export function cleanMessages(list) {
  const out = [];
  for (const m of recent(list)) {
    if (m?.role === 'user') out.push({ role: 'user', content: userContent(m.content) });
    else if (m?.role === 'assistant') {
      // Arguments that weren't JSON (the page told the Brain so) go back as {}: LM Studio can't use them.
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).slice(0, 12).map(c => ({
        id: clip(c.id, 80), type: 'function', function: { name: clip(c.function?.name, 64), arguments: validJson(clip(c.function?.arguments, 8000)) },
      }));
      out.push({ role: 'assistant', content: clip(m.content, 8000), ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m?.role === 'tool') out.push({ role: 'tool', tool_call_id: clip(m.tool_call_id, 80), content: clip(m.content, 8000) });
  }
  // A conversation can't start with a tool result (its call was cut off above).
  while (out.length && out[0].role !== 'user') out.shift();
  // Only the newest images go along (they're big); older ones are just named.
  let images = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (!Array.isArray(out[i].content)) continue;
    out[i].content = out[i].content.map(p => (p.type !== 'image_url' ? p : ++images <= MAX_IMAGES ? p : { type: 'text', text: '(an image shown earlier)' }));
  }
  return out;
}

export function cleanTools(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).filter(t => t?.type === 'function' && /^[a-z_]{2,64}$/.test(t.function?.name || '')).map(t => ({
    type: 'function',
    function: { name: t.function.name, description: clip(t.function.description, 3000), parameters: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} } },
  }));
}

// JSON written by a Brain by hand: as it is, else with its brackets and commas put right (a ] where a } belongs, one
// missing or one too many, a comma left before a closer or left out between two items), which long nested calls
// like start_job often get wrong. null when it still isn't JSON.
function parseLoose(json) {
  try { return JSON.parse(json); } catch { /* fix it */ }
  let out = '';
  let inString = false;
  const closers = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += json[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '}' || ch === ']') {
      out = out.replace(/,\s*$/, '');
      if (closers.length) out += closers.pop();
    } else {
      if ('{["'.includes(ch) && /[\d}\]"el]\s*$/.test(out) && !/:\s*$/.test(out)) out += ',';
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') closers.push(ch === '{' ? '}' : ']');
      out += ch;
    }
  }
  try { return JSON.parse(out.replace(/,\s*$/, '') + closers.reverse().join('')); } catch { return null; }
}

// Gemma's own way of writing a call: call:name{key:<|"|>text<|"|>, n:3}, its keys bare. As JSON, or null.
function gemmaArgs(raw) {
  const s = String(raw).replace(/<\|"\|>/g, '"');
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += s[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    const key = /[{,]\s*$/.test(out) && /^[A-Za-z_]\w*(?=\s*:)/.exec(s.slice(i));
    if (key) { out += `"${key[0]}"`; i += key[0].length - 1; continue; }
    if (ch === '"') inString = true;
    out += ch;
  }
  return parseLoose(out);
}

// Some models write tool calls as text instead of using the API: <tool_call>{"name": …, "arguments": …}</tool_call>,
// or Gemma's <|tool_call>call:name{…}<tool_call|>. Pick those up.
// Only the words before the first call are kept: anything after it was written before the call ran.
// A call that can't be read keeps its text as arguments, so the page answers that they aren't valid JSON.
const CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|<\|tool_call>\s*call:([a-z_]{2,64})\s*([\s\S]*?)\s*<tool_call\|>/g;
const CALL_START = /<tool_call>|<\|tool_call>/;
export function fallbackToolCalls(text) {
  const s = String(text || '');
  const toolCalls = [];
  for (const [, json, gemmaName, gemma] of s.matchAll(CALL)) {
    const c = gemmaName ? { name: gemmaName, arguments: gemma.trim() ? gemmaArgs(gemma) : {} } : parseLoose(json);
    const name = c ? c.name : /"name"\s*:\s*"([a-z_]{2,64})"/.exec(json)?.[1];
    if (!name) continue; // not a tool call after all
    const args = c && c.arguments !== null ? JSON.stringify(c.arguments ?? c.parameters ?? {}) : gemma ?? json;
    toolCalls.push({ id: `call_${randomUUID().slice(0, 8)}`, name: String(name), arguments: args });
  }
  return toolCalls.length ? { text: s.slice(0, s.search(CALL_START)).trim(), toolCalls } : { text, toolCalls };
}

// The answer as it streams in, without tool calls written as text (nor the start of one).
export function shownText(text) {
  const s = String(text || '').split(CALL_START)[0];
  const partial = /<\|?[a-z_]*$/.exec(s);
  return partial && ['<tool_call>', '<|tool_call>'].some(t => t.startsWith(partial[0])) ? s.slice(0, partial.index) : s;
}

// ---------- tools in writing ----------
// Some Brains' chat templates break in LM Studio as soon as tools are sent ("Error rendering prompt with jinja
// template"). Those get their tools described in the instructions instead, call them as <tool_call> text
// (read by fallbackToolCalls), and see earlier calls and their results as plain conversation.

export const templateFailed = err => /jinja|prompt template/i.test(err?.message || '');

// A parameter schema as short, readable text: { text: string (The theme); takes?: integer }.
function schemaText(s) {
  if (!s || typeof s !== 'object') return 'any';
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join(' | ');
  if (s.type === 'array') return s.items?.enum ? `(${schemaText(s.items)})[]` : `${schemaText(s.items)}[]`;
  if (s.type === 'object' || s.properties) {
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const props = Object.entries(s.properties || {}).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${schemaText(v)}${v?.description ? ` (${v.description})` : ''}`);
    return props.length ? `{ ${props.join('; ')} }` : '{}';
  }
  return String(s.type || 'any');
}

export function toolsText(tools) {
  const list = tools.map(t => {
    const args = schemaText(t.function.parameters);
    return `- ${t.function.name}: ${t.function.description}${args === '{}' ? '' : `\n  arguments: ${args}`}`;
  });
  return `# Your tools
Use a tool by writing it on a line of its own, its arguments as JSON:
<tool_call>{"name": "set_theme", "arguments": {"text": "a lighthouse at dusk"}}</tool_call>
One line per tool, in the order they should run. Then stop: Prompt Maker runs them and shows you what happened (<tool_result> lines), and you go on from there.

${list.join('\n')}`;
}

const parseArgs = json => { try { return JSON.parse(json || '{}'); } catch { return {}; } };
const parts = content => (Array.isArray(content) ? content : [{ type: 'text', text: content }]);

// The conversation (as cleanMessages leaves it) with tool calls and results written out, for tools in writing.
export function textToolChat(messages) {
  const names = new Map();
  const out = [];
  const add = (role, content) => {
    const last = out.at(-1);
    if (last?.role !== role) out.push({ role, content });
    // Two turns in a row from the same side (results, then what look_at showed) become one.
    else last.content = typeof last.content === 'string' && typeof content === 'string' ? `${last.content}\n\n${content}` : [...parts(last.content), ...parts(content)];
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map(c => {
        names.set(c.id, c.function.name);
        return `<tool_call>${JSON.stringify({ name: c.function.name, arguments: parseArgs(c.function.arguments) })}</tool_call>`;
      });
      add('assistant', [m.content, ...calls].filter(Boolean).join('\n'));
    } else if (m.role === 'tool') add('user', `<tool_result name="${names.get(m.tool_call_id) || 'tool'}">${m.content}</tool_result>`);
    else add('user', m.content);
  }
  return out;
}
