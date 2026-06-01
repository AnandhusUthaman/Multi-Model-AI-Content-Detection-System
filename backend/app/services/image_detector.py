from __future__ import annotations

import base64
from io import BytesIO

import numpy as np
import requests
import torch
from PIL import Image
from torchvision import transforms

from app.models.image_cnn import load_model


class ImageDetector:
    def __init__(self, checkpoint_path: str | None = None) -> None:
        self.device = "cpu"
        self.model = load_model(checkpoint_path=checkpoint_path, device=self.device)
        self.transform = transforms.Compose(
            [
                transforms.Resize((224, 224)),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=[0.485, 0.456, 0.406],
                    std=[0.229, 0.224, 0.225],
                ),
            ]
        )

    def _download_bytes(self, url: str, timeout: int = 7) -> bytes | None:
        try:
            resp = requests.get(
                url,
                timeout=timeout,
                headers={"User-Agent": "Mozilla/5.0 (AI-Detector/0.1)"},
            )
            resp.raise_for_status()
            return resp.content
        except Exception:
            return None

    def _fetch_image(self, url: str) -> Image.Image | None:
        if str(url or "").startswith("data:image/"):
            return self._decode_data_url_image(url)
        raw = self._download_bytes(url)
        if raw is None:
            return None
        try:
            return Image.open(BytesIO(raw)).convert("RGB")
        except Exception:
            return None

    def _decode_data_url_image(self, data_url: str) -> Image.Image | None:
        try:
            header, encoded = data_url.split(",", 1)
            if ";base64" not in header:
                return None
            raw = base64.b64decode(encoded)
            return Image.open(BytesIO(raw)).convert("RGB")
        except Exception:
            return None

    def _fetch_image_from_array(self, arr: np.ndarray) -> Image.Image | None:
        try:
            return Image.fromarray(arr.astype("uint8"), mode="RGB")
        except Exception:
            return None

    def _predict(self, image: Image.Image) -> float:
        x = self.transform(image).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logits = self.model(x)
            probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
        # Class 1 means AI-generated after fine-tuning.
        return float(probs[1])

    def _item_reason(self, score: float) -> str:
        risk_percent = round(score * 100, 1)
        if score >= 0.75:
            return f"Flagged because the classifier found strong AI-generated image signals ({risk_percent}% risk)."
        if score >= 0.5:
            return f"Flagged because the classifier found moderate synthetic-image signals ({risk_percent}% risk)."
        return f"Not flagged because the classifier found stronger authentic-image signals ({risk_percent}% risk)."

    def analyze_items(self, urls: list[str]) -> list[dict]:
        items: list[dict] = []
        for url in urls[:10]:
            image = self._fetch_image(url)
            if image is None:
                items.append(
                    {
                        "modality": "image",
                        "source": url,
                        "preview": url,
                        "status": "failed",
                        "risk_percent": None,
                        "authenticity_percent": None,
                        "is_fake": None,
                        "summary": "Image could not be fetched for analysis.",
                        "reason": "The image could not be downloaded or decoded, so no fake-content explanation is available.",
                    }
                )
                continue

            score = self._predict(image)
            risk_percent = round(score * 100, 1)
            authenticity_percent = round((1.0 - score) * 100, 1)
            is_fake = score >= 0.5
            items.append(
                {
                    "modality": "image",
                    "source": url,
                    "preview": url,
                    "status": "analyzed",
                    "risk_percent": risk_percent,
                    "authenticity_percent": authenticity_percent,
                    "is_fake": is_fake,
                    "summary": "Likely fake/AI-generated image." if is_fake else "Likely authentic image.",
                    "reason": self._item_reason(score),
                }
            )
        return items

    def analyze(self, urls: list[str], items: list[dict] | None = None) -> tuple[float, str, list[str]]:
        if not urls:
            return 0.0, "no_images", ["No images found on page."]

        items = items if items is not None else self.analyze_items(urls)
        scores = [float(item["risk_percent"]) / 100.0 for item in items if item["status"] == "analyzed"]
        reasons: list[str] = []

        if not scores:
            return 0.0, "image_fetch_failed", ["Could not fetch/analyze images."]

        avg_score = float(sum(scores) / len(scores))
        label = "likely_ai_generated_images" if avg_score >= 0.5 else "likely_real_images"

        reasons.append(f"Analyzed {len(scores)} image(s) with CNN classifier.")
        reasons.append(f"Average AI-likelihood: {round(avg_score * 100, 1)}%.")
        reasons.append("Model uses pretrained CNN backbone and requires domain fine-tuning for best accuracy.")

        return avg_score, label, reasons
