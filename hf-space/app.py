"""TheStudent AI voice: Kyutai Pocket TTS speaking in the custom voice.

Runs on the Space's CPU only (CPU Basic, or ZeroGPU without ever asking for
the GPU, so no GPU quota is used).

Endpoints (requests need an HF token while the Space is private):
  POST /tts     {"text": "...", optional "voice", "speed", "temperature"}
                -> raw 16-bit mono PCM, streamed as it is made
                   (sample rate in the X-Sample-Rate header)
  GET  /health  readiness, settings in use, workers and measured speed
The page itself is a small studio for trying voices and settings.

Website settings (Space Settings -> Variables):
  VOICE  custom (the recording, default) or a built-in female voice name
  MODEL  standard (fast, default) or hq (24 layers: closer to the
         recording, but slower)
  SPEED  0.6-1.2, 1 = as the model speaks (lower = slower, same pitch)
  TEMP   0.1-1.0 expressiveness, 0.3 default (higher = livelier, less steady)
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
from collections.abc import Iterator
from pathlib import Path

import gradio as gr
import numpy as np
import torch
from audiotsm import wsola
from audiotsm.io.array import ArrayReader, ArrayWriter
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
# The recording to clone: a WAV or FLAC keeps more detail than an MP3.
VOICE_AUDIO = next(
    (HERE / name for name in ("voice.wav", "voice.flac", "voice.mp3") if (HERE / name).exists()),
    HERE / "voice.mp3",
)
CUSTOM = "custom"
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
FALLBACK_VOICE = os.environ.get("FALLBACK_VOICE", "alba")
MODEL_CONFIGS = {"standard": "english", "hq": "english_2026-09_24l"}
MODEL_LABELS = {
    "standard": "Standard (fast)",
    "hq": "High quality (24 layers, closer to the recording, slower)",
}
MAX_CHARS = 600
# Requests wait this long for a free worker before giving up (the website
# then uses the device's voice for that sentence).
QUEUE_TIMEOUT_S = 6.0
# Optional shared key, for if the Space is public.
API_KEY = os.environ.get("DZD_VOICE_KEY", "")


def env_float(name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        value = default
    return min(high, max(low, value))


def clamp(value, default: float, low: float, high: float) -> float:
    try:
        return min(high, max(low, float(value)))
    except (TypeError, ValueError):
        return default


CHOSEN_VOICE = os.environ.get("VOICE", CUSTOM).strip().lower() or CUSTOM
if CHOSEN_VOICE != CUSTOM and CHOSEN_VOICE not in FEMALE_VOICES:
    CHOSEN_VOICE = CUSTOM
MODEL_KIND = os.environ.get("MODEL", "standard").strip().lower()
if MODEL_KIND not in MODEL_CONFIGS:
    MODEL_KIND = "standard"
SPEED_RANGE = (0.6, 1.2)
TEMP_RANGE = (0.1, 1.0)
DEFAULT_SPEED = env_float("SPEED", 1.0, *SPEED_RANGE)
DEFAULT_TEMP = env_float("TEMP", 0.3, *TEMP_RANGE)


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


def load_model(kind: str) -> TTSModel:
    # int8 for the transformer: ~27% faster on x86 with the same quality.
    return TTSModel.load_model(language=MODEL_CONFIGS[kind], quantize=True)


# --- Why cloning may be unavailable -------------------------------------

GATED_REPO = "kyutai/pocket-tts"


def cloning_problem(kind: str) -> str:
    """Why the cloning weights couldn't be downloaded, in plain words."""
    token = (os.environ.get("HF_TOKEN") or "").strip()
    if not token:
        return (
            "the Space secret HF_TOKEN is missing (Settings -> Variables and secrets -> "
            "New secret, name: HF_TOKEN, value: a Read token)"
        )
    try:
        from huggingface_hub import HfApi, get_hf_file_metadata, hf_hub_url

        user = HfApi(token=token).whoami().get("name", "?")
    except Exception:  # noqa: BLE001
        return "the HF_TOKEN secret is not a valid token - create a new Read token and paste it again"
    try:
        path = f"languages/{MODEL_CONFIGS[kind]}/model.safetensors"
        get_hf_file_metadata(hf_hub_url(GATED_REPO, path), token=token)
    except Exception as error:  # noqa: BLE001
        lines = [line.strip() for line in str(error).splitlines() if line.strip()]
        detail = next(
            (
                line
                for line in lines
                if any(word in line.lower() for word in ("gated", "access", "restricted", "token"))
            ),
            lines[0] if lines else type(error).__name__,
        )
        return (
            f"HF_TOKEN belongs to the account '{user}', but it can't open {GATED_REPO}. "
            f"Hugging Face says: {detail[:300]}"
        )
    return (
        f"HF_TOKEN ('{user}') can open {GATED_REPO} now - restart the Space "
        "(Settings -> Restart this Space) to clone the voice"
    )


