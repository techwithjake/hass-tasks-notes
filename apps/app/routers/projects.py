from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import DB_PATH

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_to_dict(row) -> dict:
    return {
        "id":         row["id"],
        "name":       row["name"],
        "color":      row["color"],
        "is_inbox":   bool(row["is_inbox"]),
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _section_to_dict(row) -> dict:
    return {
        "id":         row["id"],
        "project_id": row["project_id"],
        "name":       row["name"],
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# ── Project models ────────────────────────────────────────

class ProjectCreate(BaseModel):
    name:  str
    color: str = "#3b82f6"


class ProjectUpdate(BaseModel):
    name:       Optional[str] = None
    color:      Optional[str] = None
    sort_order: Optional[int] = None


class ProjectReorderItem(BaseModel):
    id:         int
    sort_order: int


# ── Section models ────────────────────────────────────────

class SectionCreate(BaseModel):
    name: str


class SectionUpdate(BaseModel):
    name:       Optional[str] = None
    sort_order: Optional[int] = None


# ── Projects CRUD ─────────────────────────────────────────

@router.get("")
async def list_projects():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM projects ORDER BY is_inbox DESC, sort_order ASC, id ASC"
        ) as c:
            return [_project_to_dict(r) for r in await c.fetchall()]


@router.post("", status_code=201)
async def create_project(proj: ProjectCreate):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects WHERE is_inbox = 0"
        ) as c:
            next_order = (await c.fetchone())[0]
        cursor = await db.execute(
            "INSERT INTO projects (name, color, is_inbox, sort_order, created_at, updated_at)"
            " VALUES (?, ?, 0, ?, ?, ?)",
            (proj.name, proj.color, next_order, now, now),
        )
        await db.commit()
        async with db.execute("SELECT * FROM projects WHERE id = ?", (cursor.lastrowid,)) as c:
            return _project_to_dict(await c.fetchone())


@router.put("/reorder")
async def reorder_projects(items: list[ProjectReorderItem]):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        for item in items:
            await db.execute(
                "UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ? AND is_inbox = 0",
                (item.sort_order, now, item.id),
            )
        await db.commit()
    return {"ok": True}


@router.put("/{project_id}")
async def update_project(project_id: int, proj: ProjectUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, is_inbox FROM projects WHERE id = ?", (project_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Project not found")

        fields = proj.model_dump(exclude_unset=True)
        if not fields:
            async with db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)) as c:
                return _project_to_dict(await c.fetchone())

        fields["updated_at"] = _now()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.execute(
            f"UPDATE projects SET {set_clause} WHERE id = ?",
            [*fields.values(), project_id],
        )
        await db.commit()
        async with db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)) as c:
            return _project_to_dict(await c.fetchone())


@router.delete("/{project_id}")
async def delete_project(project_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT is_inbox FROM projects WHERE id = ?", (project_id,)) as c:
            row = await c.fetchone()
        if not row:
            raise HTTPException(404, "Project not found")
        if row[0]:
            raise HTTPException(400, "Cannot delete the Inbox project")
        await db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        await db.commit()
    return {"ok": True}


# ── Sections CRUD ─────────────────────────────────────────

@router.get("/{project_id}/sections")
async def list_sections(project_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM sections WHERE project_id = ? ORDER BY sort_order ASC, id ASC",
            (project_id,),
        ) as c:
            return [_section_to_dict(r) for r in await c.fetchall()]


@router.post("/{project_id}/sections", status_code=201)
async def create_section(project_id: int, sec: SectionCreate):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Project not found")
        async with db.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sections WHERE project_id = ?",
            (project_id,),
        ) as c:
            next_order = (await c.fetchone())[0]
        cursor = await db.execute(
            "INSERT INTO sections (project_id, name, sort_order, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (project_id, sec.name, next_order, now, now),
        )
        await db.commit()
        async with db.execute("SELECT * FROM sections WHERE id = ?", (cursor.lastrowid,)) as c:
            return _section_to_dict(await c.fetchone())


@router.put("/{project_id}/sections/{section_id}")
async def update_section(project_id: int, section_id: int, sec: SectionUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM sections WHERE id = ? AND project_id = ?",
            (section_id, project_id),
        ) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Section not found")

        fields = sec.model_dump(exclude_unset=True)
        if not fields:
            async with db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)) as c:
                return _section_to_dict(await c.fetchone())

        fields["updated_at"] = _now()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.execute(
            f"UPDATE sections SET {set_clause} WHERE id = ?",
            [*fields.values(), section_id],
        )
        await db.commit()
        async with db.execute("SELECT * FROM sections WHERE id = ?", (section_id,)) as c:
            return _section_to_dict(await c.fetchone())


@router.delete("/{project_id}/sections/{section_id}")
async def delete_section(project_id: int, section_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM sections WHERE id = ? AND project_id = ?",
            (section_id, project_id),
        ) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Section not found")
        await db.execute("DELETE FROM sections WHERE id = ?", (section_id,))
        await db.commit()
    return {"ok": True}
