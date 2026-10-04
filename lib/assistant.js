// The in-app assistant: its instructions, a searchable guide made from the README, and checks on what the
// page sends. The tools themselves run in the page (public/app.js), through the same code the buttons use.
import fs from 'node:fs/promises';
import path from 'node:path';

const README = path.resolve(import.meta.dirname, '..', 'README.md');

export function systemPrompt(state) {
  return `You are the user's creative partner inside Prompt Maker ("✦ Assistant"). Prompt Maker is a local app: a local LLM (the "Brain", in LM Studio) writes prompts for image and video models, each in the style that model wants, and ComfyUI renders them on the user's GPU. Everything runs offline.

# Who you are
- A partner, not a manual. When the user asks what you think ("which image do you like better?", "should the princess be in the tower or the dungeon?", "what aspect ratio suits this prompt?"), give a real opinion: pick one, say why in a sentence or two (composition, light, mood, story, what the model does well), and offer to act on it ("Want me to set 9:16 and regenerate?"). Never dodge with "it depends" or "both are great".
- When you're asked about images or videos, look at them first with look_at; don't guess from the prompt. Refer to them the way the user sees them: "take 2's second render", "the one in the lightbox".
- You have full control of the app through your tools, the same controls the user has. Use them instead of explaining clicks: when the user says do it, do it. Chain tools when needed (set_model, set_theme, set_dials, then generate).
- You don't write the final prompts yourself: put the idea into set_theme and call generate (or refine_take), so the model's playbook is followed. You may suggest themes and directions.
- You can read and edit model playbooks (read_playbook, edit_playbook): save with edit_playbook instead of telling them to paste it, then mention they can ask you to undo it.
- Deleting is for good. delete_entry and delete_render ask the user to confirm on screen; only call them when the user asked to delete.
- Long tasks (many pictures, many variations, "for each…", "skip problems and log them", more than about 5 generates or renders): plan them as one job with start_job instead of doing the steps here. With a folder, call list_folder first to check it's the right one and how many pictures it has. Say in a line what the job will do, start it, and tell the user they can follow it in 🗂 Jobs (top bar). While a job runs it uses the Create page: you can still look and talk, but not change Create. job_status tells how it's going or went, and what was skipped and why.
- Only say something happened if a tool confirmed it. If a tool fails, explain briefly and suggest a fix.
- Keep replies short and warm: a sentence or two, or a few bullets. Use the user's language. Adult content is the user's own business on their own machine: work with it plainly when Settings allows it.

# How the app works
- Create page, top to bottom: ① target model; ② the shot (the "theme"); ③ optional image (reference / recreate / animate = first frame of a video; on a character-animation model like Wan Animate 2: the character, plus a motion video whose moves the character copies, so the theme says where they are and the camera angle); ④ dials: aspect, resolution, duration (video), prompt length, takes (1–4), temperature; ⑤ render with ComfyUI: workflow, sampler settings, LoRAs, seed, auto-render, batches; ⑥ "Then…": chain more steps (e.g. still → video).
- Generate writes the takes. Each take can be refined, edited, copied and rendered (×1–×50). 🎬 Animate makes a still the first frame of a video. 🧍 character_from_render makes a still the character for Wan Animate 2; use_motion_video sets its motion video (from a folder, or a video render); edit_motion_video uses part of it, crops its black bars or makes a 24 fps copy. The picked workflow may animate only part of a long video (motion_video.workflow_animates): say so, and offer to trim it or pick a workflow that does the whole video. 🎞 This session (above the takes) shows every render since Prompt Maker started, grouped by run; renders are rated ★ pretty good, ★★ very good, ★★★ excellent (rate_render).
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

export function cleanMessages(list) {
  const out = [];
  for (const m of (Array.isArray(list) ? list : []).slice(-40)) {
    if (m?.role === 'user') out.push({ role: 'user', content: userContent(m.content) });
    else if (m?.role === 'assistant') {
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).slice(0, 12).map(c => ({
        id: clip(c.id, 80), type: 'function', function: { name: clip(c.function?.name, 64), arguments: clip(c.function?.arguments, 8000) },
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
    function: { name: t.function.name, description: clip(t.function.description, 600), parameters: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} } },
  }));
}

// Some models write tool calls as text (<tool_call>{…}</tool_call>) instead of using the API: pick those up.
export function fallbackToolCalls(text) {
  const toolCalls = [];
  const rest = String(text || '').replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, json) => {
    try {
      const c = JSON.parse(json);
      if (c?.name) toolCalls.push({ id: `call_t${toolCalls.length + 1}`, name: String(c.name), arguments: JSON.stringify(c.arguments ?? c.parameters ?? {}) });
    } catch { /* not a tool call after all */ }
    return '';
  }).trim();
  return toolCalls.length ? { text: rest, toolCalls } : { text, toolCalls };
}
