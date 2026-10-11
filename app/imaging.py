"""Подготовка снимка так же, как в экспорте Google Teachable Machine."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageOps

IMAGE_SIZE = 224


def prepare_image(image: Image.Image, size: int = IMAGE_SIZE) -> np.ndarray:
    """Вернуть батч 1×224×224×3 в диапазоне [-1, 1]."""
    image = ImageOps.exif_transpose(image).convert("RGB")
    image = ImageOps.fit(image, (size, size), Image.Resampling.LANCZOS)
    array = np.asarray(image).astype(np.float32)
    array = (array / 127.5) - 1.0
    return array.reshape(1, size, size, 3)
