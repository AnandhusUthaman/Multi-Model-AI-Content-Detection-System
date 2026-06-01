# AI Fake Content Detector Extension + Backend

This project includes:
- A Chrome extension with a toggle and manual scan button.
- A FastAPI backend that analyzes text, images, and videos.
- A CNN model definition (pretrained ResNet backbone) and a training script for fine-tuning.
- A video model definition using pretrained CNN backbone + LSTM for temporal learning.
- A fake-news detection pipeline for text claims (claim extraction + evidence retrieval + verification).

## 1) Run backend

Recommended Python: `3.11` or `3.12` (64-bit).

```bash
cd backend
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# only for installation after installation you skip this step
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
# running backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

API endpoint: `POST http://localhost:8000/analyze`

## 2) Load extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Open any webpage.
5. Click extension icon, turn on toggle, then press **Scan Current Page**.

## 3) CNN training (recommended)

Expected dataset layout:

```text
my_dataset/
  train/
    real/
    ai/
  val/
    real/
    ai/
```

Train and save checkpoint:

```bash
cd backend
python scripts/train_cnn.py --data-dir /path/to/my_dataset --out checkpoints/image_cnn.pt --epochs 8
```

Then modify `backend/app/services/analyzer.py` to initialize with checkpoint:

```python
self.image_detector = ImageDetector(checkpoint_path="checkpoints/image_cnn.pt")
```

## 4) Video model training (EfficientNet-B0 + LSTM)

Expected dataset layout:

```text
video_dataset/
  train/
    real/
    ai/
  val/
    real/
    ai/
```

Train with EfficientNet-B0 backbone and 20 frames per video:

```bash
cd backend
python scripts/train_video_cnn_lstm.py --data-dir /path/to/video_dataset --out checkpoints/video_cnn_lstm.pt --backbone efficientnet_b0 --num-frames 20 --epochs 8
```

Alternative backbone:

```bash
python scripts/train_video_cnn_lstm.py --data-dir /path/to/video_dataset --out checkpoints/video_resnet50_lstm.pt --backbone resnet50 --num-frames 20 --epochs 8
```

## Notes
- Text detection uses  `roberta-base-openai-detector`.
- Image detection uses a CNN architecture with ResNet weights, then fine-tuning.
- Fake-news detection uses  Wikipedia evidence retrieval.
- Video analysis now saves downloaded files with the detected URL suffix (`.webm`, `.mp4`, etc.) to improve decoder compatibility.
- Video analysis is strict: only direct video stream URLs are analyzed as video (image URLs are not used as video fallbacks).
- If a direct video stream cannot be decoded, backend applies a neutral fallback score instead of hard-failing.
- Accuracy depends on your training data quality and distribution.
