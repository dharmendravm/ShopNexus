#!/usr/bin/env python3
"""
Local free FASHN VTON v1.5 HTTP server for Shop Nexus.

Exposes the sync endpoint the Shopify app expects:
  POST /v1/try-on
  {
    "model_image": "<data-uri or url>",
    "garment_image": "<data-uri or url>",
    "category": "tops" | "bottoms" | "one-pieces",
    "num_inference_steps": 30,
    "num_samples": 1
  }

Setup (once):
  git clone https://github.com/fashn-AI/fashn-vton-1.5.git
  cd fashn-vton-1.5 && python -m venv .venv && source .venv/bin/activate
  pip install -e .
  python scripts/download_weights.py --weights-dir ./weights
  pip install -r /path/to/shop-nexus/scripts/fashn-vton-local/requirements.txt

Run:
  export FASHN_WEIGHTS_DIR=/path/to/fashn-vton-1.5/weights
  python server.py
  # listens on http://127.0.0.1:8000

Needs ~8GB NVIDIA VRAM for usable speed. CPU works but is very slow.
"""

from __future__ import annotations

import base64
import io
import os
import re
from contextlib import asynccontextmanager
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image

WEIGHTS_DIR = os.environ.get("FASHN_WEIGHTS_DIR", "./weights")
HOST = os.environ.get("FASHN_LOCAL_HOST", "127.0.0.1")
PORT = int(os.environ.get("FASHN_LOCAL_PORT", "8000"))
DEVICE = os.environ.get("FASHN_DEVICE")  # cuda / cpu / None=auto

VALID_CATEGORIES = {"tops", "bottoms", "one-pieces"}
DATA_URI_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL | re.IGNORECASE)

_pipeline = None


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        try:
            from fashn_vton import TryOnPipeline
        except ImportError as exc:
            raise RuntimeError(
                "fashn_vton is not installed. "
                "Clone https://github.com/fashn-AI/fashn-vton-1.5 and `pip install -e .`"
            ) from exc

        if not os.path.isdir(WEIGHTS_DIR):
            raise RuntimeError(
                f"Weights not found at {WEIGHTS_DIR}. "
                "Run: python scripts/download_weights.py --weights-dir ./weights"
            )

        print(f"[FASHN Local] Loading TryOnPipeline from {WEIGHTS_DIR} ...")
        _pipeline = TryOnPipeline(weights_dir=WEIGHTS_DIR, device=DEVICE)
        print("[FASHN Local] Pipeline ready.")
    return _pipeline


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Eager load so first storefront request is not cold-start heavy
    try:
        get_pipeline()
    except Exception as exc:
        print(f"[FASHN Local] WARNING: pipeline not loaded yet: {exc}")
    yield


app = FastAPI(title="FASHN VTON 1.5 Local", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TryOnRequest(BaseModel):
    model_image: str = Field(..., description="Person photo (URL or data URI)")
    garment_image: str = Field(..., description="Garment photo (URL or data URI)")
    category: str = "tops"
    num_inference_steps: int = 30
    num_timesteps: Optional[int] = None
    num_samples: int = 1
    garment_photo_type: str = "auto"
    guidance_scale: float = 1.5
    seed: int = 42
    segmentation_free: bool = True


def _decode_data_uri(value: str) -> Image.Image:
    match = DATA_URI_RE.match(value.strip())
    if not match:
        raise ValueError("Invalid data URI")
    raw = base64.b64decode(match.group(2))
    return Image.open(io.BytesIO(raw)).convert("RGB")


async def load_image(value: str) -> Image.Image:
    value = (value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Empty image value")

    if value.startswith("data:"):
        try:
            return _decode_data_uri(value)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Bad data URI: {exc}") from exc

    if value.startswith("http://") or value.startswith("https://"):
        try:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                resp = await client.get(value)
                resp.raise_for_status()
            return Image.open(io.BytesIO(resp.content)).convert("RGB")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to fetch image URL: {exc}") from exc

    if os.path.isfile(value):
        return Image.open(value).convert("RGB")

    raise HTTPException(status_code=400, detail="Image must be data URI, http(s) URL, or local path")


def image_to_data_uri(image: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    save_kwargs: dict[str, Any] = {}
    if fmt.upper() == "JPEG":
        save_kwargs["quality"] = 92
        if image.mode != "RGB":
            image = image.convert("RGB")
    image.save(buf, format=fmt, **save_kwargs)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    mime = "image/jpeg" if fmt.upper() == "JPEG" else "image/png"
    return f"data:{mime};base64,{b64}"


@app.get("/")
@app.get("/health")
def health():
    ready = _pipeline is not None
    return {
        "status": "ok" if ready else "starting",
        "provider": "fashn-vton-1.5-local",
        "weights_dir": WEIGHTS_DIR,
        "pipeline_loaded": ready,
    }


@app.post("/v1/try-on")
async def try_on(body: TryOnRequest):
    category = (body.category or "tops").lower().strip()
    if category == "auto":
        category = "tops"
    if category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"category must be one of {sorted(VALID_CATEGORIES)}",
        )

    steps = body.num_timesteps or body.num_inference_steps or 30
    steps = max(1, min(50, int(steps)))
    samples = max(1, min(4, int(body.num_samples or 1)))

    garment_photo_type = (body.garment_photo_type or "auto").lower()
    if garment_photo_type not in {"auto", "model", "flat-lay"}:
        garment_photo_type = "auto"
    # Pipeline expects model|flat-lay; map auto → model (product CDN shots often on-model)
    if garment_photo_type == "auto":
        garment_photo_type = "model"

    person = await load_image(body.model_image)
    garment = await load_image(body.garment_image)

    try:
        pipeline = get_pipeline()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    print(
        f"[FASHN Local] try-on category={category} steps={steps} "
        f"samples={samples} person={person.size} garment={garment.size}"
    )

    try:
        result = pipeline(
            person_image=person,
            garment_image=garment,
            category=category,
            garment_photo_type=garment_photo_type,
            num_samples=samples,
            num_timesteps=steps,
            guidance_scale=float(body.guidance_scale),
            seed=int(body.seed),
            segmentation_free=bool(body.segmentation_free),
        )
    except Exception as exc:
        print(f"[FASHN Local] inference error: {exc}")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc

    images = getattr(result, "images", None) or []
    if not images:
        raise HTTPException(status_code=500, detail="Pipeline returned no images")

    data_uris = [image_to_data_uri(img) for img in images]
    return {
        "status": "success",
        "provider": "fashn-vton-1.5-local",
        "image_url": data_uris[0],
        "output": data_uris,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
