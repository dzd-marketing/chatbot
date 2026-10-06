"""DZD Learn AI voice: Kyutai Pocket TTS speaking in the DZD voice.

Runs on the Space's CPU only (CPU Basic, or ZeroGPU without ever asking for
the GPU, so no GPU quota is used).

Endpoints (the Space is private; requests need an HF token):
  POST /tts     {"text": "..."} -> raw 16-bit mono PCM, streamed as it is made
                (sample rate in the X-Sample-Rate header)
  GET  /health  readiness, voice in use, workers and measured speed
The page itself is a small form for trying the voice.
"""

from __future__ import annotations

# `spaces` (ZeroGPU helper) must be imported before torch when present.
try:  # isort: skip
    import spaces
except ImportError:  # CPU-only Space without the helper
    spaces = None

import asyncio
import logging
import os
import re
import threading
import time
from pathlib import Path

import gradio as gr
import numpy as np
import torch
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pocket_tts import TTSModel, export_model_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dzd-voice")

ON_ZERO_GPU = os.environ.get("SPACES_ZERO_GPU", "").lower() in ("1", "t", "true")

if spaces is not None:
    # Gradio would otherwise run every UI event on the GPU (and use quota).
    spaces.disable_gradio_auto_wrap()

if spaces is not None and ON_ZERO_GPU:

    @spaces.GPU(duration=1)
    def _never_called() -> None:
        """ZeroGPU wants one GPU function to exist at startup. Never used."""


HERE = Path(__file__).parent
VOICE_AUDIO = HERE / "voice.mp3"
# A ready-made voice embedding, if one was uploaded (loads instantly).
VOICE_EMBEDDING = HERE / "voice.safetensors"
VOICE_CACHE = Path("/tmp/dzd-voice.safetensors")
# Built-in female English voices (Kyutai's catalog), usable without cloning.
FEMALE_VOICES = {
    "alba": "Alba (warm, casual)",
    "jane": "Jane",
    "mary": "Mary",
    "eve": "Eve",
    "anna": "Anna",
    "vera": "Vera",
    "fantine": "Fantine",
    "eponine": "Eponine",
    "azelma": "Azelma",
}
CUSTOM = "custom"
# The website's voice: "custom" (the recording) or one of FEMALE_VOICES.
# Change it with the Space variable VOICE (Settings -> Variables).
CHOSEN_VOICE = os.environ.get("VOICE", CUSTOM).strip().lower() or CUSTOM
if CHOSEN_VOICE != CUSTOM and CHOSEN_VOICE not in FEMALE_VOICES:
    CHOSEN_VOICE = CUSTOM
FALLBACK_VOICE = os.environ.get("FALLBACK_VOICE", "alba")
MAX_CHARS = 600
# Requests wait this long for a free worker before giving up (the website
# then uses the device's voice for that sentence).
QUEUE_TIMEOUT_S = 6.0
# Optional shared key, for if the Space is ever made public.
API_KEY = os.environ.get("DZD_VOICE_KEY", "")


