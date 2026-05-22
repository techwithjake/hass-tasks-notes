import re
from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database import DB_PATH

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fts_query(search: str) -> Optional[str]:
    safe = re.sub(r"[^\w\s-]", " ", search).strip()
    if not safe:
        return None
    return " ".join(f"{w}*" for w in safe.split())


def _row_to_dict(row) -> dict:
    keys = row.keys()
    return {
        "id":        row["id"],
        "title":     row["title"],
        "content":   row["content"],
        "tags":      [t.strip() for t in row["tags"].split(",") if t.strip()],
        "folder_id": row["folder_id"] if "folder_id" in keys else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class NoteCreate(BaseModel):
    title:     str
    content:   str = ""
    tags:      list[str] = []
    folder_id: Optional[int] = None


class NoteUpdate(BaseModel):
    title:     Optional[str] = None
    content:   Optional[str] = None
    tags:      Optional[list[str]] = None
    folder_id: Optional[int] = None


@router.get("")
async def list_notes(
    search:    str          = Query(""),
    tag:       str          = Query(""),
    folder_id: Optional[int] = Query(None),
    unfoldered: bool        = Query(False),
):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        if search:
            fts = _fts_query(search)
            if not fts:
                return []
            async with db.execute(
                "SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?", (fts,)
            ) as c:
                ids = [r[0] for r in await c.fetchall()]
            if not ids:
                return []
            placeholders = ",".join("?" * len(ids))
            query = f"SELECT * FROM notes WHERE id IN ({placeholders}) ORDER BY updated_at DESC"
            params: list = ids[:]
        else:
            query = "SELECT * FROM notes WHERE 1=1"
            params = []

        if tag:
            query += " AND (',' || tags || ',' LIKE ?)"
            params.append(f"%,{tag},%")

        if folder_id is not None:
            query += " AND folder_id = ?"
            params.append(folder_id)
        elif unfoldered:
            query += " AND folder_id IS NULL"

        if "ORDER BY" not in query:
            query += " ORDER BY updated_at DESC"

        async with db.execute(query, params) as c:
            return [_row_to_dict(r) for r in await c.fetchall()]


@router.post("", status_code=201)
async def create_note(note: NoteCreate):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "INSERT INTO notes (title, content, tags, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (note.title, note.content, ",".join(note.tags), note.folder_id, now, now),
        )
        await db.commit()
        async with db.execute("SELECT * FROM notes WHERE id = ?", (cursor.lastrowid,)) as c:
            return _row_to_dict(await c.fetchone())


@router.get("/{note_id}")
async def get_note(note_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Note not found")
        return _row_to_dict(row)


@router.put("/{note_id}")
async def update_note(note_id: int, note: NoteUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id FROM notes WHERE id = ?", (note_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Note not found")

        fields: dict = {}
        for field in note.model_fields_set:
            if field == "tags":
                fields["tags"] = ",".join(note.tags)
            else:
                fields[field] = getattr(note, field)
        fields["updated_at"] = _now()

        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.execute(
            f"UPDATE notes SET {set_clause} WHERE id = ?",
            [*fields.values(), note_id],
        )
        await db.commit()
        async with db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)) as c:
            return _row_to_dict(await c.fetchone())


@router.get("/{note_id}/backlinks")
async def get_backlinks(note_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT title FROM notes WHERE id = ?", (note_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Note not found")
        title = row["title"]
        # Escape LIKE special chars in title
        escaped = title.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
        pattern = f"%[[{escaped}]]%"
        async with db.execute(
            "SELECT id, title, updated_at FROM notes WHERE id != ? AND content LIKE ? ESCAPE '\\'",
            (note_id, pattern),
        ) as c:
            rows = await c.fetchall()
        return [{"id": r["id"], "title": r["title"], "updated_at": r["updated_at"]} for r in rows]


@router.delete("/{note_id}")
async def delete_note(note_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM notes WHERE id = ?", (note_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Note not found")
        await db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        await db.commit()
    return {"ok": True}
