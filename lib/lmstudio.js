// Client for LM Studio's local server (OpenAI-compatible API plus its REST model listing).
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { httpError } from './store.js';

// The app is offline-only: refuse anything that isn't this machine or the local network.
export function assertLocalUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, `"${raw}" is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'The LM Studio URL must start with http:// or https://');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local =
    host === 'localhost' ||
    host.endsWith('.local') ||
    (net.isIPv4(host) && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) ||
    (net.isIPv6(host) && (host === '::1' || /^f[cd]/i.test(host) || /^fe80/i.test(host)));
  if (!local) throw httpError(400, 'Offline mode: the LM Studio URL must be localhost or a local-network address.');
  return url.origin;
}

// Turns on LM Studio's local server with its own CLI. Works whether the desktop app is open
// (server switched off) or closed entirely (lms boots LM Studio's background service).
export function startServer(baseUrl) {
  const url = new URL(assertLocalUrl(baseUrl));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw httpError(400, 'Can only start LM Studio on this computer. Start it on the other machine instead.');
  }
  const bin = process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio', 'bin', 'lms');
  const port = url.port || '1234';
  return new Promise((resolve, reject) => {
    execFile(bin, ['server', 'start', '--port', port], { timeout: 60000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (err) {
        const missing = err.code === 'ENOENT';
        reject(httpError(502, missing
          ? 'Could not find LM Studio\'s "lms" tool. Open LM Studio once, then try again.'
          : `LM Studio could not start its server: ${out.split('\n').pop() || err.message}`));
      } else resolve(out);
    });
  });
}

async function getJson(base, pathname, timeoutMs = 4000) {
  const res = await fetch(new URL(pathname, base), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Returns [{ id, name, vision, loaded, thinkSwitch, … }] for chat-capable models (flags are null when unknown).
// thinkSwitch: LM Studio knows how to switch this model's thinking off (it does only for models it recognizes).
// Newer LM Studio also tells: tools (trained for tool calling), params ("27B"), quant, sizeBytes, context.
export async function listLlms(baseUrl) {
  const base = assertLocalUrl(baseUrl);
  try {
    const v1 = await getJson(base, '/api/v1/models');
    if (Array.isArray(v1.models)) {
      return v1.models
        .filter(m => m.type !== 'embedding' && m.type !== 'embeddings')
        .map(m => ({
          id: m.key,
          name: m.display_name || m.key,
          vision: m.capabilities?.vision ?? null,
          loaded: Array.isArray(m.loaded_instances) ? m.loaded_instances.length > 0 : null,
          thinkSwitch: Boolean(m.capabilities?.reasoning?.allowed_options?.includes('off')),
          tools: m.capabilities?.trained_for_tool_use ?? null,
          params: m.params_string || null,
          quant: m.quantization?.name || null,
          sizeBytes: m.size_bytes || null,
          context: m.max_context_length || null,
        }));
    }
  } catch { /* older LM Studio: fall through */ }
  try {
    const v0 = await getJson(base, '/api/v0/models');
    return v0.data
      .filter(m => m.type !== 'embeddings')
      .map(m => ({ id: m.id, name: m.id, vision: m.type === 'vlm', loaded: m.state === 'loaded', thinkSwitch: null }));
  } catch { /* fall through */ }
  const oa = await getJson(base, '/v1/models').catch(() => {
    throw httpError(502, `Can't reach LM Studio at ${base}. Open LM Studio and start the local server (Developer tab, or run: lms server start).`);
  });
  return oa.data.map(m => ({ id: m.id, name: m.id, vision: null, loaded: null, thinkSwitch: null }));
}

// Separates visible output from <think>…</think> reasoning that some models emit inline.
function splitThinking(raw) {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const close = s.lastIndexOf('</think>');
  if (close >= 0) s = s.slice(close + '</think>'.length);
  const open = s.indexOf('<think>');
  if (open >= 0) return { text: s.slice(0, open), thinking: true };
  return { text: s, thinking: false };
}

