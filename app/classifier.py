"""Загрузка модели Google Teachable Machine и распознавание материала."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from app.disposal import advice_for
from app.imaging import prepare_image

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "model"

HIGH_CONFIDENCE = 0.72
MID_CONFIDENCE = 0.45


def parse_labels(path: Path) -> list[str]:
    labels: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        head, _, tail = line.partition(" ")
        if head.isdigit() and tail:
            labels.append(tail.strip())
        else:
            labels.append(line)
    if not labels:
        raise ValueError(f"В {path} нет меток классов")
    return labels


def model_path() -> Path:
    h5_path = MODEL_DIR / "keras_model.h5"
    keras_path = MODEL_DIR / "keras_model.keras"
    if h5_path.exists():
        return h5_path
    if keras_path.exists():
        return keras_path
    raise FileNotFoundError(
        "Модель не найдена. Положите в папку model файл keras_model.h5 "
        "из Google Teachable Machine и labels.txt."
    )


class WasteClassifier:
    def __init__(self) -> None:
        import tensorflow as tf

        self.tf = tf
        path = model_path()
        self.model = tf.keras.models.load_model(path, compile=False)
        self.labels = parse_labels(MODEL_DIR / "labels.txt")
        self.path = path
        self.metrics = _read_metrics(MODEL_DIR / "metrics.json")
        self._lock = threading.Lock()
        warmup = np.zeros((1, 224, 224, 3), dtype=np.float32)
        self.model(warmup, training=False)

    def predict(self, image: Image.Image) -> dict:
        batch = prepare_image(image)
        with self._lock:
            probabilities = self.model(batch, training=False).numpy()[0]
        order = np.argsort(probabilities)[::-1]
        ranked = []
        for index in order:
            label = self.labels[int(index)] if int(index) < len(self.labels) else f"class_{index}"
            ranked.append(
                {
                    "label": label,
                    "confidence": float(probabilities[int(index)]),
                }
            )
        best = ranked[0]
        advice = advice_for(best["label"])
        confidence = best["confidence"]
        if confidence >= HIGH_CONFIDENCE:
            level = "high"
            level_text = "Уверенно"
        elif confidence >= MID_CONFIDENCE:
            level = "medium"
            level_text = "Есть сомнение"
        else:
            level = "low"
            level_text = "Низкая уверенность"
        return {
            "label": best["label"],
            "confidence": confidence,
            "level": level,
            "level_text": level_text,
            "advice": advice,
            "alternatives": [
                {"label": item["label"], "title": advice_for(item["label"])["title"], "confidence": item["confidence"]}
                for item in ranked[1:3]
            ],
        }


def _read_metrics(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


_classifier: WasteClassifier | None = None
_classifier_lock = threading.Lock()


def get_classifier() -> WasteClassifier:
    global _classifier
    if _classifier is None:
        with _classifier_lock:
            if _classifier is None:
                _classifier = WasteClassifier()
    return _classifier
