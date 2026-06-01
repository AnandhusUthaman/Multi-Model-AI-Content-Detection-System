import torch
from torch import nn
from torchvision import models


class ImageCnnDetector(nn.Module):
    """Transfer-learning CNN detector for binary classification: real vs AI-generated."""

    def __init__(self, num_classes: int = 2):
        super().__init__()
        backbone = models.resnet18(weights=models.ResNet18_Weights.DEFAULT)
        in_features = backbone.fc.in_features
        backbone.fc = nn.Linear(in_features, num_classes)
        self.model = backbone

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.model(x)


def load_model(checkpoint_path: str | None = None, device: str = "cpu") -> ImageCnnDetector:
    model = ImageCnnDetector()
    if checkpoint_path:
        state = torch.load(checkpoint_path, map_location=device)
        model.load_state_dict(state)
    model.to(device)
    model.eval()
    return model