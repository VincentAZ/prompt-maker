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
