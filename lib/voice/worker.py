# Prompt Maker's voice worker: Qwen3-TTS, run by the server with ComfyUI's Python plus Prompt Maker's own packages
# (PYTHONPATH), so ComfyUI's packages are never changed. One JSON request per line on stdin, one JSON answer per
# line on stdout; everything else the libraries print goes to stderr. Models stay loaded while the process lives
# (the server ends it after a while idle, which frees the graphics memory for ComfyUI).
#
#   {"op": "fetch"}                                       download the models (progress lines, then ok)
#   {"op": "design", "instruct": "...", "text": "...", "out": "x.wav"}   a new voice from a description, saying text
#   {"op": "say", "ref": "ref.wav", "ref_text": "...", "text": "...", "language": "English", "out": "x.wav"}
#   {"op": "ping"}
import json
import os
import sys
import threading
import time

OUT = sys.stdout
sys.stdout = sys.stderr  # the libraries' chatter never lands in the answers

DESIGN = os.environ.get('PM_VOICE_DESIGN', 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign')
BASE = os.environ.get('PM_VOICE_BASE', 'Qwen/Qwen3-TTS-12Hz-1.7B-Base')

models = {}


def answer(obj):
    OUT.write(json.dumps(obj) + '\n')
    OUT.flush()


def load(repo):
    if repo not in models:
        import torch
        from qwen_tts import Qwen3TTSModel
        device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
        dtype = torch.bfloat16 if device != 'cpu' else torch.float32
        models[repo] = Qwen3TTSModel.from_pretrained(repo, device_map=device, dtype=dtype)
    return models[repo]


def dir_size(d):
    total = 0
    for root, _, files in os.walk(d):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def fetch():
    """Downloads both models into the Hugging Face cache (HF_HOME), reporting bytes on disk against the total."""
    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.constants import HF_HUB_CACHE
    api = HfApi()
    total = 0
    dirs = []
    for repo in (DESIGN, BASE):
        info = api.model_info(repo, files_metadata=True)
        total += sum(s.size or 0 for s in info.siblings)
        dirs.append(os.path.join(HF_HUB_CACHE, 'models--' + repo.replace('/', '--')))
    errors = []

    def run():
        for repo in (DESIGN, BASE):
            try:
                snapshot_download(repo)
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
                return
    t = threading.Thread(target=run, daemon=True)
    t.start()
    while t.is_alive():
        answer({'progress': {'received': sum(dir_size(d) for d in dirs), 'total': total}})
        t.join(1.0)
    if errors:
        raise RuntimeError(errors[0])
    answer({'progress': {'received': total, 'total': total}})


def wav(path, data, sr):
    import soundfile as sf
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    sf.write(path, data, sr)
    return len(data) / sr


def design(req):
    m = load(DESIGN)
    wavs, sr = m.generate_voice_design(text=req['text'], instruct=req['instruct'], language=req.get('language') or None)
    return {'seconds': round(wav(req['out'], wavs[0], sr), 2)}


def say(req):
    m = load(BASE)
    prompt = m.create_voice_clone_prompt(ref_audio=req['ref'], ref_text=req.get('ref_text') or None, x_vector_only_mode=not req.get('ref_text'))
    wavs, sr = m.generate_voice_clone(text=req['text'], language=req.get('language') or None, voice_clone_prompt=prompt)
    return {'seconds': round(wav(req['out'], wavs[0], sr), 2)}


OPS = {'fetch': lambda r: fetch() or {}, 'design': design, 'say': say, 'ping': lambda r: {}}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        t0 = time.time()
        out = OPS[req['op']](req)
        answer({'ok': True, 'id': req.get('id'), 'took': round(time.time() - t0, 1), **out})
    except Exception as e:  # noqa: BLE001
        answer({'ok': False, 'id': req.get('id') if isinstance(req, dict) else None, 'error': f'{type(e).__name__}: {e}'[:600]})
