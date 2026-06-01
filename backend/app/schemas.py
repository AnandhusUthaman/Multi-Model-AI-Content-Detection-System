from pydantic import BaseModel, Field


class ImageItem(BaseModel):
    src: str = ""
    alt: str = ""
    width: int = 0
    height: int = 0


class VideoItem(BaseModel):
    src: str = ""
    poster: str = ""
    duration: float = 0
    width: int = 0
    height: int = 0
    selector: str = ""
    elementId: str = ""
    analysisUrl: str = ""


class AnalyzeRequest(BaseModel):
    url: str = ""
    title: str = ""
    text: str = ""
    images: list[ImageItem] = Field(default_factory=list)
    videos: list[VideoItem] = Field(default_factory=list)
    imageUrls: list[str] = Field(default_factory=list)
    videoUrls: list[str] = Field(default_factory=list)
    textBlocks: list[dict] = Field(default_factory=list)


class ItemAnalysis(BaseModel):
    modality: str = ""
    source: str
    preview: str = ""
    status: str = "analyzed"
    risk_percent: float | None = None
    authenticity_percent: float | None = None
    is_fake: bool | None = None
    summary: str = ""
    reason: str = ""


class ModalityScore(BaseModel):
    score: float
    label: str
    reasons: list[str] = Field(default_factory=list)
    items: list[ItemAnalysis] = Field(default_factory=list)


class FactCheckClaim(BaseModel):
    claim: str
    verdict: str
    confidence: float
    evidence: str = ""
    source: str = ""


class FakeNewsResult(BaseModel):
    score: float
    label: str
    reasons: list[str] = Field(default_factory=list)
    claims: list[FactCheckClaim] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    score: float
    label: str
    reasons: list[str] = Field(default_factory=list)
    text_result: ModalityScore
    image_result: ModalityScore
    video_result: ModalityScore
    fake_news_result: FakeNewsResult
