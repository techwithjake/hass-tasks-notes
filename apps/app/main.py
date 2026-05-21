import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from database import init_db
from routers import notes, tasks
from routers import projects

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Tasks & Notes", lifespan=lifespan)

app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
app.include_router(tasks.router,    prefix="/api/tasks",    tags=["tasks"])
app.include_router(notes.router,    prefix="/api/notes",    tags=["notes"])


# Serve static files with no-cache headers so dev reloads always pick up changes
@app.get("/static/{filename:path}")
async def static_files(filename: str):
    path = os.path.join(STATIC_DIR, filename)
    if not os.path.isfile(path):
        return Response(status_code=404)
    resp = FileResponse(path)
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.get("/")
async def root():
    # Inject cache-busting hashes based on file mtime so browsers always load fresh assets
    html_path = os.path.join(STATIC_DIR, "index.html")
    js_path   = os.path.join(STATIC_DIR, "app.js")
    css_path  = os.path.join(STATIC_DIR, "style.css")

    js_v  = int(os.path.getmtime(js_path))
    css_v = int(os.path.getmtime(css_path))

    with open(html_path, "r") as f:
        html = f.read()

    html = html.replace('src="static/app.js"',   f'src="static/app.js?v={js_v}"')
    html = html.replace('href="static/style.css"', f'href="static/style.css?v={css_v}"')

    return Response(
        content=html,
        media_type="text/html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"},
    )
