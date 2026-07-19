from __future__ import annotations

import unittest
from pathlib import Path

from src.models import PdfPageContext
from src.retrieval import rank_pdf_pages


class RetrievalTests(unittest.TestCase):
    def test_prefers_chronological_pages_from_relevant_slide_deck(self) -> None:
        deck = Path("/course/Lecture_Containers.pdf")
        book = Path("/course/reference_book.pdf")
        pages = [
            PdfPageContext(deck, 1, "", "", "alpha containers namespaces", 1280, 720),
            PdfPageContext(deck, 2, "", "", "beta docker images layers", 1280, 720),
            PdfPageContext(deck, 3, "", "", "gamma kubernetes orchestration", 1280, 720),
            PdfPageContext(
                book,
                50,
                "",
                "",
                "alpha beta gamma containers docker kubernetes reference",
                600,
                900,
            ),
        ]
        transcript = " ".join(
            ["alpha containers namespaces"] * 100
            + ["beta docker images layers"] * 100
            + ["gamma kubernetes orchestration"] * 100
        )

        matches = rank_pdf_pages(transcript, pages, top_k=4)

        self.assertGreaterEqual(len(matches), 3)
        self.assertTrue(all(match.chunk.source_path == deck for match in matches[:3]))
        self.assertEqual(
            [match.chunk.page_number for match in matches[:3]],
            [1, 2, 3],
        )


if __name__ == "__main__":
    unittest.main()
