// A fake LM Studio server for UI tests: deterministic streaming, a text-only model,
// a "thinking" model LM Studio can switch off, one that ignores the switch (only an empty
// thinking block stops it), one never used, failures and slow responses, triggered by words in the theme.
//   FAILTEST  → HTTP 500        EMPTYTEST → hits the token limit with no output
//   SLOWTEST  → very slow stream  SLOWSECOND → only takes 2+ are slow
//   REFUSETEST → turns the job down
import http from 'node:http';

const MODELS = [
  { key: 'mock/vision-8b', display_name: 'Mock Vision 8B', type: 'llm', params_string: '8B', quantization: { name: 'Q4_K_M' }, size_bytes: 6.2e9, max_context_length: 32768, capabilities: { vision: true, trained_for_tool_use: true }, loaded_instances: [{ id: 'mock/vision-8b' }] },
  { key: 'mock/thinker', display_name: 'Mock Thinker 9B', type: 'llm', capabilities: { vision: true, reasoning: { allowed_options: ['off', 'on'], default: 'on' } }, loaded_instances: [] },
  { key: 'mock/fable', display_name: 'Mock Fable 27B', type: 'llm', capabilities: { vision: true }, loaded_instances: [] },
  { key: 'mock/text-only', display_name: 'Mock Text 7B', type: 'llm', capabilities: { vision: false }, loaded_instances: [] },
  { key: 'mock/fresh', display_name: 'Mock Fresh 3B', type: 'llm', capabilities: { vision: false }, loaded_instances: [] },
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
  if (system.includes('casting sheet')) return 'Here is the sheet:\nAge: woman in her late twenties\nEyes: light green, almond-shaped\nHair: copper-red, shoulder-length, loose waves\nBuild: slim, narrow shoulders\nNose: not visible\nMarks: none';
  if (system.includes('Character appearance description')) {
    const frames = users.some(u => Array.isArray(u.content) && u.content.filter(p => p.type === 'image_url').length > 1);
    return `Character appearance description: ${lead}A woman in her twenties with long pink hair in a high ponytail, a white tank top and black cargo pants. Photorealistic.\nBackground description: ${theme}, warm light from the left. Full-body framing at eye level.\nMotion: A woman doing ${frames ? 'the street dance from the frames' : 'a simple dance'}, background stationary.`;
  }
  if (system.includes('integrated_multimodal_description')) {
    return `integrated_multimodal_description: [Shot 1] ${scene} The camera pushes in with small amplitude at slow speed.\n\noverall_soundscape: Soft ambience and gentle footsteps.\n\nnon_diegetic_music: N/A`;
  }
  return scene;
}

