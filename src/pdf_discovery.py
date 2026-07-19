from __future__ import annotations

from pathlib import Path


def find_pdf_files(materials_root: Path) -> list[Path]:
    if not materials_root.exists() or not materials_root.is_dir():
        raise ValueError(f"Invalid materials folder: {materials_root}")

    pdfs: list[Path] = []
    for path in materials_root.rglob("*"):
        if path.is_file() and path.suffix.lower() == ".pdf":
            pdfs.append(path)
    return sorted(pdfs)
