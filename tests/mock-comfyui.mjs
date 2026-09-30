// A fake ComfyUI for UI tests: the HTTP API Prompt Maker uses plus a real WebSocket that streams
// execution progress. Prompt text containing COMFYFAIL fails; SLOWRENDER renders slowly.
import http from 'node:http';
import crypto from 'node:crypto';

// A small saved (editor-format) workflow: checkpoint → prompts → sampler → decode → save.
export const SAVED_WORKFLOW = {
  id: 'mock-t2i', revision: 0, last_node_id: 9, last_link_id: 9, version: 0.4,
  nodes: [
    { id: 4, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [3, 5] }, { name: 'VAE', type: 'VAE', links: [8] }], widgets_values: ['mock_model.safetensors'] },
    { id: 6, type: 'CLIPTextEncode', title: 'Positive Prompt', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 3 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }], widgets_values: ['a placeholder prompt'] },
    { id: 7, type: 'CLIPTextEncode', title: 'Negative Prompt', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 5 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }], widgets_values: ['blurry, low quality, watermark'] },
    { id: 5, type: 'EmptyLatentImage', mode: 0, inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT', links: [2] }], widgets_values: [512, 512, 1] },
    { id: 3, type: 'KSampler', mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 1 }, { name: 'positive', type: 'CONDITIONING', link: 4 }, { name: 'negative', type: 'CONDITIONING', link: 6 }, { name: 'latent_image', type: 'LATENT', link: 2 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }], widgets_values: [42, 'randomize', 20, 7, 'euler', 'normal', 1] },
    { id: 8, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 7 }, { name: 'vae', type: 'VAE', link: 8 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }] },
    { id: 9, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], outputs: [], widgets_values: ['ComfyUI'] },
    { id: 10, type: 'Note', mode: 0, inputs: [], outputs: [], widgets_values: ['Just a note'] },
  ],
  links: [[1, 4, 0, 3, 0, 'MODEL'], [2, 5, 0, 3, 3, 'LATENT'], [3, 4, 1, 6, 0, 'CLIP'], [4, 6, 0, 3, 1, 'CONDITIONING'], [5, 4, 1, 7, 0, 'CLIP'], [6, 7, 0, 3, 2, 'CONDITIONING'], [7, 3, 0, 8, 0, 'LATENT'], [8, 4, 2, 8, 1, 'VAE'], [9, 8, 0, 9, 0, 'IMAGE']],
};

export const OBJECT_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['mock_model.safetensors']] } }, input_order: { required: ['ckpt_name'] }, output: ['MODEL', 'CLIP', 'VAE'], output_node: false, display_name: 'Load Checkpoint' },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } }, input_order: { required: ['text', 'clip'] }, output: ['CONDITIONING'], output_node: false, display_name: 'CLIP Text Encode (Prompt)' },
  EmptyLatentImage: { input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } }, input_order: { required: ['width', 'height', 'batch_size'] }, output: ['LATENT'], output_node: false, display_name: 'Empty Latent Image' },
  KSampler: { input: { required: { model: ['MODEL'], seed: ['INT', { control_after_generate: true }], steps: ['INT', { default: 20 }], cfg: ['FLOAT', { default: 8 }], sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', { default: 1 }] } }, input_order: { required: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'] }, output: ['LATENT'], output_node: false, display_name: 'KSampler' },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, input_order: { required: ['samples', 'vae'] }, output: ['IMAGE'], output_node: false, display_name: 'VAE Decode' },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } }, input_order: { required: ['images', 'filename_prefix'] }, output: [], output_node: true, display_name: 'Save Image' },
  LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } }, input_order: { required: ['image'] }, output: ['IMAGE', 'MASK'], output_node: false, display_name: 'Load Image' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([header, payload]);
}