// Assistant turns (requests with tools), scripted by words in the user's last message. Each entry is one round:
// tool calls to make, or the reply once the tool results are back.
function assistantTurn(body) {
  const msgs = body.messages;
  // The user's last words (pictures the app sends after look_at come as user messages with image parts).
  const at = msgs.map(m => (m.role === 'user' && !Array.isArray(m.content) ? 'said' : m.role)).lastIndexOf('said');
  const sawPictures = msgs.slice(at + 1).some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url' && /^data:image\/jpeg;base64,/.test(p.image_url.url)));
  const said = textOf(msgs[at].content).toLowerCase();
  const round = msgs.slice(at + 1).filter(m => m.role === 'assistant').length;
  const results = msgs.slice(at + 1).filter(m => m.role === 'tool').map(m => m.content).join('\n');
  const script = /set up/.test(said) ? [{ calls: [['set_model', { model: 'krea 2 raw' }], ['set_theme', { text: 'a surfer at golden hour' }], ['set_dials', { aspect: '9:16', takes: 2 }]] }, { text: 'All set: **Krea 2 RAW**, 9:16, 2 takes. Say *go* and I\'ll write them.' }]
    : /\bgo\b/.test(said) ? [{ calls: [['generate', {}]] }, { text: 'Your 2 takes are ready on the right.' }]
    : /\bhow\b/.test(said) ? [{ calls: [['read_guide', { topic: said }]] }, { text: results.includes('Add LoRA') ? 'In step ⑤, click **＋ Add LoRA** and pick one from your model\'s folder.' : 'I couldn\'t find that in the guide.' }]
    : /\blora\b/.test(said) ? [{ calls: [['add_lora', { name: 'detail', strength: 0.6 }]] }, { text: 'Added it at 0.6.' }]
    : /noir look/.test(said) ? [{ calls: [['set_dials', { look: 'noir' }]] }, { text: results.includes('Noir look') ? 'Noir it is.' : `It didn't take: ${results}` }]
    // A model name that fits two models, then a theme: the theme must not be set once set_model failed.
    : /ltx then krea/.test(said) ? [{ calls: [['set_model', { model: 'ltx' }], ['set_model', { model: 'krea' }], ['set_theme', { text: 'after a failure' }]] }, { text: results.includes('could be') ? 'Krea is two models: which?' : 'Done.' }]
    // Three videos in one go: the app asks the user first (on generate when auto-render is on, else on render).
    : /three ltx videos/.test(said) ? [{ calls: [['set_model', { model: 'ltx' }], ['set_theme', { text: 'a slow pan' }], ['set_dials', { takes: 3 }], ['generate', {}]] }, results.includes('said no') ? { text: 'Okay, no videos.' } : { calls: [['render', {}]] }, { text: results.includes('said no') ? 'Okay, no videos.' : 'Rendered.' }]
    : /bogus/.test(said) ? [{ calls: [['set_model', { model: 'nonexistent' }]] }, { text: results.includes('"error"') ? 'There\'s no model by that name.' : 'Done.' }]
    : /fix the playbook/.test(said) ? [{ calls: [['edit_playbook', { model: 'krea 2 raw', description: 'Edited by the assistant', resolutions: ['1024×1024', '1536×1024'] }]] }, { text: results.includes('Saved the') ? 'Saved it. Say undo to put it back.' : 'That failed.' }]
    : /\bundo\b/.test(said) ? [{ calls: [['undo_playbook_edit', {}]] }, { text: results.includes('back as it was') ? 'Put it back.' : 'That failed.' }]
    : /like best/.test(said) ? [{ calls: [['look_at', {}]] }, { text: sawPictures ? 'I\'d pick **take 1, render 1**: the light is softer and the subject reads better.' : 'I couldn\'t see them.' }]
    : /my renders of/.test(said) ? [{ calls: [['look_at', { what: 'gallery', find: said.split('my renders of')[1] }]] }, { text: results.includes('"error"') ? `None of your renders show that. (${results.match(/"error":"([^"]*)/)?.[1]})` : sawPictures ? `Found them: ${results.match(/Looked at [^"]*/)?.[0]}.` : 'I couldn\'t see them.' }]
    : /^run: /.test(said) ? [{ calls: [['run_command', { command: textOf(msgs[at].content).slice(5) }]] }, { text: results.includes('"declined":true') ? 'Okay, I didn\'t run it.' : results.includes('"error"') ? `Couldn't: ${results.match(/"error":"([^"]*)/)?.[1]}` : `Output: ${results.match(/"output":"([^"]*)/)?.[1]}` }]
    : /show me the pictures in/.test(said) ? [{ calls: [['look_at', { what: 'files', folder: textOf(msgs[at].content).match(/(\/[^\s,]+)/)[1], limit: 2 }]] }, { text: sawPictures ? `I see them: ${results.match(/Looked at [^"]*/)?.[0]}.` : 'I couldn\'t see them.' }]
    : /rate the first one excellent/.test(said) ? [{ calls: [['rate_render', { take: 1, render: 1, rating: 3 }]] }, { text: results.includes('Rated excellent') ? 'Done, rated excellent.' : 'That failed.' }]
    : /delete this prompt/.test(said) ? [{ calls: [['delete_entry', {}]] }, { text: results.includes('"declined":true') ? 'Okay, I kept it.' : results.includes('Deleted') ? 'Deleted it for good.' : 'That failed.' }]
    : /^job:/.test(said) ? (() => {
      const folder = textOf(msgs[at].content).match(/(\/[^\s,]+)/)[1];
      const runs = [
        { label: 'low temp', steps: [{ tool: 'clear_chain' }, { tool: 'set_model', args: { model: 'krea 2 raw' } }, { tool: 'set_theme', args: { text: '' } }, { tool: 'set_dials', args: { takes: 1, temperature: 0.3, batch: 'off' } }, { tool: 'generate' }] },
        { label: 'high temp', steps: [{ tool: 'set_dials', args: { takes: 1, temperature: 1.4 } }, { tool: 'generate' }] },
      ];
      return [{ calls: [['list_folder', { folder }]] }, { calls: [['start_job', { title: 'Pics, low and high', folder, runs }]] }, { text: results.includes('Started the job') ? 'Started it: follow it in 🗂 Jobs.' : 'That failed.' }];
    })()
    : /pick the best/.test(said) ? [{ calls: [['pick_best', { for: 'a moody poster', then: 'reference', rate: 2 }]] }, { text: results.includes('Picked') ? 'Picked one and put it in step 3.' : 'That failed.' }]
    : /judge the renders/.test(said) ? [{ calls: [['judge_renders', { for: 'a moody poster', from: 'on_screen' }]] }, { text: results.match(/"summary":"([^"]*)/)?.[1] || 'That failed.' }]
    : /fewer steps/.test(said) ? [{ calls: [['set_sampler', { steps: 12 }]] }, { text: results.includes('steps 12') ? 'Steps set to 12.' : 'That failed.' }]
    // It tries to answer the "send your prompts to the cloud?" question itself: it waits for it, looks, and presses OK if it can.
    : /answer the cloud question/.test(said) ? (() => {
      const ok = [...results.matchAll(/\[(\d+)\] button “OK, use it”/g)].at(-1)?.[1];
      return [
        { calls: [['wait', { seconds: 3 }]] },
        { calls: [['see_screen', {}]] },
        ok ? { calls: [['press', { control: Number(ok) }]] } : { text: results.includes('only the user can answer') ? 'That one is yours to answer: it is waiting for your click.' : 'There is nothing to answer.' },
        { text: 'I pressed OK for you.' },
      ];
    })()
    // It tries to reset an edited playbook by pressing the button twice (the second press answers its "Sure?").
    : /reset the playbook yourself/.test(said) ? (() => {
      const n = Number([...results.matchAll(/\[(\d+)\] button “↺ Reset to built-in”/g)].at(-1)?.[1]);
      return [
        { calls: [['see_screen', { find: 'reset' }]] },
        { calls: [['press', { control: n }]] },
        { calls: [['press', { control: n }]] },
        { text: results.includes('"declined":true') ? 'Okay, I left your playbook alone.' : results.includes('"error"') ? `That failed: ${results.slice(-300)}` : 'I reset it.' },
      ];
    })()
    // Settings through the screen: look, type in the box it found, look again, press the button it found.
    : /use the screen/.test(said) ? (() => {
      const last = re => [...results.matchAll(re)].at(-1)?.[1];
      return [
        { calls: [['go_to', { page: 'settings' }], ['see_screen', { find: 'top' }]] },
        { calls: [['fill', { control: Number(last(/\[(\d+)\] number box “Top P/g)), text: '0.77' }], ['see_screen', { find: 'save settings' }]] },
        { calls: [['press', { control: Number(last(/\[(\d+)\] button “Save settings”/g)) }]] },
        { text: results.includes('Pressed “Save settings”') ? 'Saved: top P is 0.77.' : 'That failed.' },
      ];
    })()
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
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (req.headers.authorization === 'Bearer wrong-key') return json(401, { error: { message: 'bad key' } });
      return json(200, { data: MODELS.map(m => ({ id: m.key })) });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: 'not found' });

    let raw = '';
    for await (const c of req) raw += c;
    let body = JSON.parse(raw);
    log.push(Object.assign(body, req.headers.authorization ? { _auth: req.headers.authorization } : {}));
    // An answer that starts with its thinking already over: drop it, and remember it was there.
    const pre = body.messages.at(-1);
    const thinkingOver = pre.role === 'assistant' && /^<think>\s*<\/think>/.test(pre.content);
    if (thinkingOver) body = { ...body, messages: body.messages.slice(0, -1) };
    const allText = body.messages.map(m => textOf(m.content)).join('\n');
    if (allText.includes('FAILTEST')) return json(500, { error: { message: 'Mock failure: the model crashed' } });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const slow = allText.includes('SLOWTEST') || (allText.includes('SLOWSECOND') && /VARIATION \d+ OF/.test(allText));
    let closed = false;
    res.on('close', () => { closed = true; });

    await sleep(slow ? 800 : 350);
    // A Brain whose chat template breaks as soon as tools are sent, the way LM Studio reports it.
    const said = body.messages.filter(m => m.role === 'user' && !Array.isArray(m.content)).at(-1);
    if (body.tools && /broken template/.test(said?.content)) {
      res.end(`event: error\ndata: ${JSON.stringify({ error: { message: 'Error rendering prompt with jinja template: "Cannot call something that is not a function: got UndefinedValue".' } })}\n\n`);
      return;
    }
    // The assistant's pick_best: the Brain looks at the renders and names one.
    if (!body.tools && textOf(body.messages.at(-1).content).startsWith('(Prompt Maker) Pick the best')) {
      for (const w of '2: the light is softer and the balloon reads better.'.split(/(?<=\s)/)) send({ choices: [{ delta: { content: w } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    // The assistant's judge_renders: a score and a reason for each, the second one a failure.
    if (!body.tools && textOf(body.messages.at(-1).content).startsWith('(Prompt Maker) Judge each')) {
      const n = Number(textOf(body.messages.at(-1).content).match(/these (\d+) renders/)[1]);
      const reply = Array.from({ length: n }, (_, i) => (i === 1 ? `2: 0 – warped hands` : `${i + 1}: **${i ? 2 : 3}** – the light is right`)).join('\n');
      for (const w of reply.split(/(?<=\s)/)) send({ choices: [{ delta: { content: w } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    // Then its tools come in writing: it calls one as text (a bracket wrong, then words written too early), and
    // answers once the result is back.
    if (body.messages[0].content.includes('# Your tools')) {
      const after = textOf(body.messages.at(-1).content).includes('<tool_result name="set_theme">{"ok":true');
      const reply = after ? 'Theme set, the long way round.' : 'On it.\n<tool_call>{"name": "set_theme", "arguments": {"text": "from the written tools"]\n</tool_call>\nDone, it is set!';
      for (const w of reply.split(/(?<=\s)/)) send({ choices: [{ delta: { content: w } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
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
    if ((body.model === 'mock/thinker' && body.reasoning_effort !== 'none') || (body.model === 'mock/fable' && !thinkingOver)) {
      for (let i = 0; i < 25 && !closed; i++) {
        send({ choices: [{ delta: { reasoning_content: 'Let me think about the framing and the light. ' } }] });
        await sleep(40);
      }
    }
    const words = (body.messages[0].content.startsWith('You write prompting guides')
      ? '## What this model is\n- A mock model.\n\n## Prompt structure\n- Subject first, then setting.'
      : allText.includes('Which two colors fill this image') ? 'Red and blue.'
      : allText.includes('REFUSETEST') ? "I'm sorry, but I can't help with that request."
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
