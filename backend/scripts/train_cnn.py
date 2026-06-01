from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader
from torchvision import datasets, transforms

from app.models.image_cnn import ImageCnnDetector


def build_loaders(data_dir: Path, batch_size: int) -> tuple[DataLoader, DataLoader]:
    train_tf = transforms.Compose(
        [
            transforms.Resize((256, 256)),
            transforms.RandomResizedCrop(224),
            transforms.RandomHorizontalFlip(),
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

    train_ds = datasets.ImageFolder(data_dir / "train", transform=train_tf)
    val_ds = datasets.ImageFolder(data_dir / "val", transform=val_tf)

    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False, num_workers=2)
    return train_loader, val_loader


def evaluate(model: nn.Module, loader: DataLoader, device: str) -> float:
    model.eval()
    correct = 0
    total = 0
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            logits = model(x)
            pred = logits.argmax(dim=1)
            correct += (pred == y).sum().item()
            total += y.size(0)
    return correct / max(1, total)


def train(data_dir: Path, out_path: Path, epochs: int, batch_size: int, lr: float) -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ImageCnnDetector().to(device)

    train_loader, val_loader = build_loaders(data_dir, batch_size)

    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr)

    best_acc = 0.0
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for epoch in range(1, epochs + 1):
        model.train()
        running_loss = 0.0

        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad()
            logits = model(x)
            loss = criterion(logits, y)
            loss.backward()
            optimizer.step()
            running_loss += loss.item()

        val_acc = evaluate(model, val_loader, device)
        avg_loss = running_loss / max(1, len(train_loader))
        print(f"epoch={epoch} loss={avg_loss:.4f} val_acc={val_acc:.4f}")

        if val_acc > best_acc:
            best_acc = val_acc
            torch.save(model.state_dict(), out_path)
            print(f"saved checkpoint to {out_path} (val_acc={best_acc:.4f})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train CNN detector for AI-generated images")
    parser.add_argument("--data-dir", type=Path, required=True, help="Dataset root with train/ and val/")
    parser.add_argument("--out", type=Path, default=Path("checkpoints/image_cnn.pt"))
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=1e-4)
    args = parser.parse_args()

    train(args.data_dir, args.out, args.epochs, args.batch_size, args.lr)


if __name__ == "__main__":
    main()