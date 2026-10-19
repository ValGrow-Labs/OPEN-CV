"""Download the pretrained MediaPipe Hand Landmarker model to models/hand_landmarker.task.

Usage (from backend/):  python -m scripts.download_models
"""

from __future__ import annotations

import hashlib
import urllib.request

from glovesize.config import REPO_ROOT

URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"


def main() -> None:
    dest = REPO_ROOT / "models" / "hand_landmarker.task"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        print(f"downloading {URL}")
        urllib.request.urlretrieve(URL, dest)  # noqa: S310 - fixed https URL
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != SHA256:
        raise SystemExit(f"checksum mismatch for {dest}: {digest}")
    print(f"{dest} OK (sha256 verified)")


if __name__ == "__main__":
    main()