class CloningUnavailable(Exception):
    pass


# --- Voices ----------------------------------------------------------------

_voice_states: dict[tuple[str, str], object] = {}
_voice_lock = threading.Lock()


def voice_state(model: TTSModel, kind: str, name: str):
    """The voice state for a model kind: the recording (cloned) or a built-in voice.

    Call it with a model nobody else is using right now (cloning runs it).
    """
    key = (kind, name)
    with _voice_lock:
        if key in _voice_states:
            return _voice_states[key]
    if name == CUSTOM:
        if not (VOICE_AUDIO.exists() and model.has_voice_cloning):
            raise CloningUnavailable(kind)
        cache = Path(f"/tmp/dzd-voice-{kind}-{VOICE_AUDIO.stat().st_mtime_ns}.safetensors")
        if cache.exists():
            state = model.get_state_for_audio_prompt(cache)
        else:
            started = time.perf_counter()
            # The first 30 seconds of the recording are plenty.
            state = model.get_state_for_audio_prompt(VOICE_AUDIO, truncate=True)
            try:
                export_model_state(state, cache)
            except OSError:
                log.exception("Could not cache the voice embedding")
            log.info("Cloned the custom voice for %s in %.1fs", kind, time.perf_counter() - started)
    elif name in FEMALE_VOICES:
        state = model.get_state_for_audio_prompt(name)
    else:
        raise KeyError(name)
    with _voice_lock:
        _voice_states[key] = state
    return state


# --- Speed: slower speech with the same pitch (WSOLA time-stretching) ----


class Stretcher:
    """Streams audio through a pitch-preserving time-stretch."""

    def __init__(self, speed: float):
        self.tsm = wsola(1, speed=speed)

    def _collect(self, write) -> np.ndarray:
        writer = ArrayWriter(1)
        while True:
            written, finished = write(writer)
            if finished or written == 0:
                break
        return writer.data[0] if writer.data.size else np.zeros(0, np.float32)

    def push(self, audio: np.ndarray) -> np.ndarray:
        reader = ArrayReader(audio.reshape(1, -1))
        parts = []
        while True:
            consumed = self.tsm.read_from(reader)
            out = self._collect(self.tsm.write_to)
            if out.size:
                parts.append(out)
            if consumed == 0 or reader.empty:
                if reader.empty:
                    out = self._collect(self.tsm.write_to)
                    if out.size:
                        parts.append(out)
                break
        return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, np.float32)

    def flush(self) -> np.ndarray:
        # A little silence first, so the last word isn't clipped.
        tail = self.push(np.zeros(4800, np.float32))
        rest = self._collect(self.tsm.flush_to)
        return np.concatenate([tail, rest]).astype(np.float32)


def synthesize(
    model: TTSModel,
    state,
    text: str,
    speed: float,
    temp: float,
    stop: threading.Event | None = None,
) -> Iterator[np.ndarray]:
    """Float32 audio chunks as they are made (the model is used exclusively)."""
    model.temp = temp
    stretcher = Stretcher(speed) if abs(speed - 1.0) > 0.01 else None
    for chunk in model.generate_audio_stream(state, text, stop=stop):
        audio = chunk.detach().float().clamp(-1.0, 1.0).cpu().numpy().astype(np.float32)
        if stretcher is not None:
            audio = stretcher.push(audio)
        if audio.size:
            yield audio
        if stop is not None and stop.is_set():
            return
    if stretcher is not None:
        tail = stretcher.flush()
        if tail.size:
            yield tail


def to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text[:MAX_CHARS]


# --- Start-up ----------------------------------------------------------------

