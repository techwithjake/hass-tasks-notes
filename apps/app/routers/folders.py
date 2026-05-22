from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database import DB_PATH

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row) -> dict:
    return {
        "id":         row["id"],
        "name":       row["name"],
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class FolderCreate(BaseModel):
    name: str
    sort_order: int = 0


class FolderUpdate(BaseModel):
    name:       Optional[str] = None
    sort_order: Optional[int] = None


@router.get("")
async def list_folders():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM folders ORDER BY sort_order ASC, name ASC") as c:
            return [_row_to_dict(r) for r in await c.fetchall()]


@router.post("", status_code=201)
async def create_folder(folder: FolderCreate):
    now = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "INSERT INTO folders (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (folder.name, folder.sort_order, now, now),
        )
        await db.commit()
        async with db.execute("SELECT * FROM folders WHERE id = ?", (cursor.lastrowid,)) as c:
            return _row_to_dict(await c.fetchone())


@router.put("/{folder_id}")
async def update_folder(folder_id: int, folder: FolderUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Folder not found")
        fields: dict = {k: v for k, v in folder.model_dump(exclude_unset=True).items()}
        fields["updated_at"] = _now()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.execute(
            f"UPDATE folders SET {set_clause} WHERE id = ?",
            [*fields.values(), folder_id],
        )
        await db.commit()
        async with db.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)) as c:
            return _row_to_dict(await c.fetchone())


@router.delete("/{folder_id}")
async def delete_folder(folder_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)) as c:
            if not await c.fetchone():
                raise HTTPException(404, "Folder not found")
        # Unassign notes in this folder before deleting
        await db.execute("UPDATE notes SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
        await db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        await db.commit()
    return {"ok": True}
