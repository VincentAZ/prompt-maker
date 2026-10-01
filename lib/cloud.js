// Cloud Brains: LLMs from providers you add yourself (Settings → Cloud Brains). Prompt Maker ships with none and
// runs 100% offline until you add one. The provider list below comes with the app (and updates with it); each
// provider's models are fetched live from the provider, only once you've added your key.
//
// Two kinds of API: most providers speak OpenAI's chat format (the same as LM Studio), Anthropic has its own.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, httpError } from './store.js';

export const CATALOG = [
  { preset: 'anthropic', name: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { preset: 'openai', name: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { preset: 'openrouter', name: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { preset: 'google', name: 'Google Gemini', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  { preset: 'xai', name: 'xAI Grok', api: 'openai', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' },
  { preset: 'moonshot', name: 'Kimi (Moonshot)', api: 'openai', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { preset: 'deepseek', name: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { preset: 'mistral', name: 'Mistral', api: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { preset: 'groq', name: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { preset: 'custom', name: 'Custom (OpenAI-compatible)', api: 'openai', baseUrl: '', keyUrl: '' },
];

const FILE = () => path.join(DATA_DIR, 'providers.json'); // your providers and their keys: readable by you only
const PREFIX = 'cloud:'; // a cloud Brain's id: cloud:<provider id>:<model id>

export const isCloudId = id => String(id || '').startsWith(PREFIX);
function splitId(id) {
  const rest = String(id).slice(PREFIX.length);
  const at = rest.indexOf(':');
  return { providerId: rest.slice(0, at), model: rest.slice(at + 1) };
}

async function readProviders() {
  try {
    return JSON.parse(await fs.readFile(FILE(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
async function writeProviders(list) {
  await fs.writeFile(FILE(), JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(FILE(), 0o600).catch(() => {});
}

// A cloud address must be https (a local test server may use http).
function checkBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw httpError(400, 'Enter the provider\'s API address, e.g. https://api.example.com/v1');
  }
  const local = /^(127\.|localhost$|\[::1\]$)/.test(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw httpError(400, 'Cloud providers must use https://');
  return url.href.replace(/\/+$/, '');
}

const target = p => ({ ...CATALOG.find(c => c.preset === p.preset), ...p });
const keyHint = key => (key.length > 8 ? `…${key.slice(-4)}` : '…');

// What the page may see: never the key itself.
export async function listProviders() {
  return (await readProviders()).map(p => ({
    id: p.id, preset: p.preset, name: p.name, baseUrl: p.baseUrl, keyHint: keyHint(p.key), trusted: Boolean(p.trusted),
    models: cache.get(p.id)?.models.length ?? null, error: cache.get(p.id)?.error || '',
  }));
}

// Adds a provider after checking the key works (by listing its models).
export async function addProvider({ preset, name, baseUrl, key }) {
  const base = CATALOG.find(c => c.preset === preset);
  if (!base) throw httpError(400, 'Pick a provider.');
  key = String(key || '').trim();
  if (!key) throw httpError(400, 'Paste your API key.');
  const p = {
    id: crypto.randomUUID().slice(0, 8),
    preset,
    name: String(name || '').trim().slice(0, 60) || base.name,
    baseUrl: checkBaseUrl(preset === 'custom' ? baseUrl : base.baseUrl),
    key,
    trusted: false,
  };
  const models = await fetchModels(p); // throws a clear error if the key or address is wrong
  cache.set(p.id, { at: Date.now(), models, error: '' });
  await writeProviders([...(await readProviders()), p]);
  return { id: p.id, name: p.name, models: models.length };
}

export async function removeProvider(id) {
  await writeProviders((await readProviders()).filter(p => p.id !== id));
  cache.delete(id);
}

// "Don't ask again" for one provider, or (id null, trusted false) bring every question back.
export async function setTrusted(id, trusted) {
  await writeProviders((await readProviders()).map(p => (id === null || p.id === id ? { ...p, trusted: Boolean(trusted) } : p)));
}

// ---------- models ----------

const cache = new Map(); // provider id → { at, models, error }
const FRESH = 10 * 60 * 1000;

function headers(p) {
  return p.api === 'anthropic'
    ? { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' };
}

// Chat models only: providers also list embedding, speech, image and moderation models.
const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|transcri|realtime|audio|imagen|image-gen|gpt-image|veo|aqa|rerank/i;

async function fetchModels(provider) {
  const p = target(provider);
  let res;
  try {
    res = await fetch(`${p.baseUrl}/models${p.api === 'anthropic' ? '?limit=1000' : ''}`, { headers: headers(p), signal: AbortSignal.timeout(15000) });
  } catch {
    throw httpError(502, `Can't reach ${p.name} at ${p.baseUrl}. Check your internet connection and the address.`);
  }
  if (res.status === 401 || res.status === 403) throw httpError(400, `${p.name} didn't accept that API key.`);
  if (!res.ok) throw httpError(502, `${p.name} answered ${res.status} when asked for its models.`);
  const data = (await res.json().catch(() => ({}))).data || [];
  return data
    .filter(m => m.id && !NOT_CHAT.test(m.id))
    .map(m => {
      const inputs = m.architecture?.input_modalities; // OpenRouter tells
      return {
        id: `${PREFIX}${p.id}:${m.id}`,
        name: `${m.display_name || m.name || m.id} · ${p.name}`,
        vision: p.api === 'anthropic' ? true : Array.isArray(inputs) ? inputs.includes('image') : null,
        loaded: true, // nothing to load
        thinkSwitch: true, // no local thinking workaround needed
        cloud: p.name,
        providerId: p.id,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every cloud Brain from every provider you added (cached for 10 minutes; a provider that fails is skipped).
export async function listModels({ fresh = false } = {}) {
  const providers = await readProviders();
  const lists = await Promise.all(providers.map(async p => {
    const hit = cache.get(p.id);
    if (hit && !fresh && Date.now() - hit.at < FRESH) return hit.models;
    try {
      const models = await fetchModels(p);
      cache.set(p.id, { at: Date.now(), models, error: '' });
      return models;
    } catch (err) {
      cache.set(p.id, { at: Date.now(), models: hit?.models || [], error: err.message });
      return hit?.models || [];
    }
  }));
  return lists.flat();
}

// ---------- chat ----------

// Streams a chat completion from a cloud Brain, in the same shape as lmstudio.streamCompletion.
export async function stream(llmId, body, opts, streamOpenAi) {
  const { providerId, model } = splitId(llmId);
  const provider = (await readProviders()).find(p => p.id === providerId);
  if (!provider) throw httpError(400, 'That cloud provider was removed. Pick another Brain.');
  const p = target(provider);
  const { reasoning_effort: effort, ...rest } = body;
  if (p.api === 'anthropic') return streamAnthropic(p, { ...rest, model }, opts);
  // "Thinking: Off" means: don't ask for any (sending "none" breaks models that don't reason).
  const req = { ...rest, model, ...(effort && effort !== 'none' ? { reasoning_effort: effort } : {}) };
  return streamOpenAi({ url: `${p.baseUrl}/chat/completions`, headers: headers(p), name: p.name }, req, opts);
}

// OpenAI-style messages → Anthropic's: system apart, images as base64 blocks, tool calls and results as blocks.
function toAnthropic(messages) {
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  const blocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : (content || []).map(part => {
    if (part.type !== 'image_url') return { type: 'text', text: part.text || '' };
    const m = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url?.url || '');
    return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'text', text: '' };
  })).filter(b => b.type !== 'text' || b.text);
  for (const msg of messages) {
    if (msg.role === 'system') system.push(typeof msg.content === 'string' ? msg.content : blocks(msg.content).map(b => b.text).join('\n'));
    else if (msg.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: String(msg.content ?? '') }]);
    else if (msg.role === 'assistant') {
      const calls = (msg.tool_calls || []).map(c => {
        let input = {};
        try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* keep {} */ }
        return { type: 'tool_use', id: c.id, name: c.function?.name, input };
      });
      const all = [...blocks(msg.content), ...calls];
      if (all.length) push('assistant', all);
    } else push('user', blocks(msg.content));
  }
  return { system: system.join('\n\n'), messages: out };
}

async function streamAnthropic(p, body, { signal, onUpdate }) {
  const { system, messages } = toAnthropic(body.messages);
  const req = {
    model: body.model,
    max_tokens: body.max_tokens || 4096,
    temperature: Math.min(1, body.temperature ?? 0.8), // Anthropic takes 0–1, and not together with top_p
    system,
    messages,
    stream: true,
    ...(body.tools?.length ? { tools: body.tools.map(t => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } })) } : {}),
  };
  let res;
  try {
    res = await fetch(`${p.baseUrl}/messages`, { method: 'POST', headers: headers(p), body: JSON.stringify(req), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw httpError(502, `Can't reach ${p.name}. Check your internet connection.`);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw httpError(502, `${p.name} error (${res.status}): ${String(detail.error?.message || res.statusText).slice(0, 400)}`);
  }
  let text = '';
  let reasoningChars = 0;
  let finishReason = null;
  const calls = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === 'error') throw httpError(502, `${p.name} error: ${ev.error?.message || 'unknown'}`);
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') calls[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, arguments: '' };
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta') text += d.text;
        if (d.type === 'thinking_delta') reasoningChars += (d.thinking || '').length;
        if (d.type === 'input_json_delta' && calls[ev.index]) calls[ev.index].arguments += d.partial_json;
        onUpdate?.({ text: text.trimStart(), thinking: !text && reasoningChars > 0, reasoningChars });
      }
      if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        finishReason = { max_tokens: 'length', tool_use: 'tool_calls' }[ev.delta.stop_reason] || 'stop';
      }
    }
  }
  return { text: text.trim(), toolCalls: calls.filter(Boolean), finishReason, reasoningChars, thoughtAnyway: false };
}
