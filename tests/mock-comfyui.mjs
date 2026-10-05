// A fake ComfyUI for UI tests: the HTTP API Prompt Maker uses plus a real WebSocket that streams
// execution progress. Prompt text containing COMFYFAIL fails; SLOWRENDER renders slowly. With a root folder,
// uploads land in root/input and renders in root/output, and finished jobs stay in its history until deleted.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: [['LTX_2.3/motion_boost.safetensors', 'krea2/baked_in.safetensors', 'krea2/detail_slider.safetensors', 'krea2/film_grain.safetensors', 'loose_file.safetensors']], strength_model: ['FLOAT', { default: 1, min: -100, max: 100 }] } }, input_order: { required: ['model', 'lora_name', 'strength_model'] }, output: ['MODEL'], output_node: false, display_name: 'LoraLoaderModelOnly' },
  LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } }, input_order: { required: ['image'] }, output: ['IMAGE', 'MASK'], output_node: false, display_name: 'Load Image' },
  LoadVideo: { input: { required: { file: ['COMBO', { options: [], video_upload: true }] } }, input_order: { required: ['file'] }, output: ['VIDEO'], output_node: false, display_name: 'Load Video' },
  GetVideoComponents: { input: { required: { video: ['VIDEO'] } }, input_order: { required: ['video'] }, output: ['IMAGE', 'AUDIO', 'FLOAT'], output_node: false, display_name: 'Get Video Components' },
  WanAnimate2ToVideo: {
    input: {
      required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], width: ['INT', { default: 832 }], height: ['INT', { default: 480 }], length: ['INT', { default: 81 }], batch_size: ['INT', { default: 1 }], video_frame_offset: ['INT', { default: 0 }], pose_strength: ['FLOAT', { default: 1 }], pose_start_percent: ['FLOAT', { default: 0 }], pose_end_percent: ['FLOAT', { default: 1 }], reference_image_strength: ['FLOAT', { default: 1 }] },
      optional: { reference_image: ['IMAGE'], pose_video: ['IMAGE'], positive_pose: ['CONDITIONING'] },
    },
    input_order: { required: ['positive', 'negative', 'vae', 'width', 'height', 'length', 'batch_size', 'video_frame_offset', 'pose_strength', 'pose_start_percent', 'pose_end_percent', 'reference_image_strength'], optional: ['reference_image', 'pose_video', 'positive_pose'] },
    output: ['CONDITIONING', 'CONDITIONING', 'LATENT', 'INT', 'INT', 'INT'], output_node: false, display_name: 'WanAnimate2ToVideo',
  },
};

