from __future__ import annotations

import tempfile
from urllib.parse import urlparse

import cv2

from app.services.image_detector import ImageDetector


class VideoDetector:
    def __init__(self, image_detector: ImageDetector) -> None:
        self.image_detector = image_detector

    def _sample_frames(self, video_path: str, max_frames: int = 8) -> list[float]:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return []

        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if frame_count <= 0:
            cap.release()
            return []

        steps = max(1, frame_count // max_frames)
        scores: list[float] = []
        idx = 0

        while len(scores) < max_frames:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                break

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img = self.image_detector._fetch_image_from_array(rgb) if hasattr(self.image_detector, "_fetch_image_from_array") else None
            if pil_img is not None:
                scores.append(self.image_detector._predict(pil_img))

            idx += steps
            if idx >= frame_count:
                break

        cap.release()
        return scores

    def _is_probably_video_url(self, url: str) -> bool:
        lowered = (url or "").lower()
        return any(ext in lowered for ext in [".mp4", ".mov", ".webm", ".mkv", ".avi"])

    def _guess_temp_suffix(self, url: str) -> str:
        try:
            path = urlparse(url).path.lower()
        except Exception:
            path = str(url or "").lower()

        for ext in [".mp4", ".mov", ".webm", ".mkv", ".avi"]:
            if path.endswith(ext):
                return ext
        return ".mp4"

    def _neutral_video_fallback(self) -> tuple[float, str]:
        return 0.49, "Video stream could not be decoded; assigned neutral fallback score."

    def _item_reason(self, score: float, frame_count: int) -> str:
        risk_percent = round(score * 100, 1)
        if score >= 0.75:
            return f"Flagged because {frame_count} sampled frame(s) showed strong AI-generated visual patterns ({risk_percent}% risk)."
        if score >= 0.5:
            return f"Flagged because sampled video frames showed moderate synthetic visual signals ({risk_percent}% risk)."
        return f"Not flagged because sampled video frames looked more authentic overall ({risk_percent}% risk)."

    def _candidate_priority(self, video) -> tuple[int, int]:
        analysis_url = str(getattr(video, "analysisUrl", "") or "").lower()
        src = str(getattr(video, "src", "") or "").lower()
        has_direct = int(self._is_probably_video_url(analysis_url) or self._is_probably_video_url(src))
        has_any = int(bool(analysis_url or src))
        return (has_direct, has_any)

    def analyze_items(self, video_items: list) -> tuple[list[dict], list[float]]:
        items_out: list[dict] = []
        scores: list[float] = []

        prioritized = sorted(video_items, key=self._candidate_priority, reverse=True)
        for video in prioritized[:12]:
            analysis_url = str(getattr(video, "analysisUrl", "") or getattr(video, "src", "")).strip()
            source = str(getattr(video, "elementId", "") or analysis_url or "video_item")
            preview = str(analysis_url or getattr(video, "src", "")).strip()

            if not analysis_url:
                items_out.append(
                    {
                        "modality": "video",
                        "source": source,
                        "preview": preview,
                        "status": "failed",
                        "risk_percent": None,
                        "authenticity_percent": None,
                        "is_fake": None,
                        "summary": "No usable URL found for video analysis.",
                        "reason": "The video item had no direct source URL, so it could not be analyzed.",
                    }
                )
                continue

            # Strict mode: only direct video streams are analyzed as video.
            if not self._is_probably_video_url(analysis_url):
                items_out.append(
                    {
                        "modality": "video",
                        "source": source,
                        "preview": preview,
                        "status": "failed",
                        "risk_percent": None,
                        "authenticity_percent": None,
                        "is_fake": None,
                        "summary": "Skipped: URL is not a direct video stream.",
                        "reason": "This item was skipped because the detected URL is not a direct video file.",
                    }
                )
                continue

            # Direct video URL path: download + sample frames.
            try:
                suffix = self._guess_temp_suffix(analysis_url)
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
                    data = self.image_detector._download_bytes(analysis_url, timeout=20)
                    if not data:
                        neutral_score, neutral_summary = self._neutral_video_fallback()
                        scores.append(neutral_score)
                        items_out.append(
                            {
                                "modality": "video",
                                "source": source,
                                "preview": preview,
                                "status": "analyzed",
                                "risk_percent": round(neutral_score * 100, 1),
                                "authenticity_percent": round((1.0 - neutral_score) * 100, 1),
                                "is_fake": neutral_score >= 0.5,
                                "summary": f"Video download failed or timed out. {neutral_summary}",
                                "reason": "The video could not be downloaded reliably, so no strong fake-content conclusion was made.",
                            }
                        )
                        continue
                    tmp.write(data)
                    tmp.flush()
                    frame_scores = self._sample_frames(tmp.name)
                    if not frame_scores:
                        neutral_score, neutral_summary = self._neutral_video_fallback()
                        scores.append(neutral_score)
                        items_out.append(
                            {
                                "modality": "video",
                                "source": source,
                                "preview": preview,
                                "status": "analyzed",
                                "risk_percent": round(neutral_score * 100, 1),
                                "authenticity_percent": round((1.0 - neutral_score) * 100, 1),
                                "is_fake": neutral_score >= 0.5,
                                "summary": f"Video downloaded but frame decoding failed. {neutral_summary}",
                                "reason": "The video frames could not be decoded, so no strong fake-content conclusion was made.",
                            }
                        )
                        continue

                    avg_item_score = float(sum(frame_scores) / len(frame_scores))
                    scores.extend(frame_scores)
                    items_out.append(
                        {
                            "modality": "video",
                            "source": source,
                            "preview": preview,
                            "status": "analyzed",
                            "risk_percent": round(avg_item_score * 100, 1),
                            "authenticity_percent": round((1.0 - avg_item_score) * 100, 1),
                            "is_fake": avg_item_score >= 0.5,
                            "summary": f"Analyzed {len(frame_scores)} sampled frame(s) from video stream.",
                            "reason": self._item_reason(avg_item_score, len(frame_scores)),
                        }
                    )
            except Exception:
                items_out.append(
                    {
                        "modality": "video",
                        "source": source,
                        "preview": preview,
                        "status": "failed",
                        "risk_percent": None,
                        "authenticity_percent": None,
                        "is_fake": None,
                        "summary": "Unexpected error while processing video.",
                        "reason": "An unexpected processing error prevented a fake-content explanation for this video.",
                    }
                )
                continue

        return items_out, scores

    def analyze(self, video_items: list) -> tuple[float, str, list[str], list[dict]]:
        if not video_items:
            return 0.0, "no_videos", ["No videos found on page."], []

        item_results, scores = self.analyze_items(video_items)
        if not scores:
            return 0.0, "video_analysis_failed", ["No videos could be analyzed (download/decode/preview failure)."], item_results

        avg_score = float(sum(scores) / len(scores))
        label = "likely_ai_generated_video" if avg_score >= 0.5 else "likely_real_video"
        analyzed_count = len([x for x in item_results if x.get("status") == "analyzed"])
        failed_count = len(item_results) - analyzed_count

        reasons = [
            f"Analyzed {analyzed_count} video item(s); {failed_count} failed.",
            f"Average video AI-likelihood: {round(avg_score * 100, 1)}%.",
        ]

        return avg_score, label, reasons, item_results
