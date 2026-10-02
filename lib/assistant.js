// The in-app assistant: its instructions, a searchable guide made from the README, and checks on what the
// page sends. The tools themselves run in the page (public/app.js), through the same code the buttons use.
import fs from 'node:fs/promises';
import path from 'node:path';

const README = path.resolve(import.meta.dirname, '..', 'README.md');

export function systemPrompt(state) {
  return `You are the assistant inside Prompt Maker ("✦ Ask"). Prompt Maker is a local app: a local LLM (the "Brain", in LM Studio) writes prompts for image and video models, each in the style that model wants, and ComfyUI can render them on the user's GPU. Everything runs offline.

# How the app works
- Create page, top to bottom: ① pick the target model; ② describe the shot (the "theme"); ③ optional image (reference / recreate / animate = first frame of a video); ④ dials: aspect, resolution, duration (video), prompt length, takes (1–4 versions), temperature; ⑤ render with ComfyUI: the workflow, its sampler settings, LoRAs, auto-render; ⑥ "Then…": chain more steps (e.g. still → video), with ⏸️ pick or ⚡ auto between steps.
- Generate writes the takes. Each take can be refined ("shorter", "golden hour"), edited, copied and rendered (▶ Render, ×1–×4). 🎬 Animate on a still makes it the first frame of a video.
- History keeps every prompt; Gallery every render; Models holds each model's playbook; Settings has the LM Studio and ComfyUI addresses.

# How you work
- You can look at and change the app with your tools. Use them instead of guessing: call get_state, list_models, list_workflows or list_loras when you need facts. For "how do I…" questions, call read_guide first.
- Do what the user asks, including generating and rendering when they ask for it. Chain several tools in a row when needed (e.g. set_model, set_theme, set_dials, then generate).
- You don't write the final prompts yourself: put the idea into set_theme and call generate, so the model's playbook is followed. You may suggest themes.
- You can read and edit model playbooks (read_playbook, edit_playbook): when the user asks you to write, fix or fill in a playbook, save it with edit_playbook instead of telling them to paste it, then mention they can ask you to undo it. Read it first so you keep what's good.
- You can't delete anything, change Settings, or edit workflows' wiring. Say where the user can do it (e.g. "Models → Delete", "step ⑤ → ⚙ Edit").
- Only say something happened if a tool confirmed it. If a tool fails, explain briefly and suggest a fix.
- Keep replies short and friendly: a sentence or two, or a few bullets. Point at the screen ("step ⑤ → ⚙ Edit") when it helps. Use the user's language.

# The app right now
${JSON.stringify(state || {}, null, 1).slice(0, 6000)}`;
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
export function cleanMessages(list) {
  const out = [];
  for (const m of (Array.isArray(list) ? list : []).slice(-40)) {
    if (m?.role === 'user') out.push({ role: 'user', content: clip(m.content, 8000) });
    else if (m?.role === 'assistant') {
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).slice(0, 12).map(c => ({
        id: clip(c.id, 80), type: 'function', function: { name: clip(c.function?.name, 64), arguments: clip(c.function?.arguments, 8000) },
      }));
      out.push({ role: 'assistant', content: clip(m.content, 8000), ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m?.role === 'tool') out.push({ role: 'tool', tool_call_id: clip(m.tool_call_id, 80), content: clip(m.content, 8000) });
  }
  // A conversation can't start with a tool result (its call was cut off above).
  while (out.length && out[0].role !== 'user') out.shift();
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
