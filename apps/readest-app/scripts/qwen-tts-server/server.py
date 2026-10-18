"""Minimal HTTP adapter for Qwen3-TTS, intended for Readest's Qwen provider.

Two modes (env QWEN_TTS_MODE):
  custom (default): Qwen3-TTS CustomVoice, built-in speakers (Serena, ...).
  clone:            Qwen3-TTS Base, clones the voice of a reference clip
                    (QWEN_TTS_REF_AUDIO, with its transcript QWEN_TTS_REF_TEXT).
                    Every Readest voice id maps to that one cloned narrator.

Install requirements.txt, then run this script on a machine with a supported
GPU (or enough CPU/RAM). For LAN use, protect this endpoint with a firewall;
this development adapter intentionally does not implement authentication.
"""
from __future__ import annotations

import io
import os
import queue
import threading
import time
from typing import Literal

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from qwen_tts import Qwen3TTSModel

MODE = os.environ.get("QWEN_TTS_MODE", "custom").lower()
if MODE not in ("custom", "clone"):
    raise RuntimeError("QWEN_TTS_MODE must be 'custom' or 'clone'")
MODEL_ID = os.environ.get(
    "QWEN_TTS_MODEL",
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base" if MODE == "clone" else "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
)
REF_AUDIO = os.environ.get("QWEN_TTS_REF_AUDIO", "")
REF_TEXT = os.environ.get("QWEN_TTS_REF_TEXT", "").strip()
DEVICE_MAP = os.environ.get("QWEN_TTS_DEVICE_MAP", "cuda:0" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else (
    torch.float16 if torch.cuda.is_available() else torch.float32
)
# Concurrent requests (Readest downloads send several sentences at once) are
# grouped into ONE model call: autoregressive decoding is memory-bound, so a
# batch of N sentences costs little more than a single one. Tune the size to
# the GPU (T4: up to ~10-16, L4/A100: 16-24). Past the GPU's limit a batch fails
# and is split in halves automatically.
MAX_BATCH = max(1, int(os.environ.get("QWEN_TTS_MAX_BATCH", "6")))
# How long the worker waits for more requests before running a partial batch.
BATCH_WAIT_S = max(0.0, float(os.environ.get("QWEN_TTS_BATCH_WAIT_MS", "120"))) / 1000
FALLBACK_SPEAKER = "Serena"
KNOWN_SPEAKERS = {
    "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee",
}

app = FastAPI(title="Readest Qwen3-TTS adapter")
# The reader app runs in a WebView origin distinct from the LAN server. This
# development adapter has no credentials, so CORS is open; keep it on a trusted
# LAN and do not expose it to the public Internet.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"]
)
model = None
clone_prompt = None


class _Job:
    def __init__(self, request: "SpeechRequest") -> None:
        self.request = request
        self.done = threading.Event()
        self.audio: np.ndarray | None = None
        self.sample_rate = 0
        self.error: Exception | None = None


_jobs: "queue.Queue[_Job]" = queue.Queue()


class SpeechRequest(BaseModel):
    model: str = MODEL_ID
    input: str = Field(min_length=1, max_length=6000)
    voice: str = FALLBACK_SPEAKER
    language: str = "French"
    instructions: str = "Read naturally and preserve the source language."
    response_format: Literal["wav", "mp3"] = "wav"


@app.on_event("startup")
def load_model() -> None:
    global model, clone_prompt
    if MODE == "clone" and not (REF_AUDIO and os.path.exists(REF_AUDIO)):
        raise RuntimeError("clone mode needs QWEN_TTS_REF_AUDIO pointing to an existing file")
    model = Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        device_map=DEVICE_MAP,
        dtype=DTYPE,
    )
    if MODE == "clone":
        # Encode the reference once; every request reuses the prompt. Without a
        # transcript only the speaker embedding is used (lower similarity).
        try:
            clone_prompt = model.create_voice_clone_prompt(
                ref_audio=REF_AUDIO,
                ref_text=REF_TEXT or None,
                x_vector_only_mode=not REF_TEXT,
            )
        except AttributeError:
            clone_prompt = None  # older qwen-tts: pass the reference per call


@app.get("/health")
def health():
    return {"ok": model is not None, "model": MODEL_ID, "mode": MODE, "max_batch": MAX_BATCH}


def _generate_one(request: SpeechRequest):
    """Single request: the original, known-good call."""
    if MODE == "clone":
        kwargs = {"text": request.input, "language": request.language}
        if clone_prompt is not None:
            kwargs["voice_clone_prompt"] = clone_prompt
        else:
            kwargs.update(ref_audio=REF_AUDIO, ref_text=REF_TEXT or None,
                          x_vector_only_mode=not REF_TEXT)
        return model.generate_voice_clone(**kwargs)
    # Readest's "Narrateur" (cloned) voice has no meaning for built-in speakers.
    speaker = request.voice if request.voice in KNOWN_SPEAKERS else FALLBACK_SPEAKER
    return model.generate_custom_voice(
        text=request.input,
        language=request.language,
        speaker=speaker,
        instruct=request.instructions,
    )


def _generate_many(requests: list[SpeechRequest]):
    """One model call for several requests (list arguments)."""
    n = len(requests)
    texts = [r.input for r in requests]
    languages = [r.language for r in requests]
    if MODE == "clone":
        kwargs = {"text": texts, "language": languages}
        if clone_prompt is not None:
            # The reference prompt is encoded once; repeat it for every item.
            kwargs["voice_clone_prompt"] = (
                list(clone_prompt) * n if isinstance(clone_prompt, (list, tuple)) else [clone_prompt] * n
            )
        else:
            kwargs.update(ref_audio=[REF_AUDIO] * n, ref_text=[REF_TEXT or None] * n,
                          x_vector_only_mode=not REF_TEXT)
        return model.generate_voice_clone(**kwargs)
    return model.generate_custom_voice(
        text=texts,
        language=languages,
        speaker=[r.voice if r.voice in KNOWN_SPEAKERS else FALLBACK_SPEAKER for r in requests],
        instruct=[r.instructions for r in requests],
    )


def _run_batch(batch: list[_Job]) -> None:
    if len(batch) > 1:
        try:
            with torch.inference_mode():
                wavs, sample_rate = _generate_many([job.request for job in batch])
            if len(wavs) != len(batch):
                raise RuntimeError(f"batch returned {len(wavs)} clips for {len(batch)} requests")
            for job, wav in zip(batch, wavs):
                job.audio, job.sample_rate = np.asarray(wav, dtype=np.float32), sample_rate
                job.done.set()
            return
        except Exception as exc:  # noqa: BLE001 - fall back to one-by-one below
            # Most likely out of GPU memory: free it and retry in two halves
            # (recursively), so a too-large batch costs a retry, not N singles.
            print(f"[batch] {len(batch)} requests failed as a batch ({exc!r}); "
                  f"splitting into {len(batch) // 2} + {len(batch) - len(batch) // 2}", flush=True)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            middle = len(batch) // 2
            _run_batch(batch[:middle])
            _run_batch(batch[middle:])
            return
    for job in batch:
        try:
            with torch.inference_mode():
                wavs, sample_rate = _generate_one(job.request)
            job.audio, job.sample_rate = np.asarray(wavs[0], dtype=np.float32), sample_rate
        except Exception as exc:  # noqa: BLE001 - reported to the caller
            job.error = exc
        job.done.set()


def _worker() -> None:
    """The only thread that touches the model: collects a batch, runs it."""
    while True:
        batch = [_jobs.get()]
        deadline = time.monotonic() + BATCH_WAIT_S
        while len(batch) < MAX_BATCH:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                batch.append(_jobs.get(timeout=remaining))
            except queue.Empty:
                break
        _run_batch(batch)


threading.Thread(target=_worker, name="tts-batch-worker", daemon=True).start()


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Qwen model is not loaded")
    job = _Job(request)
    _jobs.put(job)
    job.done.wait()
    if job.error is not None or job.audio is None:
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {job.error}")
    try:
        buffer = io.BytesIO()
        if request.response_format == "mp3":
            # ~10x smaller than WAV, and concatenated sentence MP3s stay a
            # playable chapter file (Readest packs sentences back to back).
            sf.write(buffer, job.audio, job.sample_rate, format="MP3")
            media_type = "audio/mpeg"
        else:
            sf.write(buffer, job.audio, job.sample_rate, format="WAV", subtype="PCM_16")
            media_type = "audio/wav"
        return Response(content=buffer.getvalue(), media_type=media_type)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Encoding failed: {exc}") from exc
