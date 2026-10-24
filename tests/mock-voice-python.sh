#!/bin/sh
# The tests' stand-in for ComfyUI's Python (PROMPT_MAKER_VOICE_PYTHON): "-m pip install --target DIR …" makes the
# package marker, and running a worker script runs the mock worker instead (no models, no GPU).
if [ "$1 $2 $3" = "-m pip install" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--target" ]; then mkdir -p "$a/qwen_tts" && touch "$a/qwen_tts/__init__.py" && exit 0; fi
    prev="$a"
  done
  echo "mock pip: no --target" >&2
  exit 1
fi
exec node "$(dirname "$0")/mock-voice-worker.mjs"