// The start of an answer whose thinking is already over. Sent as the last message, the model continues after it,
// which switches thinking off for <think>-style models that LM Studio can't switch itself.
export const EMPTY_THINK = { role: 'assistant', content: '<think>\n\n</think>\n\n' };

// Streams a chat completion: { text, toolCalls: [{ id, name, arguments }], finishReason, reasoningChars, thoughtAnyway }.
// Tool calls arrive in pieces (OpenAI style) and are put back together here. With stopIfThinking, the answer is
// cut off as soon as the model starts thinking, and comes back empty with thoughtAnyway set.
// target: LM Studio's address, or an OpenAI-compatible cloud endpoint { url, headers, name } (see cloud.js).
export async function streamCompletion(target, body, { signal, onUpdate, stopIfThinking = false }) {
  const t = typeof target === 'string'
    ? { url: new URL('/v1/chat/completions', assertLocalUrl(target)).href, headers: {}, name: 'LM Studio', local: true }
    : target;
  const stop = new AbortController();
  let thoughtAnyway = false;
  let res;
  try {
    res = await fetch(t.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...t.headers },
      body: JSON.stringify({ ...body, stream: true }),
      signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw httpError(502, t.local ? `Can't reach LM Studio at ${new URL(t.url).origin}. Is its local server running?` : `Can't reach ${t.name}. Check your internet connection.`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let msg = detail;
    try { msg = JSON.parse(detail).error?.message || JSON.parse(detail).error || detail; } catch { /* keep raw */ }
    throw httpError(502, `${t.name} error (${res.status}): ${String(msg).slice(0, 400) || res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buf = '';
  let raw = '';
  let reasoningChars = 0;
  let finishReason = null;
  const calls = [];
  let last = { text: '', thinking: false, reasoningChars: 0 };
  let lastSent = 0;

  const handle = data => {
    if (data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.error) throw httpError(502, `LM Studio error: ${json.error.message || json.error}`);
    const choice = json.choices?.[0] || {};
    const delta = choice.delta || {};
    if (choice.finish_reason) finishReason = choice.finish_reason;
    reasoningChars += (delta.reasoning_content || delta.reasoning || '').length;
    if (delta.content) raw += delta.content;
    for (const tc of delta.tool_calls || []) {
      const c = (calls[tc.index ?? calls.length] ||= { id: '', name: '', arguments: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.arguments += tc.function.arguments;
    }
    const split = splitThinking(raw);
    const thinking = split.thinking || (reasoningChars > 0 && !split.text.trim());
    const next = { text: split.text.trimStart(), thinking, reasoningChars: thinking ? reasoningChars + raw.length - split.text.length : 0 };
    if (stopIfThinking && thinking) {
      thoughtAnyway = true;
      stop.abort();
      return;
    }
    // Visible text changes go out immediately; thinking progress at most ~4×/s.
    const changed = next.text !== last.text || next.thinking !== last.thinking;
    if (changed || (thinking && Date.now() - lastSent > 250)) {
      last = next;
      lastSent = Date.now();
      onUpdate?.(next);
    }
  };

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0 && !thoughtAnyway) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
      if (thoughtAnyway) break;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    if (thoughtAnyway) return { text: '', toolCalls: [], finishReason: null, reasoningChars, thoughtAnyway };
    if (err.name === 'AbortError') throw err;
    const partial = splitThinking(raw).text.trim();
    const e = err.status ? err : httpError(502, 'LM Studio stopped responding in the middle of an answer. Is it still running?');
    throw Object.assign(e, { partial });
  }
  if (thoughtAnyway) return { text: '', toolCalls: [], finishReason: null, reasoningChars, thoughtAnyway };
  if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
  const text = splitThinking(raw).text.trim();
  const toolCalls = calls.filter(c => c?.name).map((c, i) => ({ id: c.id || `call_${i + 1}`, name: c.name, arguments: c.arguments }));
  return { text, toolCalls, finishReason, reasoningChars, thoughtAnyway };
}
