// A fake LM Studio server for UI tests: deterministic streaming, a text-only model,
// a "thinking" model, failures and slow responses, triggered by words in the theme.
//   FAILTEST  → HTTP 500        EMPTYTEST → hits the token limit with no output
//   SLOWTEST  → very slow stream  SLOWSECOND → only takes 2+ are slow
import http from 'node:http';

const MODELS = [
  { key: 'mock/vision-8b', display_name: 'Mock Vision 8B', type: 'llm', capabilities: { vision: true }, loaded_instances: [{ id: 'mock/vision-8b' }] },
  { key: 'mock/thinker', display_name: 'Mock Thinker 9B', type: 'llm', capabilities: { vision: true }, loaded_instances: [] },
  { key: 'mock/text-only', display_name: 'Mock Text 7B', type: 'llm', capabilities: { vision: false }, loaded_instances: [] },
  { key: 'mock/embed', display_name: 'Embedder', type: 'embedding', loaded_instances: [] },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = c => (typeof c === 'string' ? c : c.filter(p => p.type === 'text').map(p => p.text).join('\n'));

function cannedPrompt(body) {
  const system = body.messages[0].content;
  const users = body.messages.filter(m => m.role === 'user');
  const last = textOf(users.at(-1).content);
  const first = textOf(users[0].content);
  const hasImage = users.some(u => Array.isArray(u.content) && u.content.some(p => p.type === 'image_url'));
  const theme = (/THEME: (.*)/.exec(first)?.[1] || 'something').replace(/^none given.*/, 'the attached image');
  const variation = /VARIATION (\d+) OF/.exec(first)?.[1];
  const revise = /Requested change: "(.*)"/.exec(last)?.[1];
  const lead = revise ? `Revised to be ${revise.toLowerCase()}: ` : variation ? `Alternate take ${variation}: ` : '';
  const img = hasImage ? ' matching the palette and light of the reference image,' : '';
  const scene = `${lead}A candid 35mm film photograph of ${theme},${img} framed at eye level with soft natural light falling from the left. Fine grain, muted true-to-life colors, shallow depth of field, and small imperfect details that make it feel real.`;
  if (system.includes('integrated_multimodal_description')) {
    return `integrated_multimodal_description: [Shot 1] ${scene} The camera pushes in with small amplitude at slow speed.\n\noverall_soundscape: Soft ambience and gentle footsteps.\n\nnon_diegetic_music: N/A`;
  }
  return scene;
}

// Assistant turns (requests with tools), scripted by words in the user's last message. Each entry is one round:
// tool calls to make, or the reply once the tool results are back.
function assistantTurn(body) {
  const msgs = body.messages;
  const at = msgs.map(m => m.role).lastIndexOf('user');
  const said = textOf(msgs[at].content).toLowerCase();
  const round = msgs.slice(at + 1).filter(m => m.role === 'assistant').length;
  const results = msgs.slice(at + 1).filter(m => m.role === 'tool').map(m => m.content).join('\n');
  const script = /set up/.test(said) ? [{ calls: [['set_model', { model: 'krea' }], ['set_theme', { text: 'a surfer at golden hour' }], ['set_dials', { aspect: '9:16', takes: 2 }]] }, { text: 'All set: **Krea 2 RAW**, 9:16, 2 takes. Say *go* and I\'ll write them.' }]
    : /\bgo\b/.test(said) ? [{ calls: [['generate', {}]] }, { text: 'Your 2 takes are ready on the right.' }]
    : /\bhow\b/.test(said) ? [{ calls: [['read_guide', { topic: said }]] }, { text: results.includes('Add LoRA') ? 'In step ⑤, click **＋ Add LoRA** and pick one from your model\'s folder.' : 'I couldn\'t find that in the guide.' }]
    : /\blora\b/.test(said) ? [{ calls: [['add_lora', { name: 'detail', strength: 0.6 }]] }, { text: 'Added it at 0.6.' }]
    : /bogus/.test(said) ? [{ calls: [['set_model', { model: 'nonexistent' }]] }, { text: results.includes('"error"') ? 'There\'s no model by that name.' : 'Done.' }]
    : /tag fallback/.test(said) ? [{ text: '<tool_call>{"name": "set_theme", "arguments": {"text": "from a tag"}}</tool_call>' }, { text: 'Theme set.' }]
    : [{ text: 'I can help with that.' }];
  return script[Math.min(round, script.length - 1)];
}

export function startMock(port) {
  const log = [];
  let server;

  const handler = async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && req.url === '/api/v1/models') return json(200, { models: MODELS });
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { data: MODELS.map(m => ({ id: m.key })) });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: 'not found' });

    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    log.push(body);
    const allText = body.messages.map(m => textOf(m.content)).join('\n');
    if (allText.includes('FAILTEST')) return json(500, { error: { message: 'Mock failure: the model crashed' } });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const slow = allText.includes('SLOWTEST') || (allText.includes('SLOWSECOND') && /VARIATION \d+ OF/.test(allText));
    let closed = false;
    res.on('close', () => { closed = true; });

    await sleep(slow ? 800 : 350);
    if (body.tools) {
      const step = assistantTurn(body);
      (step.calls || []).forEach(([name, args], i) => {
        const a = JSON.stringify(args);
        send({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name, arguments: '' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: a.slice(0, 5) } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: a.slice(5) } }] } }] });
      });
      for (const w of (step.text || '').split(/(?<=\s)/)) if (w) send({ choices: [{ delta: { content: w } }] });
      send({ choices: [{ delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (allText.includes('EMPTYTEST')) {
      send({ choices: [{ delta: {}, finish_reason: 'length' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.model === 'mock/thinker' && body.reasoning_effort !== 'none') {
      for (let i = 0; i < 25 && !closed; i++) {
        send({ choices: [{ delta: { reasoning_content: 'Let me think about the framing and the light. ' } }] });
        await sleep(40);
      }
    }
    const words = (body.messages[0].content.startsWith('You write prompting guides')
      ? '## What this model is\n- A mock model.\n\n## Prompt structure\n- Subject first, then setting.'
      : cannedPrompt(body)).split(/(?<=\s)/);
    for (const w of words) {
      if (closed) return;
      send({ choices: [{ delta: { content: w } }] });
      await sleep(slow ? 220 : 12);
    }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
  };

  const listen = () => new Promise(resolve => {
    server = http.createServer(handler);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    log,
    start: listen,
    stop: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 12399;
  await startMock(port).start();
  console.log(`Mock LM Studio on http://127.0.0.1:${port}`);
}
