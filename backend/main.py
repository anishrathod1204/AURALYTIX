import asyncio
from contextlib import asynccontextmanager
from email.parser import BytesParser
from email.policy import default as email_policy
import logging
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator


def load_backend_environment() -> None:
    env_path = Path(__file__).with_name(".env")
    if not env_path.is_file():
        return
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path)
        return
    except ImportError:
        pass
    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip("\"'"))


load_backend_environment()
logger = logging.getLogger("auralytix")

try:
    from .agent import AuralytixAgent, clear_session
    from .llm import llm_is_configured
    from .stt import transcribe_audio
    from .storage import prune_expired_history, storage_ready
    from .tools import integration_status
except ImportError:
    from agent import AuralytixAgent, clear_session
    from llm import llm_is_configured
    from stt import transcribe_audio
    from storage import prune_expired_history, storage_ready
    from tools import integration_status

MAX_AUDIO_BYTES = 20 * 1024 * 1024
ALLOWED_AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".mp4", ".flac", ".aac"}

async def cleanup_history_loop():
    while True:
        try:
            await asyncio.to_thread(prune_expired_history)
        except Exception as exc:
            logger.warning("Session retention cleanup unavailable (%s)", type(exc).__name__)
        await asyncio.sleep(15 * 60)


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(cleanup_history_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="AURALYTIX Research API", version="2.0.0", lifespan=lifespan)

@app.middleware("http")
async def mount_vercel_api_prefix(request: Request, call_next):
    path = request.scope.get("path", "")
    if path == "/api" or path.startswith("/api/"):
        request.scope["root_path"] = "/api"
    return await call_next(request)

