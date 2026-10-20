"""Speech-to-text through the configured OpenAI transcription API or local Whisper."""

import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Optional

import requests

try:
    from .tools import configured_secret
except ImportError:
    from tools import configured_secret


def _openai_transcription(audio_path: str, api_key: str) -> str:
    model = os.getenv("OPENAI_TRANSCRIPTION_MODEL", "whisper-1")
    with open(audio_path, "rb") as audio_file:
        response = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": "Bearer " + api_key},
            data={"model": model, "response_format": "json"},
            files={"file": (os.path.basename(audio_path), audio_file)},
            timeout=(10, 90),
        )
    response.raise_for_status()
    transcript = response.json().get("text", "").strip()
    return transcript or "[No speech detected]"


def _local_transcription(audio_path: str) -> Optional[str]:
    try:
        model = _local_whisper_model()
        segments, _ = model.transcribe(audio_path, beam_size=5)
        return " ".join(segment.text for segment in segments).strip() or "[No speech detected]"
    except Exception:
        return None


@lru_cache(maxsize=1)
def _local_whisper_model():
    from faster_whisper import WhisperModel

    if os.getenv("VERCEL") == "1":
        # Function bundles are read-only; downloaded model files belong in the
        # writable temporary filesystem on Vercel.
        model_dir = Path(tempfile.gettempdir()) / "auralytix-models" / "whisper"
    else:
        model_dir = Path(__file__).resolve().parent / "models" / "whisper"
    model_dir.mkdir(parents=True, exist_ok=True)
    return WhisperModel(
        os.getenv("WHISPER_MODEL_SIZE", "base"),
        device=os.getenv("WHISPER_DEVICE", "cpu"),
        compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
        download_root=str(model_dir),
    )

def transcribe_audio(audio_path: str) -> str:
    """Transcribe using local Whisper when available, then the configured API."""
    api_key = configured_secret("OPENAI_API_KEY")
    provider = os.getenv("SPEECH_PROVIDER", "auto").strip().lower()
    local_attempted = False

    # Prefer the local model in auto mode so exhausted API credits never block voice input
    # and microphone audio stays on this machine when local transcription is installed.
    if provider in {"auto", "local", "whisper"}:
        local_attempted = True
        local_result = _local_transcription(audio_path)
        if local_result is not None:
            return local_result
        if provider in {"local", "whisper"}:
            return "Transcription error: local Whisper could not be started."

    if api_key and provider in {"auto", "openai", "api"}:
        try:
            return _openai_transcription(audio_path, api_key)
        except (requests.RequestException, ValueError, OSError):
            pass

    if not local_attempted:
        local_result = _local_transcription(audio_path)
        if local_result is not None:
            return local_result

    if not api_key:
        return "faster-whisper is not installed and no transcription API key is configured."
    return "Transcription error: the configured speech provider is unavailable."
