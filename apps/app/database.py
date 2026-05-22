import os
from datetime import datetime, timezone

import aiosqlite

DB_PATH = os.environ.get("APPS_DB_PATH", "/data/apps.db")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _column_exists(db, table: str, column: str) -> bool:
    async with db.execute(f"PRAGMA table_info({table})") as c:
        return any(row[1] == column for row in await c.fetchall())


async def _table_exists(db, table: str) -> bool:
    async with db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ) as c:
        return await c.fetchone() is not None


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode = WAL")
        await db.execute("PRAGMA foreign_keys = ON")

        # ── Projects ──────────────────────────────────────────
        await db.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                color       TEXT    NOT NULL DEFAULT '#3b82f6',
                is_inbox    INTEGER NOT NULL DEFAULT 0,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL
            )
        """)

        # ── Sections ──────────────────────────────────────────
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sections (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL
            )
        """)

        # ── Tasks (base table) ────────────────────────────────
        await db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT    NOT NULL,
                notes       TEXT    NOT NULL DEFAULT '',
                due_date    TEXT,
                priority    TEXT    NOT NULL DEFAULT 'normal',
                tags        TEXT    NOT NULL DEFAULT '',
                completed   INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL
            )
        """)

        # ── Migrate: add new task columns if missing ──────────
        for col, defn in [
            ("project_id",   "INTEGER REFERENCES projects(id) ON DELETE SET NULL"),
            ("section_id",   "INTEGER REFERENCES sections(id) ON DELETE SET NULL"),
            ("parent_id",    "INTEGER REFERENCES tasks(id) ON DELETE CASCADE"),
            ("sort_order",   "INTEGER NOT NULL DEFAULT 0"),
            ("recurrence",   "TEXT"),
            ("completed_at", "TEXT"),
        ]:
            if not await _column_exists(db, "tasks", col):
                await db.execute(f"ALTER TABLE tasks ADD COLUMN {col} {defn}")

        # ── Seed Inbox project ────────────────────────────────
        async with db.execute("SELECT id FROM projects WHERE is_inbox = 1") as c:
            inbox_row = await c.fetchone()
        if not inbox_row:
            now = _now()
            cursor = await db.execute(
                "INSERT INTO projects (name, color, is_inbox, sort_order, created_at, updated_at)"
                " VALUES ('Inbox', '#3b82f6', 1, 0, ?, ?)",
                (now, now),
            )
            inbox_id = cursor.lastrowid
            await db.execute(
                "UPDATE tasks SET project_id = ? WHERE project_id IS NULL",
                (inbox_id,),
            )

        # ── Note folders ──────────────────────────────────────
        await db.execute("""
            CREATE TABLE IF NOT EXISTS folders (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL
            )
        """)

        # ── Notes ─────────────────────────────────────────────
        await db.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT    NOT NULL,
                content     TEXT    NOT NULL DEFAULT '',
                tags        TEXT    NOT NULL DEFAULT '',
                created_at  TEXT    NOT NULL,
                updated_at  TEXT    NOT NULL
            )
        """)

        # ── Migrate: add folder_id to notes if missing ────────
        if not await _column_exists(db, "notes", "folder_id"):
            await db.execute(
                "ALTER TABLE notes ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL"
            )

        await db.commit()

        # ── FTS + triggers (executescript auto-commits) ────────
        await db.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
                title, notes, tags,
                content=tasks, content_rowid=id
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                title, content, tags,
                content=notes, content_rowid=id
            );

            CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
                INSERT INTO tasks_fts(rowid, title, notes, tags)
                VALUES (new.id, new.title, new.notes, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
                INSERT INTO tasks_fts(tasks_fts, rowid, title, notes, tags)
                VALUES ('delete', old.id, old.title, old.notes, old.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
                INSERT INTO tasks_fts(tasks_fts, rowid, title, notes, tags)
                VALUES ('delete', old.id, old.title, old.notes, old.tags);
                INSERT INTO tasks_fts(rowid, title, notes, tags)
                VALUES (new.id, new.title, new.notes, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
                INSERT INTO notes_fts(rowid, title, content, tags)
                VALUES (new.id, new.title, new.content, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
                INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
                VALUES ('delete', old.id, old.title, old.content, old.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
                INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
                VALUES ('delete', old.id, old.title, old.content, old.tags);
                INSERT INTO notes_fts(rowid, title, content, tags)
                VALUES (new.id, new.title, new.content, new.tags);
            END;
        """)
