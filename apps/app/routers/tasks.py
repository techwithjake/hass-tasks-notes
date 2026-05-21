import re
from datetime import date, datetime, timedelta, timezone
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
        "id":               row["id"],
        "title":            row["title"],
        "notes":            row["notes"],
        "due_date":         row["due_date"],
        "priority":         row["priority"],
        "tags":             [t.strip() for t in row["tags"].split(",") if t.strip()],
        "completed":        bool(row["completed"]),
        "completed_at":     row["completed_at"],
        "project_id":       row["project_id"],
        "section_id":       row["section_id"],
        "parent_id":        row["parent_id"],
        "sort_order":       row["sort_order"],
        "recurrence":       row["recurrence"],
        "subtask_count":    row["subtask_count"] if "subtask_count" in keys else 0,
        "subtask_done":     row["subtask_done"] if "subtask_done" in keys else 0,
        "created_at":       row["created_at"],
        "updated_at":       row["updated_at"],
    }


def _next_due_date(current_due: Optional[str], recurrence: str) -> Optional[str]:
    base = date.fromisoformat(current_due) if current_due else date.today()
    if recurrence == "daily":
        return (base + timedelta(days=1)).isoformat()
    if recurrence == "weekdays":
        d = base + timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        return d.isoformat()
    if recurrence == "weekends":
        d = base + timedelta(days=1)
        while d.weekday() < 5:
            d += timedelta(days=1)
        return d.isoformat()
    if recurrence == "weekly":
        return (base + timedelta(weeks=1)).isoformat()
    if recurrence == "monthly":
        month = base.month % 12 + 1
        year  = base.year + (1 if base.month == 12 else 0)
        day   = min(base.day, [31, 28 + int(year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)),
                                31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
        return date(year, month, day).isoformat()
    if recurrence == "yearly":
        try:
            return date(base.year + 1, base.month, base.day).isoformat()
        except ValueError:
            return date(base.year + 1, base.month, 28).isoformat()
    return None


# ── Models ────────────────────────────────────────────────

class TaskCreate(BaseModel):
    title:      str
    notes:      str = ""
    due_date:   Optional[str] = None
    priority:   str = "normal"
    tags:       list[str] = []
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    parent_id:  Optional[int] = None
    recurrence: Optional[str] = None


class TaskUpdate(BaseModel):
    title:      Optional[str] = None
    notes:      Optional[str] = None
    due_date:   Optional[str] = None
    priority:   Optional[str] = None
    tags:       Optional[list[str]] = None
    completed:  Optional[bool] = None
    project_id: Optional[int] = None
    section_id: Optional[int] = None
    parent_id:  Optional[int] = None
    sort_order: Optional[int] = None
    recurrence: Optional[str] = None


class ReorderItem(BaseModel):
    id:         int
    sort_order: int


# ── List tasks ────────────────────────────────────────────

_SUBTASK_COUNT_SQL = "(SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id)"
_SUBTASK_DONE_SQL  = "(SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.completed = 1)"

_BASE_SELECT = (
    f"SELECT t.*, {_SUBTASK_COUNT_SQL} AS subtask_count,"
    f" {_SUBTASK_DONE_SQL} AS subtask_done FROM tasks t"
)


@router.get("")
async def list_tasks(
    project_id: Optional[int] = Query(None),
    section_id: Optional[int] = Query(None),
    view:       str = Query(""),          # "" | "today" | "upcoming" | "all"
    status:     str = Query("active"),    # "active" | "completed" | "all"
    priority:   str = Query(""),
    tag:        str = Query(""),
    search:     str = Query(""),
    parent_id:  Optional[int] = Query(None),
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
            ph = ",".join("?" * len(ids))
            query  = f"{_BASE_SELECT} WHERE t.id IN ({ph}) AND t.parent_id IS NULL"
            params: list = ids[:]
        else:
            query  = f"{_BASE_SELECT} WHERE t.parent_id IS NULL"
            params = []

        # View-based filters
        today_str = date.today().isoformat()
        if view == "today":
            query += " AND t.due_date IS NOT NULL AND t.due_date <= ?"
            params.append(today_str)
        elif view == "upcoming":
            upcoming = (date.today() + timedelta(days=7)).isoformat()
            query += " AND t.due_date IS NOT NULL AND t.due_date > ? AND t.due_date <= ?"
            params += [today_str, upcoming]
        elif view == "all":
            pass  # no date filter
        elif project_id is not None:
            query += " AND t.project_id = ?"
            params.append(project_id)
            if section_id is not None:
                query += " AND t.section_id = ?"
                params.append(section_id)

        # Status filter
        if status == "active":
            query += " AND t.completed = 0"
        elif status == "completed":
            query += " AND t.completed = 1"

        if priority:
            query += " AND t.priority = ?"
            params.append(priority)

        if tag:
            query += " AND (',' || t.tags || ',' LIKE ?)"
            params.append(f"%,{tag},%")

        # Sort
        if view in ("today", "upcoming", "all"):
            query += " ORDER BY t.completed ASC, t.due_date ASC, t.priority DESC, t.sort_order ASC"
        else:
            query += " ORDER BY t.completed ASC, t.sort_order ASC, t.created_at DESC"

        async with db.execute(query, params) as c:
            return [_row_to_dict(r) for r in await c.fetchall()]


# ── Create ────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_task(task: TaskCreate):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Resolve default project (Inbox)
        project_id = task.project_id
        if project_id is None:
            async with db.execute("SELECT id FROM projects WHERE is_inbox = 1") as c:
                row = await c.fetchone()
            project_id = row[0] if row else None

        # Next sort_order within the target section/project
        async with db.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks"
            " WHERE project_id IS ? AND section_id IS ? AND parent_id IS ?",
            (project_id, task.section_id, task.parent_id),
        ) as c:
            next_order = (await c.fetchone())[0]

        cursor = await db.execute(
            "INSERT INTO tasks"
            " (title, notes, due_date, priority, tags, completed,"
            "  project_id, section_id, parent_id, sort_order, recurrence,"
            "  created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
            (
                task.title, task.notes, task.due_date, task.priority,
                ",".join(task.tags), project_id, task.section_id,
                task.parent_id, next_order, task.recurrence, now, now,
            ),
        )
        await db.commit()
        async with db.execute(
            f"{_BASE_SELECT} WHERE t.id = ?", (cursor.lastrowid,)
        ) as c:
            return _row_to_dict(await c.fetchone())


# ── Get single ────────────────────────────────────────────

@router.get("/{task_id}")
async def get_task(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"{_BASE_SELECT} WHERE t.id = ?", (task_id,)
        ) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Task not found")
        return _row_to_dict(row)


# ── Subtasks ──────────────────────────────────────────────

@router.get("/{task_id}/subtasks")
async def list_subtasks(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC",
            (task_id,),
        ) as c:
            return [_row_to_dict(r) for r in await c.fetchall()]


# ── Update ────────────────────────────────────────────────

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
                if task.completed:
                    fields["completed_at"] = _now()
                else:
                    fields["completed_at"] = None
            else:
                fields[field] = getattr(task, field)
        fields["updated_at"] = _now()

        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.execute(
            f"UPDATE tasks SET {set_clause} WHERE id = ?",
            [*fields.values(), task_id],
        )
        await db.commit()
        async with db.execute(f"{_BASE_SELECT} WHERE t.id = ?", (task_id,)) as c:
            return _row_to_dict(await c.fetchone())


# ── Delete ────────────────────────────────────────────────

@router.delete("/{task_id}")
async def delete_task(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Task not found")
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await db.commit()
    return {"ok": True}


# ── Toggle (with recurrence) ──────────────────────────────

@router.post("/{task_id}/toggle")
async def toggle_task(task_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Task not found")

        now = _now()
        completing = not row["completed"]

        if completing and row["recurrence"]:
            # Mark done and spawn the next occurrence
            await db.execute(
                "UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?",
                (now, now, task_id),
            )
            next_due = _next_due_date(row["due_date"], row["recurrence"])
            async with db.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks"
                " WHERE project_id IS ? AND section_id IS ? AND parent_id IS NULL",
                (row["project_id"], row["section_id"]),
            ) as c:
                next_order = (await c.fetchone())[0]
            await db.execute(
                "INSERT INTO tasks"
                " (title, notes, due_date, priority, tags, completed,"
                "  project_id, section_id, parent_id, sort_order, recurrence,"
                "  created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?)",
                (
                    row["title"], row["notes"], next_due, row["priority"], row["tags"],
                    row["project_id"], row["section_id"], next_order,
                    row["recurrence"], now, now,
                ),
            )
        elif completing:
            await db.execute(
                "UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE id = ?",
                (now, now, task_id),
            )
        else:
            await db.execute(
                "UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE id = ?",
                (now, task_id),
            )

        await db.commit()
        async with db.execute(f"{_BASE_SELECT} WHERE t.id = ?", (task_id,)) as c:
            return _row_to_dict(await c.fetchone())


# ── Reorder ───────────────────────────────────────────────

@router.post("/reorder")
async def reorder_tasks(items: list[ReorderItem]):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        for item in items:
            await db.execute(
                "UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?",
                (item.sort_order, now, item.id),
            )
        await db.commit()
    return {"ok": True}
