"""Minimal HTTP adapter for Qwen3-TTS, intended for Readest's Qwen provider.

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

MODEL_ID = os.environ.get(
    "QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
)
DEVICE_MAP = os.environ.get("QWEN_TTS_DEVICE_MAP", "cuda:0" if torch.cuda.is_available() else "cpu")
DTYPE = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else (
    torch.float16 if torch.cuda.is_available() else torch.float32
)

app = FastAPI(title="Readest Qwen3-TTS adapter")
# The reader app runs in a WebView origin distinct from the LAN server. This
# development adapter has no credentials, so CORS is open; keep it on a trusted
# LAN and do not expose it to the public Internet.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"]
)
model = None
model_lock = threading.Lock()


class SpeechRequest(BaseModel):
    model: str = MODEL_ID
    input: str = Field(min_length=1, max_length=6000)
    voice: str = "Serena"
    language: str = "French"
    instructions: str = "Read naturally and preserve the source language."
    response_format: Literal["wav"] = "wav"


@app.on_event("startup")
def load_model() -> None:
    global model
    model = Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        device_map=DEVICE_MAP,
        dtype=DTYPE,
    )


@app.get("/health")
def health():
    return {"ok": model is not None, "model": MODEL_ID}


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Qwen model is not loaded")
    try:
        # Model inference is serialized to avoid concurrent GPU memory spikes.
        with model_lock, torch.inference_mode():
            wavs, sample_rate = model.generate_custom_voice(
                text=request.input,
                language=request.language,
                speaker=request.voice,
                instruct=request.instructions,
            )
        audio = np.asarray(wavs[0], dtype=np.float32)
        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        return Response(content=buffer.getvalue(), media_type="audio/wav")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc
