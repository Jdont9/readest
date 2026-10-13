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
import threading
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
model_lock = threading.Lock()


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
    return {"ok": model is not None, "model": MODEL_ID, "mode": MODE}


def _generate(request: SpeechRequest):
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


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Qwen model is not loaded")
    try:
        # Model inference is serialized to avoid concurrent GPU memory spikes.
        with model_lock, torch.inference_mode():
            wavs, sample_rate = _generate(request)
        audio = np.asarray(wavs[0], dtype=np.float32)
        buffer = io.BytesIO()
        if request.response_format == "mp3":
            # ~10x smaller than WAV, and concatenated sentence MP3s stay a
            # playable chapter file (Readest packs sentences back to back).
            sf.write(buffer, audio, sample_rate, format="MP3")
            media_type = "audio/mpeg"
        else:
            sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
            media_type = "audio/wav"
        return Response(content=buffer.getvalue(), media_type=media_type)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc
