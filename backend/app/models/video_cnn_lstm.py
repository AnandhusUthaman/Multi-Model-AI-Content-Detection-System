from __future__ import annotations

import torch
from torch import nn
from torchvision import models


class VideoCnnLstmDetector(nn.Module):
    """Video detector: CNN backbone per-frame + LSTM temporal head."""

    def __init__(
        self,
        backbone: str = "efficientnet_b0",
        lstm_hidden_size: int = 256,
        lstm_layers: int = 1,
        dropout: float = 0.2,
        freeze_backbone: bool = False,
    ) -> None:
        super().__init__()
        self.backbone_name = backbone
        self.feature_extractor, feature_dim = self._build_backbone(backbone)
        self.lstm = nn.LSTM(
            input_size=feature_dim,
            hidden_size=lstm_hidden_size,
            num_layers=lstm_layers,
            batch_first=True,
            dropout=dropout if lstm_layers > 1 else 0.0,
        )
        self.dropout = nn.Dropout(dropout)
        self.fc = nn.Linear(lstm_hidden_size, 1)

        if freeze_backbone:
            for p in self.feature_extractor.parameters():
                p.requires_grad = False

    def _build_backbone(self, backbone: str) -> tuple[nn.Module, int]:
        if backbone == "efficientnet_b0":
            cnn = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
            feature_dim = 1280
            cnn.classifier = nn.Identity()
            return cnn, feature_dim

        if backbone == "resnet50":
            cnn = models.resnet50(weights=models.ResNet50_Weights.DEFAULT)
            feature_dim = cnn.fc.in_features
            cnn.fc = nn.Identity()
            return cnn, feature_dim

        raise ValueError(f"Unsupported backbone: {backbone}")

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        x shape: [B, T, C, H, W]
        returns logits: [B]
        """
        b, t, c, h, w = x.shape
        x = x.view(b * t, c, h, w)
        feats = self.feature_extractor(x)
        feats = feats.view(b, t, -1)
        lstm_out, _ = self.lstm(feats)
        last = lstm_out[:, -1, :]
        logits = self.fc(self.dropout(last)).squeeze(1)
        return logits


def load_video_model(
    checkpoint_path: str | None = None,
    device: str = "cpu",
    backbone: str = "efficientnet_b0",
    lstm_hidden_size: int = 256,
    lstm_layers: int = 1,
    dropout: float = 0.2,
) -> VideoCnnLstmDetector:
    model = VideoCnnLstmDetector(
        backbone=backbone,
        lstm_hidden_size=lstm_hidden_size,
        lstm_layers=lstm_layers,
        dropout=dropout,
    )
    if checkpoint_path:
        payload = torch.load(checkpoint_path, map_location=device)
        state = payload["state_dict"] if isinstance(payload, dict) and "state_dict" in payload else payload
        model.load_state_dict(state)
    model.to(device)
    model.eval()
    return model
