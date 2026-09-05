from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from .models import PdfPageContext


def extract_pdf_pages(pdf_path: Path, ocr_language: str = "eng") -> list[PdfPageContext]:
    try:
        import fitz  # type: ignore

        return _extract_with_pymupdf(pdf_path, fitz, ocr_language)
    except Exception:
        return _extract_with_pypdf(pdf_path)


def _extract_with_pymupdf(pdf_path: Path, fitz_module, ocr_language: str) -> list[PdfPageContext]:
    pages: list[PdfPageContext] = []
    with fitz_module.open(pdf_path) as doc:
        for page_idx, page in enumerate(doc, start=1):
            text_layer = _clean_text(page.get_text("text") or "")
            # OCR is useful for image-only pages, but duplicating a healthy text
            # layer adds noise and makes course-library indexing much slower.
            ocr_text = _ocr_pdf_page(page, ocr_language) if len(text_layer) < 40 else ""
            combined_text = _merge_text_layers(text_layer, ocr_text)
            rect = page.rect
            pages.append(
                PdfPageContext(
                    source_path=pdf_path,
                    page_number=page_idx,
                    text_layer=text_layer,
                    ocr_text=ocr_text,
                    combined_text=combined_text,
                    width=float(rect.width),
                    height=float(rect.height),
                )
            )
    return pages


def _extract_with_pypdf(pdf_path: Path) -> list[PdfPageContext]:
    from pypdf import PdfReader  # type: ignore

    reader = PdfReader(str(pdf_path))
    pages: list[PdfPageContext] = []
    for page_idx, page in enumerate(reader.pages, start=1):
        text_layer = _clean_text(page.extract_text() or "")
        media_box = page.mediabox
        pages.append(
            PdfPageContext(
                source_path=pdf_path,
                page_number=page_idx,
                text_layer=text_layer,
                ocr_text="",
                combined_text=text_layer,
                width=float(media_box.width),
                height=float(media_box.height),
            )
        )
    return pages


def _ocr_pdf_page(page, ocr_language: str) -> str:
    if shutil.which("tesseract") is None:
        return ""

    with tempfile.TemporaryDirectory() as temp_dir:
        image_path = Path(temp_dir) / "page.png"
        pixmap = page.get_pixmap(dpi=170)
        pixmap.save(str(image_path))

        command = ["tesseract", str(image_path), "stdout", "-l", ocr_language]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            return ""

        return _clean_text(result.stdout)


def _merge_text_layers(text_layer: str, ocr_text: str) -> str:
    if text_layer and ocr_text and text_layer != ocr_text:
        return f"{text_layer}\n\n[OCR]\n{ocr_text}"
    return text_layer or ocr_text


def _clean_text(text: str) -> str:
    lines = [line.strip() for line in text.splitlines()]
    compact = "\n".join(line for line in lines if line)
    return compact.strip()
