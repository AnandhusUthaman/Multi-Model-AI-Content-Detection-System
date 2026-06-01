from __future__ import annotations

from app.schemas import AnalyzeRequest, AnalyzeResponse, FakeNewsResult, ItemAnalysis, ModalityScore
from app.services.fake_news_detector import FakeNewsDetector
from app.services.image_detector import ImageDetector
from app.services.text_detector import TextDetector
from app.services.video_detector import VideoDetector


class AnalyzerService:
    def __init__(self) -> None:
        self.text_detector = TextDetector()
        self.image_detector = ImageDetector(checkpoint_path=None)
        self.video_detector = VideoDetector(self.image_detector)
        self.fake_news_detector = FakeNewsDetector()

    def _analyze_video(self, video_items: list) -> tuple[float, str, list[str], list[dict]]:
        return self.video_detector.analyze(video_items)

    def analyze(self, payload: AnalyzeRequest) -> AnalyzeResponse:
        text_items_raw = self.text_detector.analyze_blocks(payload.textBlocks)
        if not text_items_raw:
            text_items_raw = self.text_detector.analyze_segments(payload.text)
        text_score, text_label, text_reasons = self.text_detector.analyze(payload.text, items=text_items_raw)
        image_items_raw = self.image_detector.analyze_items(payload.imageUrls)
        image_score, image_label, image_reasons = self.image_detector.analyze(payload.imageUrls, items=image_items_raw)
        video_inputs = payload.videos or []
        video_score, video_label, video_reasons, video_items_raw = self._analyze_video(video_inputs)
        fake_news_result: FakeNewsResult = self.fake_news_detector.analyze(payload.text)
        fake_news_score = float(fake_news_result.score)

        # Keep fake-news as text-only auxiliary signal (reported separately, not mixed into authenticity score).
        weights = {"text": 0.40, "image": 0.25, "video": 0.35}
        total_score = (
            text_score * weights["text"]
            + image_score * weights["image"]
            + video_score * weights["video"]
        )

        analyzed_video_count = len([x for x in video_items_raw if x.get("status") == "analyzed"])
        # If video detector is strongly suspicious, force suspicious overall verdict.
        if analyzed_video_count > 0 and video_score >= 0.65:
            total_score = max(total_score, 0.70)
        # Slight boost for moderate suspicious video signals.
        elif analyzed_video_count > 0 and video_score >= 0.55:
            total_score = min(1.0, total_score + 0.08)

        overall_label = "likely_fake_or_ai_generated" if total_score >= 0.5 else "likely_authentic"
        verdict_text = (
            "Overall, this page looks likely AI-generated or manipulated."
            if total_score >= 0.5
            else "Overall, this page looks mostly authentic."
        )
        reasons = [
            verdict_text,
            f"Text analysis risk: {round(text_score * 100, 1)}%",
            f"Image analysis risk: {round(image_score * 100, 1)}%",
            f"Video analysis risk: {round(video_score * 100, 1)}%",
            f"Fake-news risk (text only): {round(fake_news_score * 100, 1)}%",
            "Final authenticity score combines text, image, and video signals. Fake-news is reported separately for text claims.",
        ]

        return AnalyzeResponse(
            score=total_score,
            label=overall_label,
            reasons=reasons,
            text_result=ModalityScore(
                score=text_score,
                label=text_label,
                reasons=text_reasons,
                items=[ItemAnalysis(**item) for item in text_items_raw],
            ),
            image_result=ModalityScore(
                score=image_score,
                label=image_label,
                reasons=image_reasons,
                items=[ItemAnalysis(**item) for item in image_items_raw],
            ),
            video_result=ModalityScore(
                score=video_score,
                label=video_label,
                reasons=video_reasons,
                items=[ItemAnalysis(**item) for item in video_items_raw],
            ),
            fake_news_result=fake_news_result,
        )
