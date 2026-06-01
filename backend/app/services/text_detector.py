from transformers import pipeline


class TextDetector:
    def __init__(self) -> None:
        # Pretrained detector trained to identify machine-generated text.
        self._clf = pipeline(
            task="text-classification",
            model="roberta-base-openai-detector",
            tokenizer="roberta-base-openai-detector",
            truncation=True,
            max_length=512,
        )

    def _predict_ai_score(self, text: str) -> float:
        prediction = self._clf(text[:3000])[0]
        label = str(prediction["label"]).lower()
        score = float(prediction["score"])
        return score if "fake" in label or "generated" in label else (1.0 - score)

    def _chunk_text(self, text: str, chunk_size: int = 600) -> list[str]:
        chunks: list[str] = []
        cleaned = " ".join((text or "").split())
        if not cleaned:
            return chunks

        for i in range(0, len(cleaned), chunk_size):
            chunk = cleaned[i : i + chunk_size].strip()
            if len(chunk) >= 50:
                chunks.append(chunk)
        return chunks[:12]

    def _item_reason(self, ai_score: float) -> str:
        risk_percent = round(ai_score * 100, 1)
        if ai_score >= 0.75:
            return f"Flagged because the writing pattern is highly consistent with machine-generated text ({risk_percent}% risk)."
        if ai_score >= 0.5:
            return f"Flagged because the writing shows mixed signals with moderate AI-generation likelihood ({risk_percent}% risk)."
        return f"Not flagged because the writing shows more human-like variation ({risk_percent}% risk)."

    def analyze_blocks(self, blocks: list[dict]) -> list[dict]:
        usable_blocks = [b for b in blocks[:20] if len(str(b.get("text", "")).strip()) >= 50]
        if not usable_blocks:
            return []

        items: list[dict] = []
        for idx, block in enumerate(usable_blocks, start=1):
            content = str(block.get("text", "")).strip()
            ai_score = self._predict_ai_score(content)
            risk_percent = round(ai_score * 100, 1)
            authenticity_percent = round((1.0 - ai_score) * 100, 1)
            is_fake = ai_score >= 0.5
            items.append(
                {
                    "modality": "text",
                    "source": str(block.get("elementId") or block.get("selector") or f"segment_{idx}"),
                    "preview": str(block.get("preview") or content[:140]),
                    "status": "analyzed",
                    "risk_percent": risk_percent,
                    "authenticity_percent": authenticity_percent,
                    "is_fake": is_fake,
                    "summary": "Likely fake/AI-written text." if is_fake else "Likely authentic human-written text.",
                    "reason": self._item_reason(ai_score),
                }
            )
        return items

    def analyze_segments(self, text: str) -> list[dict]:
        chunks = self._chunk_text(text)
        if not chunks:
            return [
                {
                    "modality": "text",
                    "source": "segment_1",
                    "preview": "",
                    "status": "insufficient_text",
                    "risk_percent": 0.0,
                    "authenticity_percent": 100.0,
                    "is_fake": False,
                    "summary": "Not enough text to evaluate.",
                    "reason": "Not enough text was available to produce a reliable text-authenticity assessment.",
                }
            ]

        items: list[dict] = []
        for idx, chunk in enumerate(chunks, start=1):
            ai_score = self._predict_ai_score(chunk)
            risk_percent = round(ai_score * 100, 1)
            authenticity_percent = round((1.0 - ai_score) * 100, 1)
            is_fake = ai_score >= 0.5
            items.append(
                {
                    "modality": "text",
                    "source": f"segment_{idx}",
                    "preview": chunk[:140],
                    "status": "analyzed",
                    "risk_percent": risk_percent,
                    "authenticity_percent": authenticity_percent,
                    "is_fake": is_fake,
                    "summary": "Likely fake/AI-written text." if is_fake else "Likely authentic human-written text.",
                    "reason": self._item_reason(ai_score),
                }
            )
        return items

    def analyze(self, text: str, items: list[dict] | None = None) -> tuple[float, str, list[str]]:
        items = items if items is not None else self.analyze_segments(text)
        analyzed_scores = [float(item["risk_percent"]) / 100.0 for item in items if item["status"] == "analyzed"]
        if not analyzed_scores:
            return 0.0, "insufficient_text", ["Not enough text to evaluate."]

        ai_score = float(sum(analyzed_scores) / len(analyzed_scores))

        reasons = [
            f"Analyzed {len(analyzed_scores)} text segment(s).",
            f"Average text risk: {round(ai_score * 100, 1)}%.",
        ]

        if ai_score > 0.75:
            reasons.append("Language pattern is highly consistent with machine-generated text.")
        elif ai_score > 0.5:
            reasons.append("Detected mixed signals with moderate machine-generation likelihood.")
        else:
            reasons.append("Detected more human-like variation in writing style.")

        final_label = "likely_ai_generated_text" if ai_score >= 0.5 else "likely_human_text"
        return ai_score, final_label, reasons