log.info("CPUs available: %d, workers: %d, model: %s", CPUS, WORKERS, MODEL_KIND)
started_loading = time.perf_counter()
MODELS = [load_model(MODEL_KIND) for _ in range(WORKERS)]
SAMPLE_RATE = MODELS[0].sample_rate
CLONE_PROBLEM = "" if MODELS[0].has_voice_cloning else cloning_problem(MODEL_KIND)
if CLONE_PROBLEM:
    log.warning("Voice cloning is not available: %s", CLONE_PROBLEM)

VOICE_NAME = CHOSEN_VOICE
try:
    voice_state(MODELS[0], MODEL_KIND, VOICE_NAME)
except CloningUnavailable:
    VOICE_NAME = FALLBACK_VOICE
    voice_state(MODELS[0], MODEL_KIND, VOICE_NAME)
log.info(
    "Ready in %.1fs (voice: %s, speed %.2f, temperature %.2f)",
    time.perf_counter() - started_loading,
    VOICE_NAME,
    DEFAULT_SPEED,
    DEFAULT_TEMP,
)


def measure(model: TTSModel, text: str) -> dict[str, float]:
    """Generates once: warms the worker up and measures its speed."""
    state = voice_state(model, MODEL_KIND, VOICE_NAME)
    started = time.perf_counter()
    first = None
    samples = 0
    for audio in synthesize(model, state, text, DEFAULT_SPEED, DEFAULT_TEMP):
        if first is None:
            first = time.perf_counter() - started
        samples += audio.size
    total = time.perf_counter() - started
    return {
        "first_audio_ms": round((first or total) * 1000),
        "realtime_factor": round(samples / SAMPLE_RATE / total, 2) if total else 0.0,
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


# --- Website endpoints ---------------------------------------------------------

router = APIRouter()


@router.get("/health")
async def health() -> JSONResponse:
    pool = ensure_pool()
    return JSONResponse(
        {
            "cpus": CPUS,
            "free_workers": pool.qsize(),
            "model": MODEL_KIND,
            "ok": True,
            "sample_rate": SAMPLE_RATE,
            "speed": SPEED,
            "speech_speed": DEFAULT_SPEED,
            "temperature": DEFAULT_TEMP,
            "voice": VOICE_NAME,
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
    if not isinstance(body, dict):
        body = {}
    text = clean_text(body.get("text", ""))
    if not re.search(r"\w", text):
        return JSONResponse({"error": "no text"}, status_code=400)
    speed = clamp(body.get("speed"), DEFAULT_SPEED, *SPEED_RANGE)
    temp = clamp(body.get("temperature"), DEFAULT_TEMP, *TEMP_RANGE)
    requested = str(body.get("voice") or VOICE_NAME).strip().lower()

    pool = ensure_pool()
    try:
        model = await asyncio.wait_for(pool.get(), QUEUE_TIMEOUT_S)
    except asyncio.TimeoutError:
        return JSONResponse({"error": "busy"}, status_code=503)

    try:
        state = await asyncio.to_thread(voice_state, model, MODEL_KIND, requested)
    except (CloningUnavailable, KeyError):
        state = await asyncio.to_thread(voice_state, model, MODEL_KIND, VOICE_NAME)

    loop = asyncio.get_running_loop()
    chunks: asyncio.Queue[bytes | Exception | None] = asyncio.Queue()
    stop = threading.Event()

    def work() -> None:
        try:
            for audio in synthesize(model, state, text, speed, temp, stop):
                loop.call_soon_threadsafe(chunks.put_nowait, to_pcm16(audio))
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
            "X-Voice": requested,
        },
        media_type="application/octet-stream",
    )


# --- Studio page: try voices and settings -------------------------------------

# The other model kind, loaded only if it's tried on the page.
_trial_models: dict[str, TTSModel] = {}
_trial_lock = asyncio.Lock()


async def trial_model(kind: str) -> TTSModel:
    if kind not in _trial_models:
        _trial_models[kind] = await asyncio.to_thread(load_model, kind)
    return _trial_models[kind]


async def try_voice(text: str, voice: str, kind: str, speed: float, temp: float, key: str = ""):
    if API_KEY and key != API_KEY:
        raise gr.Error("Enter the voice key to try the voice.")
    text = clean_text(text)
    if not text:
        raise gr.Error("Type something to say.")
    kind = kind if kind in MODEL_CONFIGS else MODEL_KIND
    speed = clamp(speed, 1.0, *SPEED_RANGE)
    temp = clamp(temp, 0.3, *TEMP_RANGE)

    async def run(model: TTSModel):
        try:
            state = await asyncio.to_thread(voice_state, model, kind, voice)
        except CloningUnavailable:
            problem = CLONE_PROBLEM or cloning_problem(kind)
            raise gr.Error(f"Cloning your recording isn't available: {problem}") from None
        started = time.perf_counter()
        parts = await asyncio.to_thread(
            lambda: list(synthesize(model, state, text, speed, temp))
        )
        return np.concatenate(parts) if parts else np.zeros(1, np.float32), time.perf_counter() - started

    if kind == MODEL_KIND:
        pool = ensure_pool()
        model = await pool.get()  # waits its turn with the website's requests
        try:
            audio, took = await run(model)
        finally:
            pool.put_nowait(model)
    else:
        async with _trial_lock:
            audio, took = await run(await trial_model(kind))

    seconds = audio.size / SAMPLE_RATE
    factor = seconds / took if took else 0
    warning = " ⚠️ too slow for live calls" if factor < 1.3 else ""
    info = (
        f"Made {seconds:.1f}s of audio in {took:.1f}s (**{factor:.1f}× real time**{warning}).\n\n"
        f"To use these settings on the website, set these Space variables: "
        f"`VOICE={voice}` `MODEL={kind}` `SPEED={speed:g}` `TEMP={temp:g}`"
    )
    return (SAMPLE_RATE, audio), info


VOICE_CHOICES = [("My recording (cloned)", CUSTOM)] + [
    (f"{label} - female", name) for name, label in FEMALE_VOICES.items()
]
if VOICE_NAME == CUSTOM:
    VOICE_NOTE = "your recording (cloned)"
elif CHOSEN_VOICE == CUSTOM:
    VOICE_NOTE = f"built-in '{VOICE_NAME}' (your recording can't be cloned yet)"
else:
    VOICE_NOTE = f"built-in '{VOICE_NAME}'"

with gr.Blocks(title="TheStudent Voice") as demo:
    gr.Markdown(
        "## TheStudent AI voice\n"
        f"Website: **{VOICE_NOTE}** · {MODEL_LABELS[MODEL_KIND]} · speed {DEFAULT_SPEED:g} · "
        f"expressiveness {DEFAULT_TEMP:g} · workers: {WORKERS} · CPUs: {CPUS} · "
        f"first audio after warm-up: {SPEED.get('first_audio_ms', '?')} ms · "
        f"{SPEED.get('realtime_factor', '?')}× real time\n\n"
        + (f"⚠️ **Cloning is not available:** {CLONE_PROBLEM}\n\n" if CLONE_PROBLEM else "")
        + "Try voices and settings below; the result shows the Space variables to set "
        "(Settings → Variables) to use them on the website.\n\n"
        "Powered by [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) (CC BY 4.0)."
    )
    box = gr.Textbox(
        label="Text",
        lines=3,
        value="Hi there! Have you ever wondered how plants make their own food? Let's find out together.",
    )
    with gr.Row():
        picker = gr.Dropdown(choices=VOICE_CHOICES, label="Voice", value=VOICE_NAME)
        model_picker = gr.Radio(
            choices=[(label, kind) for kind, label in MODEL_LABELS.items()],
            label="Model",
            value=MODEL_KIND,
        )
    with gr.Row():
        speed_slider = gr.Slider(
            *SPEED_RANGE,
            step=0.05,
            value=DEFAULT_SPEED,
            label="Speed (lower = slower, same pitch)",
        )
        temp_slider = gr.Slider(
            *TEMP_RANGE,
            step=0.05,
            value=DEFAULT_TEMP,
            label="Expressiveness (higher = livelier, less steady)",
        )
    key_box = gr.Textbox(label="Voice key", type="password", visible=bool(API_KEY))
    button = gr.Button("Speak", variant="primary")
    player = gr.Audio(label="Voice", autoplay=True)
    details = gr.Markdown()
    button.click(
        try_voice,
        inputs=[box, picker, model_picker, speed_slider, temp_slider, key_box],
        outputs=[player, details],
        concurrency_limit=1,
    )


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
    log.info("TheStudent voice is ready")
    demo.block_thread()
