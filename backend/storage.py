"""Local conversation history with a short, explicit retention window."""

import os
import sqlite3
import threading
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List

_lock = threading.RLock()
_retention_seconds = 24 * 60 * 60


def _database_path() -> Path:
    configured = os.getenv("AURALYTIX_DB_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser()
    elif os.getenv("VERCEL") == "1":
        # Vercel's function bundle is read-only. /tmp is writable for the life
        # of an instance, so use it for best-effort session context when no
        # external database has been configured.
        path = Path(tempfile.gettempdir()) / "auralytix.sqlite3"
    else:
        path = Path(__file__).resolve().parent / "data" / "auralytix.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_database_path(), timeout=10)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS messages ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, "
        "content TEXT NOT NULL, created_at INTEGER NOT NULL)"
    )
    connection.execute("CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_id, created_at, id)")
    return connection


@contextmanager
def _connection():
    connection = _connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def get_history(session_id: str, limit: int = 10) -> List[Dict[str, str]]:
    now = int(time.time())
    with _lock, _connection() as connection:
        connection.execute("DELETE FROM messages WHERE created_at < ?", (now - _retention_seconds,))
        rows = connection.execute(
            "SELECT role, content FROM messages WHERE session_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
            (session_id, now - _retention_seconds, max(1, min(limit, 20))),
        ).fetchall()
    return [{"role": role, "content": content} for role, content in reversed(rows)]


def append_exchange(session_id: str, query: str, answer: str) -> None:
    now = int(time.time())
    with _lock, _connection() as connection:
        connection.executemany(
            "INSERT INTO messages(session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            [(session_id, "user", query[:2000], now), (session_id, "assistant", answer[:12000], now)],
        )
        connection.execute("DELETE FROM messages WHERE created_at < ?", (now - _retention_seconds,))


def replace_last_exchange_answer(session_id: str, query: str, answer: str) -> None:
    """Replace the stored fallback answer for the matching latest query, if it still exists."""
    with _lock, _connection() as connection:
        connection.execute(
            "UPDATE messages SET content = ? WHERE id = ("
            "SELECT answer.id FROM messages AS answer "
            "JOIN messages AS question ON question.session_id = answer.session_id "
            "WHERE answer.session_id = ? AND answer.role = 'assistant' "
            "AND question.role = 'user' AND question.content = ? AND question.id < answer.id "
            "AND NOT EXISTS (SELECT 1 FROM messages AS later_question "
            "WHERE later_question.session_id = question.session_id AND later_question.role = 'user' "
            "AND later_question.id > question.id AND later_question.id < answer.id) "
            "ORDER BY question.id DESC LIMIT 1)",
            (answer[:12000], session_id, query[:2000]),
        )


def clear_history(session_id: str) -> None:
    with _lock, _connection() as connection:
        connection.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))


def prune_expired_history() -> None:
    now = int(time.time())
    with _lock, _connection() as connection:
        connection.execute("DELETE FROM messages WHERE created_at < ?", (now - _retention_seconds,))


def storage_ready() -> bool:
    try:
        with _lock, _connection() as connection:
            connection.execute("SELECT 1").fetchone()
        prune_expired_history()
        return True
    except (OSError, sqlite3.Error):
        return False