def usable_cpus() -> int:
    """CPUs this container may really use (cgroup quota, then affinity)."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except AttributeError:
        return max(1, os.cpu_count() or 1)


CPUS = usable_cpus()
# Each worker uses about two cores (generation + audio decoding threads).
WORKERS = int(os.environ.get("WORKERS", "0")) or max(1, min(4, CPUS // 2))


def load_model() -> TTSModel:
    # int8 for the transformer: ~27% faster on x86 with the same quality.
    return TTSModel.load_model(quantize=True)


def load_voice(model: TTSModel):
    """The chosen voice: the recording (cloned) or a built-in female voice."""
    if CHOSEN_VOICE != CUSTOM:
        log.info("Using the built-in voice '%s'", CHOSEN_VOICE)
        return model.get_state_for_audio_prompt(CHOSEN_VOICE), CHOSEN_VOICE
    if VOICE_EMBEDDING.exists():
        log.info("Using the uploaded voice embedding")
        return model.get_state_for_audio_prompt(VOICE_EMBEDDING), "custom"
    if VOICE_CACHE.exists():
        return model.get_state_for_audio_prompt(VOICE_CACHE), "custom"
    if VOICE_AUDIO.exists() and model.has_voice_cloning:
        started = time.perf_counter()
        # The first 30 seconds of the recording are plenty.
        state = model.get_state_for_audio_prompt(VOICE_AUDIO, truncate=True)
        try:
            export_model_state(state, VOICE_CACHE)
        except OSError:
            log.exception("Could not cache the voice embedding")
        log.info("Cloned the DZD voice in %.1fs", time.perf_counter() - started)
        return state, "custom"
    if VOICE_AUDIO.exists():
        log.warning(
            "Voice cloning is not available: accept the terms at "
            "https://huggingface.co/kyutai/pocket-tts with your account and add "
            "a read token as the Space secret HF_TOKEN. Using '%s' meanwhile.",
            FALLBACK_VOICE,
        )
    return model.get_state_for_audio_prompt(FALLBACK_VOICE), "fallback"


def to_pcm16(chunk: torch.Tensor) -> bytes:
    audio = chunk.detach().float().clamp(-1.0, 1.0).cpu().numpy()
    return (audio * 32767.0).astype("<i2").tobytes()


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:MAX_CHARS]


log.info("CPUs available: %d, workers: %d", CPUS, WORKERS)
started_loading = time.perf_counter()
MODELS = [load_model() for _ in range(WORKERS)]
VOICE, VOICE_KIND = load_voice(MODELS[0])
SAMPLE_RATE = MODELS[0].sample_rate
# Voice states by name, so other voices can be tried without reloading.
_voices: dict[str, object] = {VOICE_KIND: VOICE}
_voices_lock = threading.Lock()


def voice_state(name: str | None):
    """The state for a voice name ("custom", a female voice) or the default."""
    name = (name or "").strip().lower()
    if name == CUSTOM and VOICE_KIND != CUSTOM and CUSTOM not in _voices:
        if not (VOICE_AUDIO.exists() and MODELS[0].has_voice_cloning):
            raise ValueError("cloning unavailable")
        with _voices_lock:
            if CUSTOM not in _voices:
                _voices[CUSTOM] = MODELS[0].get_state_for_audio_prompt(
                    VOICE_AUDIO, truncate=True
                )
    if name in FEMALE_VOICES:
        with _voices_lock:
            if name not in _voices:
                _voices[name] = MODELS[0].get_state_for_audio_prompt(name)
    return _voices.get(name, VOICE)
log.info("Models ready in %.1fs (voice: %s)", time.perf_counter() - started_loading, VOICE_KIND)


def measure(model: TTSModel, text: str) -> dict[str, float]:
    """Generates once: warms the worker up and measures its speed."""
    started = time.perf_counter()
    first = None
    samples = 0
    for chunk in model.generate_audio_stream(VOICE, text):
        if first is None:
            first = time.perf_counter() - started
        samples += chunk.shape[-1]
    total = time.perf_counter() - started
    audio = samples / SAMPLE_RATE
    return {
        "first_audio_ms": round((first or total) * 1000),
        "realtime_factor": round(audio / total, 2) if total else 0.0,
    }


SPEED: dict[str, float] = {}
for index, warm_model in enumerate(MODELS):
    result = measure(warm_model, "Hi! Let's get started with today's lesson.")
    if index == 0:
        SPEED = result
log.info("Speed after warm-up: %s", SPEED)

# Free workers. Filled once the event loop runs (see `ensure_pool`).
_pool: asyncio.Queue[TTSModel] | None = None
_pool_lock = threading.Lock()


def ensure_pool() -> asyncio.Queue[TTSModel]:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = asyncio.Queue()
            for model in MODELS:
                _pool.put_nowait(model)
    return _pool


router = APIRouter()


@router.get("/health")
async def health() -> JSONResponse:
    pool = ensure_pool()
    return JSONResponse(
        {
            "cpus": CPUS,
            "free_workers": pool.qsize(),
            "ok": True,
            "sample_rate": SAMPLE_RATE,
            "speed": SPEED,
            "voice": VOICE_KIND,
            "voices": [CUSTOM, *FEMALE_VOICES],
            "workers": WORKERS,
        },
        headers={"Cache-Control": "no-store"},
    )


@router.post("/tts")
async def tts(request: Request):
    if API_KEY and request.headers.get("x-voice-key") != API_KEY:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except ValueError:
        body = {}
    text = clean_text(body.get("text", "") if isinstance(body, dict) else "")
    if not re.search(r"\w", text):
        return JSONResponse({"error": "no text"}, status_code=400)
    requested = body.get("voice") if isinstance(body, dict) else None
    try:
        state = await asyncio.to_thread(voice_state, requested)
    except ValueError:
        state = VOICE

    pool = ensure_pool()
    try:
        model = await asyncio.wait_for(pool.get(), QUEUE_TIMEOUT_S)
    except asyncio.TimeoutError:
        return JSONResponse({"error": "busy"}, status_code=503)

    loop = asyncio.get_running_loop()
    chunks: asyncio.Queue[bytes | Exception | None] = asyncio.Queue()
    stop = threading.Event()

    def work() -> None:
        try:
            for chunk in model.generate_audio_stream(state, text, stop=stop):
                loop.call_soon_threadsafe(chunks.put_nowait, to_pcm16(chunk))
                if stop.is_set():
                    break
        except Exception as error:  # noqa: BLE001 - reported to the stream
            log.exception("Generation failed")
            loop.call_soon_threadsafe(chunks.put_nowait, error)
        finally:
            loop.call_soon_threadsafe(chunks.put_nowait, None)
            loop.call_soon_threadsafe(pool.put_nowait, model)

    threading.Thread(target=work, daemon=True).start()

    async def stream():
        try:
            while True:
                item = await chunks.get()
                if item is None or isinstance(item, Exception):
                    break
                yield item
        finally:
            # The listener went away (interrupted): stop generating.
            stop.set()

    return StreamingResponse(
        stream(),
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Voice": VOICE_KIND,
        },
        media_type="application/octet-stream",
    )


VOICE_CHOICES = [("My recording (cloned)", CUSTOM)] + [
    (f"{label} - female", name) for name, label in FEMALE_VOICES.items()
]


async def try_voice(text: str, voice: str, key: str = ""):
    if API_KEY and key != API_KEY:
        raise gr.Error("Enter the voice key to try the voice.")
    text = clean_text(text)
    if not text:
        raise gr.Error("Type something to say.")
    try:
        state = await asyncio.to_thread(voice_state, voice)
    except ValueError:
        raise gr.Error(
            "Cloning your recording isn't available yet: accept the terms at "
            "huggingface.co/kyutai/pocket-tts and add the HF_TOKEN secret."
        ) from None
    pool = ensure_pool()
    model = await pool.get()  # waits its turn with the website's requests
    try:
        audio = await asyncio.to_thread(model.generate_audio, state, text)
    finally:
        pool.put_nowait(model)
    return SAMPLE_RATE, audio.detach().float().clamp(-1, 1).cpu().numpy().astype(np.float32)


if VOICE_KIND == CUSTOM:
    VOICE_NOTE = "your recording (cloned)"
elif VOICE_KIND == "fallback":
    VOICE_NOTE = (
        f"built-in '{FALLBACK_VOICE}' - cloning your recording is NOT available: accept the "
        "terms at huggingface.co/kyutai/pocket-tts and add the HF_TOKEN secret"
    )
else:
    VOICE_NOTE = f"built-in '{VOICE_KIND}'"

with gr.Blocks(title="DZD Voice") as demo:
    gr.Markdown(
        "## DZD Learn AI voice\n"
        f"Website voice: **{VOICE_NOTE}** · workers: {WORKERS} · CPUs: {CPUS} · "
        f"first audio after warm-up: {SPEED.get('first_audio_ms', '?')} ms · "
        f"{SPEED.get('realtime_factor', '?')}× real time\n\n"
        "Try the voices below. To change the website's voice, add the variable "
        "`VOICE` in Settings → Variables (e.g. `jane`, or `custom` for your recording).\n\n"
        "Powered by [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) (CC BY 4.0)."
    )
    box = gr.Textbox(
        label="Text",
        lines=3,
        value="Hi there! Have you ever wondered how plants make their own food? Let's find out together.",
    )
    picker = gr.Dropdown(
        choices=VOICE_CHOICES,
        label="Voice",
        value=VOICE_KIND if VOICE_KIND in dict((v, k) for k, v in VOICE_CHOICES) else "alba",
    )
    key_box = gr.Textbox(label="Voice key", type="password", visible=bool(API_KEY))
    button = gr.Button("Speak", variant="primary")
    player = gr.Audio(label="Voice", autoplay=True)
    button.click(try_voice, inputs=[box, picker, key_box], outputs=player, concurrency_limit=1)

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1)
    demo.launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("PORT", "7860")),
        prevent_thread_lock=True,
        ssr_mode=False,
    )
    # Put the voice endpoints ahead of Gradio's own routes.
    for route in reversed(router.routes):
        demo.app.router.routes.insert(0, route)
    log.info("DZD voice is ready")
    demo.block_thread()
