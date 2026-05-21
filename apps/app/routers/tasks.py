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
    return {
        "id": row["id"],
        "title": row["title"],
        "notes": row["notes"],
        "due_date": row["due_date"],
        "priority": row["priority"],
        "tags": [t.strip() for t in row["tags"].split(",") if t.strip()],
        "completed": bool(row["completed"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class TaskCreate(BaseModel):
    title: str
    notes: str = ""
    due_date: Optional[str] = None
    priority: str = "normal"
    tags: list[str] = []


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    notes: Optional[str] = None
    due_date: Optional[str] = None
    priority: Optional[str] = None
    tags: Optional[list[str]] = None
    completed: Optional[bool] = None


@router.get("")
async def list_tasks(
    status: str = Query("all"),
    priority: str = Query(""),
    tag: str = Query(""),
    search: str = Query(""),
):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        if search:
            fts = _fts_query(search)
            if not fts:
                return []
            async with db.execute(
                "SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?", (fts,)
            ) as c:
                ids = [r[0] for r in await c.fetchall()]
            if not ids:
                return []
            placeholders = ",".join("?" * len(ids))
            query = f"SELECT * FROM tasks WHERE id IN ({placeholders})"
            params: list = ids[:]
        else:
            query = "SELECT * FROM tasks WHERE 1=1"
            params = []

        if status == "active":
            query += " AND completed = 0"
        elif status == "completed":
            query += " AND completed = 1"

        if priority:
            query += " AND priority = ?"
            params.append(priority)

        if tag:
            query += " AND (',' || tags || ',' LIKE ?)"
            params.append(f"%,{tag},%")

        query += " ORDER BY completed ASC, created_at DESC"

        async with db.execute(query, params) as c:
            return [_row_to_dict(r) for r in await c.fetchall()]


@router.post("", status_code=201)
async def create_task(task: TaskCreate):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "INSERT INTO tasks (title, notes, due_date, priority, tags, completed, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            (task.title, task.notes, task.due_date, task.priority, ",".join(task.tags), now, now),
        )
        await db.commit()
        async with db.execute("SELECT * FROM tasks WHERE id = ?", (cursor.lastrowid,)) as c:
            return _row_to_dict(await c.fetchone())


@router.get("/{task_id}")
async def get_task(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Task not found")
        return _row_to_dict(row)


@router.put("/{task_id}")
async def update_task(task_id: int, task: TaskUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Task not found")

        fields: dict = {}
        for field in task.model_fields_set:
            if field == "tags":
                fields["tags"] = ",".join(task.tags)
            elif field == "completed":
                fields["completed"] = int(task.completed)
            else:
                fields[field] = getattr(task, field)
        fields["updated_at"] = _now()

        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.execute(
            f"UPDATE tasks SET {set_clause} WHERE id = ?",
            [*fields.values(), task_id],
        )
        await db.commit()
        async with db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)) as c:
            return _row_to_dict(await c.fetchone())


@router.delete("/{task_id}")
async def delete_task(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Task not found")
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await db.commit()
    return {"ok": True}


@router.post("/{task_id}/toggle")
async def toggle_task(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Task not found")
        await db.execute(
            "UPDATE tasks SET completed = ?, updated_at = ? WHERE id = ?",
            (0 if row["completed"] else 1, _now(), task_id),
        )
        await db.commit()
        async with db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)) as c:
            return _row_to_dict(await c.fetchone())
