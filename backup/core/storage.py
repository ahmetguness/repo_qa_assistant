"""Sohbet geçmişi kaydetme ve yükleme (SQLite)."""

import json
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(".repo_cache") / "chat_history.db"


def _get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_url TEXT NOT NULL,
            title TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        )
    """)
    conn.commit()
    return conn


def save_session(repo_url: str, messages: list[dict], title: str = "") -> int:
    """Sohbet oturumunu kaydeder, session_id döndürür."""
    conn = _get_conn()
    now = datetime.now().isoformat()

    if not title and messages:
        # İlk kullanıcı mesajından başlık oluştur
        for m in messages:
            if m["role"] == "user":
                title = m["content"][:80]
                break
    title = title or "Başlıksız"

    cursor = conn.execute(
        "INSERT INTO sessions (repo_url, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (repo_url, title, now, now),
    )
    session_id = cursor.lastrowid

    for m in messages:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, m["role"], m["content"], now),
        )

    conn.commit()
    conn.close()
    return session_id


def list_sessions(limit: int = 20) -> list[dict]:
    """Son oturumları listeler."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, repo_url, title, created_at FROM sessions ORDER BY updated_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [
        {"id": r[0], "repo_url": r[1], "title": r[2], "created_at": r[3]}
        for r in rows
    ]


def load_session(session_id: int) -> tuple[str, list[dict]]:
    """Oturumu yükler. (repo_url, messages) döndürür."""
    conn = _get_conn()
    row = conn.execute("SELECT repo_url FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        conn.close()
        return "", []

    repo_url = row[0]
    msg_rows = conn.execute(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall()
    conn.close()

    messages = [{"role": r[0], "content": r[1]} for r in msg_rows]
    return repo_url, messages


def delete_session(session_id: int) -> None:
    """Oturumu siler."""
    conn = _get_conn()
    conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()


def export_session_markdown(session_id: int) -> str:
    """Oturumu markdown formatında export eder."""
    repo_url, messages = load_session(session_id)
    if not messages:
        return ""

    lines = [
        f"# Repo QA — {repo_url}",
        f"*Tarih: {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n",
        "---\n",
    ]

    for m in messages:
        if m["role"] == "user":
            lines.append(f"## 🧑 Kullanıcı\n{m['content']}\n")
        else:
            lines.append(f"## 🤖 Asistan\n{m['content']}\n")
        lines.append("---\n")

    return "\n".join(lines)
