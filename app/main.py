"""Сайт «Куда сдать»: фото отхода → тип материала и способ утилизации."""

from __future__ import annotations

import asyncio
import io
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image, UnidentifiedImageError

from app.classifier import MODEL_DIR, get_classifier
from app.disposal import guide_cards

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = Jinja2Templates(directory=str(ROOT / "app" / "templates"))
SAMPLES_DIR = ROOT / "app" / "static" / "samples"
MAX_BYTES = 8 * 1024 * 1024
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("kuda")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        classifier = get_classifier()
        app.state.model_ready = True
        app.state.labels = classifier.labels
        app.state.metrics = classifier.metrics
        logger.info("model loaded: %s", classifier.path)
    except Exception:
        app.state.model_ready = False
        app.state.labels = []
        app.state.metrics = None
        logger.exception("model failed to load")
    yield


app = FastAPI(title="Куда сдать", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(ROOT / "app" / "static")), name="static")


def sample_cards() -> list[dict]:
    titles = {card["id"]: card["title"] for card in guide_cards()}
    cards = []
    if not SAMPLES_DIR.exists():
        return cards
    for path in sorted(SAMPLES_DIR.iterdir()):
        if path.suffix.lower() not in IMAGE_SUFFIXES or path.name.startswith("."):
            continue
        key = path.stem.split("-")[0]
        cards.append(
            {
                "url": f"/static/samples/{path.name}",
                "title": titles.get(key, path.stem),
                "id": key,
            }
        )
    return cards


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    metrics = getattr(request.app.state, "metrics", None)
    return TEMPLATES.TemplateResponse(
        request,
        "index.html",
        {
            "samples": sample_cards(),
            "guides": guide_cards(),
            "metrics": metrics,
            "model_ready": getattr(request.app.state, "model_ready", False),
        },
    )


@app.get("/api/health")
def health(request: Request):
    metrics = getattr(request.app.state, "metrics", None) or {}
    return {
        "ok": bool(getattr(request.app.state, "model_ready", False)),
        "labels": getattr(request.app.state, "labels", []),
        "val_accuracy_pct": metrics.get("val_accuracy_pct"),
        "model_dir": str(MODEL_DIR),
    }


@app.post("/api/classify")
async def classify(file: UploadFile = File(...)):
    if not getattr(app.state, "model_ready", False):
        raise HTTPException(
            status_code=503,
            detail="Модель ещё не готова. Проверьте файлы keras_model в папке model.",
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Файл пустой.")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Файл больше 8 МБ. Сожмите фото и попробуйте снова.")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="Это не похоже на фото. Нужен JPEG, PNG или WebP.")
    try:
        return await asyncio.to_thread(get_classifier().predict, image)
    except Exception:
        logger.exception("classify failed")
        raise HTTPException(
            status_code=500,
            detail="Не получилось разобрать это фото. Попробуйте другой снимок.",
        )
