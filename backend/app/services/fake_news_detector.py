from __future__ import annotations

import re

import requests
from transformers import pipeline

from app.schemas import FactCheckClaim, FakeNewsResult


class FakeNewsDetector:
    """Lightweight fact-check pipeline:
    1) extract candidate factual claims
    2) fetch evidence summary (Wikipedia)
    3) verify with pretrained zero-shot model
    """

    def __init__(self) -> None:
        self._verifier = pipeline(
            task="zero-shot-classification",
            model="facebook/bart-large-mnli",
        )

    def _extract_claims(self, text: str, max_claims: int = 5) -> list[str]:
        cleaned = re.sub(r"\s+", " ", (text or "")).strip()
        if len(cleaned) < 80:
            return []

        candidates = re.split(r"(?<=[.!?])\s+", cleaned)
        out: list[str] = []
        for sentence in candidates:
            s = sentence.strip()
            if len(s) < 45 or len(s) > 320:
                continue
            # Keep statements likely to contain checkable claims.
            if not re.search(r"\b(is|are|was|were|has|have|will|can|causes?|increases?|decreases?)\b", s, flags=re.I):
                continue
            out.append(s)
            if len(out) >= max_claims:
                break
        return out

    def _get_wikipedia_evidence(self, claim: str) -> tuple[str, str]:
        query = claim[:120]
        search_url = "https://en.wikipedia.org/w/api.php"
        try:
            search_resp = requests.get(
                search_url,
                params={
                    "action": "query",
                    "list": "search",
                    "srsearch": query,
                    "srlimit": 1,
                    "format": "json",
                },
                timeout=6,
            )
            search_resp.raise_for_status()
            data = search_resp.json()
            hits = data.get("query", {}).get("search", [])
            if not hits:
                return "", ""

            title = hits[0].get("title", "")
            if not title:
                return "", ""

            summary_resp = requests.get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}",
                timeout=6,
            )
            summary_resp.raise_for_status()
            summary = summary_resp.json().get("extract", "")
            source = summary_resp.json().get("content_urls", {}).get("desktop", {}).get("page", "")
            return summary or "", source or ""
        except Exception:
            return "", ""

    def _verify(self, claim: str, evidence: str) -> tuple[str, float]:
        if not evidence:
            return "not_enough_evidence", 0.0

        text = f"Claim: {claim}\nEvidence: {evidence[:1400]}"
        labels = ["supported by evidence", "contradicted by evidence", "not enough evidence"]
        result = self._verifier(text, candidate_labels=labels, multi_label=False)
        top_label = str(result["labels"][0]).lower()
        conf = float(result["scores"][0])

        if "contradicted" in top_label:
            return "likely_false", conf
        if "supported" in top_label:
            return "likely_true", conf
        return "not_enough_evidence", conf

    def analyze(self, text: str) -> FakeNewsResult:
        claims = self._extract_claims(text)
        if not claims:
            return FakeNewsResult(
                score=0.0,
                label="insufficient_claims",
                reasons=["Not enough factual claims for fact-checking."],
                claims=[],
            )

        checked: list[FactCheckClaim] = []
        risks: list[float] = []

        for claim in claims:
            evidence, source = self._get_wikipedia_evidence(claim)
            verdict, conf = self._verify(claim, evidence)

            if verdict == "likely_false":
                risk = min(1.0, 0.55 + 0.45 * conf)
            elif verdict == "likely_true":
                risk = max(0.0, 0.30 - 0.25 * conf)
            else:
                risk = 0.50

            risks.append(risk)
            checked.append(
                FactCheckClaim(
                    claim=claim,
                    verdict=verdict,
                    confidence=round(conf, 4),
                    evidence=evidence[:500],
                    source=source,
                )
            )

        avg_risk = float(sum(risks) / len(risks))
        if avg_risk >= 0.6:
            label = "likely_fake_news"
        elif avg_risk >= 0.4:
            label = "mixed_or_uncertain_claims"
        else:
            label = "likely_supported_claims"

        reasons = [
            f"Fact-checked {len(checked)} claim(s) with external evidence retrieval.",
            f"Average fake-news risk: {round(avg_risk * 100, 1)}%.",
        ]
        return FakeNewsResult(score=avg_risk, label=label, reasons=reasons, claims=checked)
