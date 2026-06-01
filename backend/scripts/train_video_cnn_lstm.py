from __future__ import annotations

import argparse
import random
from pathlib import Path

import cv2
import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms

from app.models.video_cnn_lstm import VideoCnnLstmDetector


VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}


class VideoFolderDataset(Dataset):
    """
    Expected layout:
      root/
        real/
        ai/
    """

    def __init__(self, root: Path, num_frames: int, transform: transforms.Compose):
        self.root = root
        self.num_frames = num_frames
        self.transform = transform
        self.samples: list[tuple[Path, int]] = []
        self._load_samples()

    def _load_samples(self) -> None:
        for label_name, label in [("real", 0), ("ai", 1)]:
            folder = self.root / label_name
            if not folder.exists():
                continue
            for p in folder.rglob("*"):
                if p.suffix.lower() in VIDEO_EXTS:
                    self.samples.append((p, label))

        if not self.samples:
            raise ValueError(f"No videos found under {self.root} (expected real/ and ai/ folders)")

    def __len__(self) -> int:
        return len(self.samples)

    def _sample_indices(self, total_frames: int) -> list[int]:
        if total_frames <= 0:
            return [0] * self.num_frames
        if total_frames < self.num_frames:
            idx = list(range(total_frames))
            idx.extend([total_frames - 1] * (self.num_frames - total_frames))
            return idx
        step = (total_frames - 1) / float(self.num_frames - 1)
        return [int(round(i * step)) for i in range(self.num_frames)]

    def _read_frames(self, video_path: Path) -> torch.Tensor:
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError("Cannot open video")

        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        indices = self._sample_indices(total)
        frames: list[torch.Tensor] = []

        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                if frames:
                    frames.append(frames[-1].clone())
                    continue
                cap.release()
                raise RuntimeError("Cannot decode frame")

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil = Image.fromarray(rgb)
            frames.append(self.transform(pil))

        cap.release()
        return torch.stack(frames, dim=0)  # [T, C, H, W]

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        video_path, label = self.samples[index]
        try:
            x = self._read_frames(video_path)
        except Exception:
            # Robust fallback to another sample to keep training moving.
            alt_idx = random.randint(0, len(self.samples) - 1)
            video_path, label = self.samples[alt_idx]
            x = self._read_frames(video_path)
        y = torch.tensor(float(label), dtype=torch.float32)
        return x, y


def create_loaders(data_dir: Path, num_frames: int, batch_size: int) -> tuple[DataLoader, DataLoader]:
    train_tf = transforms.Compose(
        [
            transforms.Resize((256, 256)),
            transforms.RandomResizedCrop(224),
            transforms.RandomHorizontalFlip(),
            transforms.ColorJitter(brightness=0.15, contrast=0.15, saturation=0.1),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    val_tf = transforms.Compose(
        [
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )

    train_ds = VideoFolderDataset(data_dir / "train", num_frames=num_frames, transform=train_tf)
    val_ds = VideoFolderDataset(data_dir / "val", num_frames=num_frames, transform=val_tf)

    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=2, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False, num_workers=2, pin_memory=True)
    return train_loader, val_loader


def evaluate(model: nn.Module, loader: DataLoader, criterion: nn.Module, device: str) -> tuple[float, float]:
    model.eval()
    loss_sum = 0.0
    correct = 0
    total = 0

    with torch.no_grad():
        for x, y in loader:
            x = x.to(device)  # [B, T, C, H, W]
            y = y.to(device)
            logits = model(x)
            loss = criterion(logits, y)
            loss_sum += loss.item()

            pred = (torch.sigmoid(logits) >= 0.5).float()
            correct += (pred == y).sum().item()
            total += y.numel()

    avg_loss = loss_sum / max(1, len(loader))
    acc = correct / max(1, total)
    return avg_loss, acc


def train(
    data_dir: Path,
    out_path: Path,
    backbone: str,
    num_frames: int,
    epochs: int,
    batch_size: int,
    lr: float,
    lstm_hidden: int,
    lstm_layers: int,
    freeze_backbone: bool,
) -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    train_loader, val_loader = create_loaders(data_dir, num_frames, batch_size)

    model = VideoCnnLstmDetector(
        backbone=backbone,
        lstm_hidden_size=lstm_hidden,
        lstm_layers=lstm_layers,
        dropout=0.2,
        freeze_backbone=freeze_backbone,
    ).to(device)

    criterion = nn.BCEWithLogitsLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    best_val_acc = 0.0
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for epoch in range(1, epochs + 1):
        model.train()
        running_loss = 0.0

        for x, y in train_loader:
            x = x.to(device)
            y = y.to(device)
            optimizer.zero_grad()
            logits = model(x)
            loss = criterion(logits, y)
            loss.backward()
            optimizer.step()
            running_loss += loss.item()

        train_loss = running_loss / max(1, len(train_loader))
        val_loss, val_acc = evaluate(model, val_loader, criterion, device)
        print(
            f"epoch={epoch} train_loss={train_loss:.4f} val_loss={val_loss:.4f} val_acc={val_acc:.4f}"
        )

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            payload = {
                "state_dict": model.state_dict(),
                "backbone": backbone,
                "num_frames": num_frames,
                "lstm_hidden": lstm_hidden,
                "lstm_layers": lstm_layers,
            }
            torch.save(payload, out_path)
            print(f"saved best checkpoint: {out_path} (val_acc={best_val_acc:.4f})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train EfficientNet/ResNet + LSTM for AI video detection")
    parser.add_argument("--data-dir", type=Path, required=True, help="Root with train/ and val/ folders")
    parser.add_argument("--out", type=Path, default=Path("checkpoints/video_cnn_lstm.pt"))
    parser.add_argument("--backbone", type=str, default="efficientnet_b0", choices=["efficientnet_b0", "resnet50"])
    parser.add_argument("--num-frames", type=int, default=20)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--lstm-hidden", type=int, default=256)
    parser.add_argument("--lstm-layers", type=int, default=1)
    parser.add_argument("--freeze-backbone", action="store_true")
    args = parser.parse_args()

    train(
        data_dir=args.data_dir,
        out_path=args.out,
        backbone=args.backbone,
        num_frames=args.num_frames,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        lstm_hidden=args.lstm_hidden,
        lstm_layers=args.lstm_layers,
        freeze_backbone=args.freeze_backbone,
    )


if __name__ == "__main__":
    main()
