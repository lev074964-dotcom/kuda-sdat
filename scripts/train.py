#!/usr/bin/env python3
"""Обучить классификатор отходов и сохранить его в формате Teachable Machine.

Вход 224×224, нормализация (x / 127.5) - 1, метки в labels.txt.
Свою модель с https://teachablemachine.withgoogle.com/ можно подставить
вместо результата этого скрипта: keras_model.h5 + labels.txt.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.imaging import IMAGE_SIZE, prepare_image  # noqa: E402

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def collect_items(data_dir: Path) -> tuple[list[str], list[tuple[Path, int]]]:
    classes = sorted(
        path.name
        for path in data_dir.iterdir()
        if path.is_dir() and not path.name.startswith((".", "_"))
    )
    if not classes:
        raise SystemExit(f"В {data_dir} нет папок с классами")
    items: list[tuple[Path, int]] = []
    for index, name in enumerate(classes):
        for path in sorted((data_dir / name).iterdir()):
            if path.suffix.lower() not in IMAGE_SUFFIXES or path.name.startswith("."):
                continue
            items.append((path, index))
    if not items:
        raise SystemExit(f"В {data_dir} нет изображений")
    return classes, items


def read_uint8(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image = ImageOps.fit(image, (IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.LANCZOS)
        return np.asarray(image, dtype=np.uint8)


def stratified_split(
    labels: np.ndarray, val_ratio: float, seed: int
) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    train_parts: list[np.ndarray] = []
    val_parts: list[np.ndarray] = []
    for class_index in np.unique(labels):
        indexes = np.flatnonzero(labels == class_index)
        rng.shuffle(indexes)
        val_count = max(1, int(round(len(indexes) * val_ratio)))
        val_parts.append(indexes[:val_count])
        train_parts.append(indexes[val_count:])
    return np.concatenate(train_parts), np.concatenate(val_parts)


def make_dataset(images: np.ndarray, labels: np.ndarray, training: bool, batch_size: int):
    import tensorflow as tf

    dataset = tf.data.Dataset.from_tensor_slices((images, labels))
    if training:
        dataset = dataset.shuffle(len(images), seed=42, reshuffle_each_iteration=True)

    def prepare(image, label):
        image = tf.cast(image, tf.float32)
        if training:
            image = tf.image.random_flip_left_right(image)
            image = tf.image.random_brightness(image, 18)
            image = tf.image.random_contrast(image, 0.9, 1.1)
            image = tf.clip_by_value(image, 0.0, 255.0)
        image = (image / 127.5) - 1.0
        return image, label

    return dataset.map(prepare, num_parallel_calls=tf.data.AUTOTUNE).batch(batch_size).prefetch(tf.data.AUTOTUNE)


def class_weights(labels: np.ndarray) -> dict[int, float]:
    counts = np.bincount(labels)
    total = float(len(labels))
    classes = len(counts)
    return {index: total / (classes * float(count)) for index, count in enumerate(counts) if count}


def build_model(num_classes: int):
    import tensorflow as tf
    from tensorflow import keras

    base = keras.applications.MobileNetV2(
        input_shape=(IMAGE_SIZE, IMAGE_SIZE, 3),
        include_top=False,
        weights="imagenet",
        pooling="avg",
    )
    base.trainable = False
    inputs = keras.Input(shape=(IMAGE_SIZE, IMAGE_SIZE, 3), name="image")
    features = base(inputs, training=False)
    features = keras.layers.Dropout(0.25)(features)
    outputs = keras.layers.Dense(num_classes, activation="softmax", name="predictions")(features)
    model = keras.Model(inputs, outputs, name="waste_teachable")
    model.compile(
        optimizer=keras.optimizers.Adam(1e-3),
        loss=keras.losses.SparseCategoricalCrossentropy(),
        metrics=[keras.metrics.SparseCategoricalAccuracy(name="accuracy")],
    )
    return model, base


def fit_phase(model, train_ds, val_ds, epochs: int, weights: dict[int, float]):
    from tensorflow import keras

    callbacks = [
        keras.callbacks.EarlyStopping(
            monitor="val_accuracy",
            patience=3,
            restore_best_weights=True,
        )
    ]
    return model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=epochs,
        class_weight=weights,
        callbacks=callbacks,
        verbose=2,
    )


def evaluate(model, images: np.ndarray, labels: np.ndarray, classes: list[str]) -> dict:
    normalized = (images.astype(np.float32) / 127.5) - 1.0
    probabilities = model.predict(normalized, batch_size=32, verbose=0)
    predicted = probabilities.argmax(axis=1)
    accuracy = float((predicted == labels).mean())
    per_class = {}
    for index, name in enumerate(classes):
        mask = labels == index
        per_class[name] = float((predicted[mask] == index).mean()) if mask.any() else None
    return {"val_accuracy": accuracy, "per_class_accuracy": per_class, "predicted": predicted}


def export_samples(model, items, val_indexes, classes: list[str], destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for old in destination.iterdir():
        if old.suffix.lower() in IMAGE_SUFFIXES:
            old.unlink()
    by_class: dict[int, list[Path]] = {index: [] for index in range(len(classes))}
    val_set = set(int(index) for index in val_indexes)
    ordered = sorted(val_set, key=lambda index: str(items[index][0]))
    rest = [index for index in range(len(items)) if index not in val_set]
    for index in ordered + rest:
        by_class[items[index][1]].append(items[index][0])

    for class_index, name in enumerate(classes):
        saved = False
        for path in by_class[class_index]:
            with Image.open(path) as image:
                batch = prepare_image(image)
                probabilities = model(batch, training=False).numpy()[0]
            winner = int(probabilities.argmax())
            if winner != class_index or float(probabilities[winner]) < 0.55:
                continue
            with Image.open(path) as image:
                image = ImageOps.exif_transpose(image).convert("RGB")
                image.thumbnail((720, 720))
                image.save(destination / f"{name}.jpg", quality=85, optimize=True)
            saved = True
            print(f"sample {name}: {path.name} ({float(probabilities[winner]):.2f})")
            break
        if not saved:
            print(f"warning: no confident sample for {name}")


def save_labels(path: Path, classes: list[str]) -> None:
    lines = [f"{index} {name}" for index, name in enumerate(classes)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("/tmp/trashnet/dataset-resized"))
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--finetune-epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()

    import tensorflow as tf
    from tensorflow import keras

    tf.random.set_seed(42)
    np.random.seed(42)

    classes, items = collect_items(args.data)
    print(f"classes: {classes}")
    print(f"images: {len(items)}")
    images = np.empty((len(items), IMAGE_SIZE, IMAGE_SIZE, 3), dtype=np.uint8)
    labels = np.empty((len(items),), dtype=np.int64)
    for index, (path, label) in enumerate(items):
        images[index] = read_uint8(path)
        labels[index] = label
        if index % 400 == 0:
            print(f"loaded {index}/{len(items)}")

    train_indexes, val_indexes = stratified_split(labels, 0.2, seed=42)
    train_ds = make_dataset(images[train_indexes], labels[train_indexes], True, args.batch_size)
    val_ds = make_dataset(images[val_indexes], labels[val_indexes], False, args.batch_size)
    weights = class_weights(labels[train_indexes])
    print("class weights", weights)

    model, base = build_model(len(classes))
    print("phase 1: train the head")
    fit_phase(model, train_ds, val_ds, args.epochs, weights)
    phase1 = evaluate(model, images[val_indexes], labels[val_indexes], classes)
    print("phase 1 accuracy", round(phase1["val_accuracy"], 4))
    phase1_path = ROOT / "model" / "_phase1.keras"
    phase1_path.parent.mkdir(parents=True, exist_ok=True)
    model.save(phase1_path)

    print("phase 2: fine-tune the top of MobileNetV2")
    base.trainable = True
    for layer in base.layers[:-40]:
        layer.trainable = False
    for layer in base.layers:
        if isinstance(layer, keras.layers.BatchNormalization):
            layer.trainable = False
    model.compile(
        optimizer=keras.optimizers.Adam(1e-5),
        loss=keras.losses.SparseCategoricalCrossentropy(),
        metrics=[keras.metrics.SparseCategoricalAccuracy(name="accuracy")],
    )
    fit_phase(model, train_ds, val_ds, args.finetune_epochs, weights)
    phase2 = evaluate(model, images[val_indexes], labels[val_indexes], classes)
    print("phase 2 accuracy", round(phase2["val_accuracy"], 4), phase2["per_class_accuracy"])
    if phase2["val_accuracy"] + 1e-6 < phase1["val_accuracy"]:
        print("keeping phase 1 weights")
        model = keras.models.load_model(phase1_path)
        report = phase1
    else:
        report = phase2

    model_dir = ROOT / "model"
    model.save(model_dir / "keras_model.keras")
    save_labels(model_dir / "labels.txt", classes)
    metrics = {
        "val_accuracy": report["val_accuracy"],
        "val_accuracy_pct": round(report["val_accuracy"] * 100),
        "per_class_accuracy": report["per_class_accuracy"],
        "classes": classes,
        "images": len(items),
        "architecture": "MobileNetV2",
        "input_size": IMAGE_SIZE,
        "normalization": "(x / 127.5) - 1",
        "format": "Teachable Machine compatible Keras model",
        "dataset": "TrashNet (Yang, Thung, 2016)",
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    (model_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if phase1_path.exists():
        phase1_path.unlink()
    export_samples(model, items, val_indexes, classes, ROOT / "app" / "static" / "samples")
    print("saved", model_dir / "keras_model.keras")


if __name__ == "__main__":
    main()
