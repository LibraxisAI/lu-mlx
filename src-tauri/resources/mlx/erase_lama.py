"""Local LaMa TorchScript object-removal helper for LU (macOS).

Uses only stdlib + numpy + Pillow + torch from the existing MLX/mflux Python
environments so no extra pip packages need to be installed.

Example:
  python erase_lama.py --model big-lama.pt --image in.png --mask mask.png --out out.png
"""

from __future__ import annotations

import argparse
import json
import os
import sys

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np  # noqa: E402
from PIL import Image, ImageFilter, ImageOps  # noqa: E402
import torch  # noqa: E402


def _pad_dims(h: int, w: int, modulo: int = 8) -> tuple[int, int]:
    pad_h = (modulo - (h % modulo)) % modulo
    pad_w = (modulo - (w % modulo)) % modulo
    return pad_h, pad_w


def _prepare_tensors(
    image: Image.Image, mask_l: Image.Image
) -> tuple[torch.Tensor, torch.Tensor, np.ndarray, np.ndarray]:
    img_np = np.asarray(image, dtype=np.float32) / 255.0
    # Slight dilation catches brush halo pixels cleanly before Fourier convs.
    dilated = mask_l.filter(ImageFilter.MaxFilter(5))
    dilated_np = (np.asarray(dilated, dtype=np.float32) > 127.0).astype(np.float32)

    h, w = dilated_np.shape
    pad_h, pad_w = _pad_dims(h, w, 8)
    # Use edge mode so tiny test fixtures (< 8 px) pad safely without ValueError.
    mode = "reflect" if (h > pad_h and w > pad_w) else "edge"
    if pad_h or pad_w:
        img_pad = np.pad(img_np, ((0, pad_h), (0, pad_w), (0, 0)), mode=mode)
        mask_pad = np.pad(dilated_np, ((0, pad_h), (0, pad_w)), mode=mode)
    else:
        img_pad = img_np
        mask_pad = dilated_np

    img_t = torch.from_numpy(img_pad).permute(2, 0, 1).unsqueeze(0).contiguous()
    mask_t = torch.from_numpy(mask_pad).unsqueeze(0).unsqueeze(0).contiguous()
    return img_t, mask_t, img_np, dilated


def _run_lama(
    model_path: str, img_t: torch.Tensor, mask_t: torch.Tensor
) -> tuple[torch.Tensor, str]:
    devices: list[str] = []
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        devices.append("mps")
    devices.append("cpu")

    last_err: Exception | None = None
    for dev in devices:
        try:
            model = torch.jit.load(model_path, map_location=dev)
            model.eval()
            with torch.inference_mode():
                out = model(img_t.to(dev), mask_t.to(dev))
            return out.detach().to("cpu"), dev
        except Exception as exc:  # noqa: BLE001 - fall back from MPS to CPU cleanly
            last_err = exc
    raise RuntimeError(f"LaMa inference failed: {last_err}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove masked objects with LaMa.")
    parser.add_argument("--model", required=True, help="Path to TorchScript big-lama.pt")
    parser.add_argument("--image", required=True, help="Input RGB image path")
    parser.add_argument("--mask", required=True, help="Input mask path (white = remove)")
    parser.add_argument("--out", required=True, help="Output PNG path")
    parser.add_argument("--feather", type=int, default=6, help="Blend feather radius in px")
    args = parser.parse_args()

    img = ImageOps.exif_transpose(Image.open(args.image)).convert("RGB")
    mask = ImageOps.exif_transpose(Image.open(args.mask)).convert("L")
    if mask.size != img.size:
        resampling = getattr(Image, "Resampling", Image).BILINEAR
        mask = mask.resize(img.size, resampling)

    w, h = img.size
    img_t, mask_t, orig_np, dilated_mask = _prepare_tensors(img, mask)
    out_t, device_used = _run_lama(args.model, img_t, mask_t)

    pred = out_t[0, :, :h, :w].permute(1, 2, 0).numpy()
    # TorchScript big-lama returns pixels in [0, 255]. Guard normalized outputs too.
    if pred.max() <= 2.0:
        pred = pred * 255.0
    pred = np.clip(pred, 0.0, 255.0)

    feather = max(0, min(64, int(args.feather)))
    blend_img = dilated_mask.filter(ImageFilter.GaussianBlur(feather)) if feather > 0 else dilated_mask
    alpha = np.asarray(blend_img, dtype=np.float32)[..., None] / 255.0
    # Guarantee unmasked pixels remain bit-for-bit preserved outside blurred edge.
    orig_u8 = np.asarray(img, dtype=np.float32)
    merged = np.clip(orig_u8 * (1.0 - alpha) + pred * alpha, 0.0, 255.0).round().astype(np.uint8)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    Image.fromarray(merged, mode="RGB").save(args.out, format="PNG")
    print(json.dumps({"width": w, "height": h, "device": device_used}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