export function startMockComfy(port, { png }) {
  const prompts = [];
  const uploads = [];
  const history = {};
  const sockets = new Map();
  const allSockets = new Set();
  const interrupted = new Set();
  let server;
  let running = null;
  let chain = Promise.resolve();

  const send = (clientId, msg) => {
    const s = sockets.get(clientId);
    if (s && !s.destroyed) s.write(wsFrame(JSON.stringify(msg)));
  };

  async function execute(id, prompt, clientId) {
    running = id;
    const text = JSON.stringify(prompt);
    const slow = text.includes('SLOWRENDER');
    send(clientId, { type: 'execution_start', data: { prompt_id: id } });
    for (const node of ['4', '6', '5', '3']) {
      send(clientId, { type: 'executing', data: { node, prompt_id: id } });
      await sleep(40);
    }
    for (let v = 1; v <= 5; v++) {
      if (interrupted.has(id)) {
        send(clientId, { type: 'execution_interrupted', data: { prompt_id: id } });
        history[id] = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: id }]] } };
        running = null;
        return;
      }
      send(clientId, { type: 'progress', data: { value: v, max: 5, prompt_id: id, node: '3' } });
      await sleep(slow ? 700 : 60);
    }
    if (text.includes('COMFYFAIL')) {
      const err = { prompt_id: id, node_id: '3', node_type: 'KSampler', exception_message: 'Mock sampler exploded' };
      send(clientId, { type: 'execution_error', data: err });
      history[id] = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', err]] } };
      running = null;
      return;
    }
    send(clientId, { type: 'executing', data: { node: '9', prompt_id: id } });
    history[id] = { outputs: { 9: { images: [{ filename: `mock_${id.slice(0, 6)}.png`, subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } };
    send(clientId, { type: 'executing', data: { node: null, prompt_id: id } });
    send(clientId, { type: 'execution_success', data: { prompt_id: id } });
    running = null;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    let raw = Buffer.alloc(0);
    for await (const c of req) raw = Buffer.concat([raw, c]);
    const p = url.pathname;
    if (p === '/system_stats') return json(200, { system: { comfyui_version: '0.38.0-mock' }, devices: [{ name: 'cuda:0 Mock GPU : cudaMallocAsync', vram_total: 8 * 2 ** 30, vram_free: 6 * 2 ** 30 }] });
    if (p === '/object_info') return json(200, OBJECT_INFO);
    if (p === '/api/userdata') return json(200, [{ path: 'Mock T2I.json', size: 2000, modified: Date.now() - 3600e3 }, { path: '.index.json', size: 10, modified: 0 }]);
    if (p === `/api/userdata/${encodeURIComponent('workflows/Mock T2I.json')}` || p === '/api/userdata/workflows/Mock T2I.json' || decodeURIComponent(p) === '/api/userdata/workflows/Mock T2I.json') return json(200, SAVED_WORKFLOW);
    if (p === '/upload/image' && req.method === 'POST') {
      const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))?.[1] || 'upload.png';
      uploads.push(name);
      return json(200, { name, subfolder: '', type: 'input' });
    }
    if (p === '/prompt' && req.method === 'POST') {
      const body = JSON.parse(raw.toString());
      const id = crypto.randomUUID();
      prompts.push({ id, ...body });
      chain = chain.then(() => execute(id, body.prompt, body.client_id));
      return json(200, { prompt_id: id, number: prompts.length, node_errors: {} });
    }
    if (p.startsWith('/history/')) {
      const id = decodeURIComponent(p.slice('/history/'.length));
      return json(200, history[id] ? { [id]: history[id] } : {});
    }
    if (p === '/queue' && req.method === 'GET') return json(200, { queue_running: running ? [[0, running]] : [], queue_pending: [] });
    if (p === '/queue' && req.method === 'POST') return json(200, {});
    if (p === '/interrupt') {
      const body = raw.length ? JSON.parse(raw.toString()) : {};
      if (body.prompt_id) interrupted.add(body.prompt_id);
      res.writeHead(200);
      return res.end();
    }
    if (p === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    json(404, { error: 'not found' });
  };

  const listen = () => new Promise(resolve => {
    server = http.createServer(handler);
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const clientId = new URL(req.url, 'http://x').searchParams.get('clientId');
      sockets.set(clientId, socket);
      allSockets.add(socket);
      socket.on('close', () => allSockets.delete(socket));
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.write(wsFrame(JSON.stringify({ type: 'status', data: { sid: clientId, status: { exec_info: { queue_remaining: 0 } } } })));
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    prompts,
    uploads,
    start: listen,
    stop: () => new Promise(resolve => {
      for (const s of allSockets) s.destroy();
      allSockets.clear();
      sockets.clear();
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