// A small stand-in for ComfyUI's "video_wan_animate2" template, with its two quirks: the subgraph node lists only
// some of its widget inputs (values follow the subgraph's input order), and one input (pose_start_percent) feeds
// both ends of the pose window.
export const WAN_TEMPLATE = {
  id: 'mock-wan-animate2', revision: 0, last_node_id: 20, last_link_id: 4, version: 0.4,
  nodes: [
    { id: 1, type: 'LoadImage', title: 'Load Image (Reference Image)', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }], widgets_values: ['pink_hair_ref.png', 'image'] },
    { id: 2, type: 'LoadVideo', title: 'Load Video (Pose Video)', mode: 0, inputs: [], outputs: [{ name: 'VIDEO', type: 'VIDEO', links: [2] }], widgets_values: ['street_dance_drive.mp4', 'image'] },
    {
      id: 10, type: 'sg-wan', title: 'Motion Transfer (Wan Animate 2)', mode: 0,
      inputs: [
        { name: 'text_1', type: 'STRING', widget: { name: 'text_1' }, link: null },
        { name: 'input', type: 'IMAGE', link: 1 },
        { name: 'video', type: 'VIDEO', link: 2 },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [3] }],
      widgets_values: ['Character Description: a placeholder\nBackground description: a white room', 'A girl doing street dance, background stationary', 1, 0],
    },
    { id: 20, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [], widgets_values: ['video/ComfyUI'] },
  ],
  links: [[1, 1, 0, 10, 1, 'IMAGE'], [2, 2, 0, 10, 2, 'VIDEO'], [3, 10, 0, 20, 0, 'IMAGE']],
  definitions: {
    subgraphs: [{
      id: 'sg-wan', name: 'Motion Transfer (Wan Animate 2)',
      inputNode: { id: -10 }, outputNode: { id: -20 },
      inputs: [
        { name: 'text_1', type: 'STRING', linkIds: [11] },
        { name: 'text_2', type: 'STRING', linkIds: [12] },
        { name: 'input', type: 'IMAGE', linkIds: [13] },
        { name: 'video', type: 'VIDEO', linkIds: [14] },
        { name: 'pose_strength', type: 'FLOAT', linkIds: [15] },
        { name: 'pose_start_percent', type: 'FLOAT', linkIds: [16, 17] },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', linkIds: [30] }],
      nodes: [
        { id: 101, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [20] }, { name: 'CLIP', type: 'CLIP', links: [21, 22, 23] }, { name: 'VAE', type: 'VAE', links: [24, 29] }], widgets_values: ['mock_model.safetensors'] },
        { id: 102, type: 'CLIPTextEncode', title: 'CLIP Text Encode (Positive Prompt)', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 21 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: 11 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [25] }], widgets_values: ['x'] },
        { id: 103, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 22 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: 12 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [26] }], widgets_values: ['x'] },
        { id: 104, type: 'CLIPTextEncode', title: 'CLIP Text Encode (Negative Prompt)', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 23 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [27] }], widgets_values: ['blurry, low quality, watermark, worst quality'] },
        { id: 105, type: 'GetVideoComponents', mode: 0, inputs: [{ name: 'video', type: 'VIDEO', link: 14 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [28] }] },
        {
          id: 106, type: 'WanAnimate2ToVideo', mode: 0,
          inputs: [
            { name: 'positive', type: 'CONDITIONING', link: 25 }, { name: 'negative', type: 'CONDITIONING', link: 27 }, { name: 'vae', type: 'VAE', link: 24 },
            { name: 'reference_image', type: 'IMAGE', link: 13 }, { name: 'pose_video', type: 'IMAGE', link: 28 }, { name: 'positive_pose', type: 'CONDITIONING', link: 26 },
            { name: 'width', type: 'INT', widget: { name: 'width' }, link: null }, { name: 'height', type: 'INT', widget: { name: 'height' }, link: null },
            { name: 'length', type: 'INT', widget: { name: 'length' }, link: null }, { name: 'batch_size', type: 'INT', widget: { name: 'batch_size' }, link: null },
            { name: 'video_frame_offset', type: 'INT', widget: { name: 'video_frame_offset' }, link: null },
            { name: 'pose_strength', type: 'FLOAT', widget: { name: 'pose_strength' }, link: 15 }, { name: 'pose_start_percent', type: 'FLOAT', widget: { name: 'pose_start_percent' }, link: 16 },
            { name: 'pose_end_percent', type: 'FLOAT', widget: { name: 'pose_end_percent' }, link: 17 }, { name: 'reference_image_strength', type: 'FLOAT', widget: { name: 'reference_image_strength' }, link: null },
          ],
          outputs: [{ name: 'positive', type: 'CONDITIONING', links: [31] }, { name: 'negative', type: 'CONDITIONING', links: [32] }, { name: 'latent', type: 'LATENT', links: [33] }],
          widgets_values: [832, 480, 81, 1, 0, 1, 0, 1, 1],
        },
        { id: 107, type: 'KSampler', mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 20 }, { name: 'positive', type: 'CONDITIONING', link: 31 }, { name: 'negative', type: 'CONDITIONING', link: 32 }, { name: 'latent_image', type: 'LATENT', link: 33 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [34] }], widgets_values: [42, 'randomize', 6, 1, 'euler', 'normal', 1] },
        { id: 108, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 34 }, { name: 'vae', type: 'VAE', link: 29 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [30] }] },
      ],
      links: [
        [11, -10, 0, 102, 1, 'STRING'], [12, -10, 1, 103, 1, 'STRING'], [13, -10, 2, 106, 3, 'IMAGE'], [14, -10, 3, 105, 0, 'VIDEO'],
        [15, -10, 4, 106, 11, 'FLOAT'], [16, -10, 5, 106, 12, 'FLOAT'], [17, -10, 5, 106, 13, 'FLOAT'],
        [20, 101, 0, 107, 0, 'MODEL'], [21, 101, 1, 102, 0, 'CLIP'], [22, 101, 1, 103, 0, 'CLIP'], [23, 101, 1, 104, 0, 'CLIP'], [24, 101, 2, 106, 2, 'VAE'], [29, 101, 2, 108, 1, 'VAE'],
        [25, 102, 0, 106, 0, 'CONDITIONING'], [26, 103, 0, 106, 5, 'CONDITIONING'], [27, 104, 0, 106, 1, 'CONDITIONING'], [28, 105, 0, 106, 4, 'IMAGE'],
        [31, 106, 0, 107, 1, 'CONDITIONING'], [32, 106, 1, 107, 2, 'CONDITIONING'], [33, 106, 2, 107, 3, 'LATENT'], [34, 107, 0, 108, 0, 'LATENT'],
        [30, 108, 0, -20, 0, 'IMAGE'],
      ],
    }],
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([header, payload]);
}

