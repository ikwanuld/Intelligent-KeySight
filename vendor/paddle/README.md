# Text models for the pallet reader

| File | What it is | Size |
|---|---|---|
| `det.onnx` | PP-OCRv6 small text detector (finds lines of text) | 5.0 MB |
| `rec.onnx` | PP-OCRv6 small text recogniser (reads one line) | 10.6 MB |
| `dict.txt` | character list of the recogniser, one per output class | 75 KB |

Source: PaddleOCR (https://github.com/PaddlePaddle/PaddleOCR), Apache-2.0,
see `LICENSE-PaddleOCR.txt`. ONNX conversions taken from
https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models
(`detection/PP-OCRv6_small_det.onnx`, `recognition/PP-OCRv6_small_rec.onnx`,
`recognition/ppocrv6_dict.txt`).

One change was made to the two model files: their weights are stored as
16-bit floats instead of 32-bit, which halves the download. The models still
compute in 32-bit and gave the same text on every reference photo. To redo it
from the original files:

    pip install onnx numpy
    python3 tools/half_weights.py PP-OCRv6_small_det.onnx vendor/paddle/det.onnx
    python3 tools/half_weights.py PP-OCRv6_small_rec.onnx vendor/paddle/rec.onnx

To try another model, replace the files (keep the names), bump
`MODEL_VERSION` in `js/pallet/assets.js`, and run `node tests/pallet-eval.mjs`.