configured_origins = os.getenv("FRONTEND_URL", "http://localhost:3000,http://127.0.0.1:3000")
allowed_origins = [origin.strip().rstrip("/") for origin in configured_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

_agent: Optional[AuralytixAgent] = None


def get_agent() -> AuralytixAgent:
    global _agent
    if _agent is None:
        _agent = AuralytixAgent()
    return _agent


def new_session_id() -> str:
    return str(uuid.uuid4())


def clean_session_id(value: Optional[str]) -> str:
    candidate = (value or "").strip()
    if not candidate:
        return new_session_id()
    if len(candidate) > 128 or not re.fullmatch(r"[A-Za-z0-9_-]+", candidate):
        raise HTTPException(status_code=422, detail="The session identifier is invalid.")
    return candidate


class QueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    session_id: Optional[str] = Field(default=None, max_length=128)
    modality: Optional[str] = Field(default="text", max_length=20)

    @field_validator("query")
    @classmethod
    def require_non_blank_query(cls, value: str) -> str:
        clean_value = value.strip()
        if not clean_value:
            raise ValueError("A question is required.")
        return clean_value


class QueryResponse(BaseModel):
    answer: str
    query: Optional[str] = None
    transcript: Optional[str] = None
    modality: Optional[str] = "text"
    session_id: str
    sources: List[Dict[str, Any]] = Field(default_factory=list)
    dashboard_data: Dict[str, Any] = Field(default_factory=dict)
    answer_pending: bool = False
    task_id: Optional[str] = None


@app.get("/")
async def root():
    return {"message": "AURALYTIX Research API is running", "status": "ok"}


@app.get("/health")
async def health():
    integrations = integration_status()
    local_storage_ready = storage_ready()
    return {
        "status": "healthy" if local_storage_ready else "degraded",
        "agent_ready": local_storage_ready,
        "reasoning_configured": llm_is_configured(),
        "storage": "ready" if local_storage_ready else "unavailable",
        "integrations": integrations,
    }


@app.post("/query", response_model=QueryResponse)
async def handle_query(req: QueryRequest):
    session_id = clean_session_id(req.session_id)
    try:
        result = await get_agent().run(
            req.query,
            session_id=session_id,
            modality=req.modality or "text",
            defer_synthesis=True,
        )
        return QueryResponse(**result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Research request failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=502, detail="The research request could not be completed. Try again shortly.")


@app.get("/query/answer/{task_id}")
async def query_answer_update(task_id: str):
    try:
        task_id = str(uuid.UUID(task_id))
    except (TypeError, ValueError, AttributeError):
        raise HTTPException(status_code=404, detail="This answer update was not found.")
    result = get_agent().get_answer_update(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="This answer update has expired or was not found.")
    return result


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    clean_id = clean_session_id(session_id)
    try:
        await asyncio.to_thread(clear_session, clean_id)
        return {"deleted": True, "session_id": clean_id}
    except Exception as exc:
        logger.error("Session cleanup failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="This session could not be cleared right now.")


async def save_audio_upload(request: Request) -> str:
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type.lower():
        raise HTTPException(status_code=415, detail="Upload an audio recording using the voice input control.")
    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_AUDIO_BYTES + 128 * 1024:
            raise HTTPException(status_code=413, detail="Audio files must be 20 MB or smaller.")
        chunks.append(chunk)
    envelope = (
        b"Content-Type: " + content_type.encode("latin-1") +
        b"\r\nMIME-Version: 1.0\r\n\r\n" + b"".join(chunks)
    )
    try:
        message = BytesParser(policy=email_policy).parsebytes(envelope)
        upload = next(
            part for part in message.iter_parts()
            if part.get_param("name", header="content-disposition") == "file"
        )
        filename = upload.get_filename() or "voice-query.webm"
        content = upload.get_payload(decode=True) or b""
    except (AttributeError, StopIteration, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="No audio file was received.")
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_AUDIO_SUFFIXES:
        suffix = ".webm"
    if not content:
        raise HTTPException(status_code=400, detail="The audio file is empty.")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio files must be 20 MB or smaller.")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
        temporary.write(content)
        return temporary.name


def remove_temporary_file(path: Optional[str]) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.error("Temporary audio cleanup failed (%s)", type(exc).__name__)


def validate_transcription(text: str) -> str:
    if not text or text.startswith("Transcription error:") or text.startswith("faster-whisper is not installed"):
        raise HTTPException(status_code=503, detail="Speech recognition is unavailable. Check the API key or local Whisper setup.")
    clean_text = text.strip()
    if clean_text == "[No speech detected]":
        raise HTTPException(status_code=422, detail="No speech was detected. Try recording again.")
    normalized = re.sub(r"[^a-z0-9\s]", " ", clean_text.casefold())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if normalized in {"you", "uh", "um", "umm", "hmm", "hm"}:
        raise HTTPException(
            status_code=422,
            detail="Only a short fragment was recognized. Try again and speak a complete question.",
        )
    return clean_text


async def transcribe_upload(request: Request) -> tuple[str, Optional[str]]:
    temporary_path = None
    try:
        temporary_path = await save_audio_upload(request)
        transcript = await asyncio.to_thread(transcribe_audio, temporary_path)
        return validate_transcription(transcript), temporary_path
    except HTTPException:
        remove_temporary_file(temporary_path)
        raise
    except Exception as exc:
        remove_temporary_file(temporary_path)
        logger.error("Transcription request failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Speech recognition could not be completed.")


@app.post("/transcribe")
async def transcribe(request: Request):
    temporary_path = None
    try:
        text, temporary_path = await transcribe_upload(request)
        return {"text": text}
    finally:
        remove_temporary_file(temporary_path)


@app.post("/voice-query", response_model=QueryResponse)
async def voice_query(request: Request, session_id: Optional[str] = None):
    temporary_path = None
    try:
        transcript, temporary_path = await transcribe_upload(request)
        clean_id = clean_session_id(session_id)
        result = await get_agent().run(transcript, session_id=clean_id, modality="voice")
        return QueryResponse(**result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Voice research request failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Voice analysis could not be completed. Try again shortly.")
    finally:
        remove_temporary_file(temporary_path)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("BACKEND_HOST", "127.0.0.1"),
        port=int(os.getenv("BACKEND_PORT", 8010)),
        reload=False,
    )