// A "model" the fake Hugging Face (/hf/<name>) hands out.
export const MODEL_BYTES = Buffer.alloc(300 * 1024, 7);

// Files in a folder and its subfolders, as ComfyUI lists them ("sub/name.safetensors").
function filesIn(dir, prefix = '') {
  let out = [];
  for (const d of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    if (d.isDirectory()) out = out.concat(filesIn(path.join(dir, d.name), `${prefix}${d.name}/`));
    else if (/\.safetensors$/.test(d.name)) out.push(prefix + d.name);
  }
  return out;
}

// root: a fake ComfyUI install folder; finished renders are saved to root/output like the real thing, and the
// checkpoints in root/models/checkpoints are offered next to mock_model.safetensors.
export function startMockComfy(port, { png, root = null }) {
  const prompts = [];
  const uploads = [];
  const history = {};
  // The saved "Mock T2I" workflow, as if it lived in ComfyUI's library (editSaved = you changed it in ComfyUI).
  const saved = { json: SAVED_WORKFLOW, modified: Date.now() - 3600e3 };
  const sockets = new Map();
  const allSockets = new Set();
  const interrupted = new Set();
  const pending = []; // queued, not started: { id, prompt }
  const dropped = new Set(); // taken off the queue before they started
  let server;
  let running = null;
  let chain = Promise.resolve();

  const send = (clientId, msg) => {
    const s = sockets.get(clientId);
    if (s && !s.destroyed) s.write(wsFrame(JSON.stringify(msg)));
  };

  async function execute(id, prompt, clientId) {
    const k = pending.findIndex(x => x.id === id);
    if (k >= 0) pending.splice(k, 1);
    if (dropped.has(id)) return;
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
        history[id] = { prompt: [0, id, prompt, { client_id: clientId }, ['9']], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: id }]] } };
        running = null;
        return;
      }
      // COMFYCRASH: like ComfyUI killed mid-render (out of memory) and started again: the job is just gone, with no
      // message, nothing in history and nothing in the queue.
      if (v === 3 && text.includes('COMFYCRASH')) { running = null; return; }
      send(clientId, { type: 'progress', data: { value: v, max: 5, prompt_id: id, node: '3' } });
      await sleep(slow ? 700 : 60);
    }
    if (text.includes('COMFYFAIL')) {
      const err = { prompt_id: id, node_id: '3', node_type: 'KSampler', exception_message: 'Mock sampler exploded' };
      send(clientId, { type: 'execution_error', data: err });
      history[id] = { prompt: [0, id, prompt, { client_id: clientId }, ['9']], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', err]] } };
      running = null;
      return;
    }
    send(clientId, { type: 'executing', data: { node: '9', prompt_id: id } });
    if (root) fs.writeFileSync(path.join(root, 'output', `mock_${id.slice(0, 6)}.png`), png);
    history[id] = { prompt: [0, id, prompt, { client_id: clientId }, ['9']], outputs: { 9: { images: [{ filename: `mock_${id.slice(0, 6)}.png`, subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } };
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
    if (p === '/object_info') {
      const info = structuredClone(OBJECT_INFO);
      if (root) info.CheckpointLoaderSimple.input.required.ckpt_name[0].push(...filesIn(path.join(root, 'models', 'checkpoints')));
      return json(200, info);
    }
    if (p === '/internal/folder_paths') return json(200, root ? { custom_nodes: [path.join(root, 'custom_nodes')], checkpoints: [path.join(root, 'models', 'checkpoints')] } : {});
    if (p.startsWith('/hf/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': MODEL_BYTES.length });
      return res.end(MODEL_BYTES);
    }
    if (p === '/models/loras') return json(200, OBJECT_INFO.LoraLoaderModelOnly.input.required.lora_name[0]);
    if (p === '/api/userdata') return json(200, [{ path: 'Mock T2I.json', size: 2000, modified: saved.modified }, { path: '.index.json', size: 10, modified: 0 }]);
    if (p === `/api/userdata/${encodeURIComponent('workflows/Mock T2I.json')}` || p === '/api/userdata/workflows/Mock T2I.json' || decodeURIComponent(p) === '/api/userdata/workflows/Mock T2I.json') return json(200, saved.json);
    if (p === '/templates/video_wan_animate2.json') return json(200, WAN_TEMPLATE);
    if (p === '/upload/image' && req.method === 'POST') {
      const name = /filename="([^"]+)"/.exec(raw.toString('latin1'))?.[1] || 'upload.png';
      uploads.push(name);
      if (root) fs.writeFileSync(path.join(root, 'input', name), png);
      return json(200, { name, subfolder: '', type: 'input' });
    }
    if (p === '/prompt' && req.method === 'POST') {
      const body = JSON.parse(raw.toString());
      const id = crypto.randomUUID();
      prompts.push({ id, ...body });
      pending.push({ id, prompt: body.prompt });
      chain = chain.then(() => execute(id, body.prompt, body.client_id));
      // SKIPOUT: like ComfyUI when one output fails its checks: the rest is queued, the reasons come back.
      const skipped = JSON.stringify(body.prompt).includes('SKIPOUT') ? { 9: { class_type: 'SaveImage', errors: [{ message: 'Value not in list', details: "ckpt_name: 'gone.safetensors' not in ['mock_model.safetensors']" }] } } : {};
      return json(200, { prompt_id: id, number: prompts.length, node_errors: skipped });
    }
    if (p === '/history' && req.method === 'GET') return json(200, history);
    if (p === '/history' && req.method === 'POST') {
      const body = JSON.parse(raw.toString() || '{}');
      for (const id of body.delete || []) delete history[id];
      if (body.clear) for (const id of Object.keys(history)) delete history[id];
      res.writeHead(200);
      return res.end();
    }
    if (p.startsWith('/history/')) {
      const id = decodeURIComponent(p.slice('/history/'.length));
      return json(200, history[id] ? { [id]: history[id] } : {});
    }
    if (p === '/queue' && req.method === 'GET') {
      const job = id => [prompts.findIndex(x => x.id === id), id, prompts.find(x => x.id === id)?.prompt, { client_id: prompts.find(x => x.id === id)?.client_id }, ['9']];
      return json(200, { queue_running: running ? [job(running)] : [], queue_pending: pending.filter(x => !dropped.has(x.id)).map(x => job(x.id)) });
    }
    if (p === '/queue' && req.method === 'POST') {
      const body = raw.length ? JSON.parse(raw.toString()) : {};
      for (const id of body.delete || []) dropped.add(id);
      return json(200, {});
    }
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
    history,
    editSaved(fn) {
      saved.json = fn(structuredClone(saved.json));
      saved.modified = Date.now();
    },
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
