from __future__ import annotations

import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from .models import PdfChunk, PdfPageContext, RetrievalMatch
from .pdf_extract import extract_pdf_pages


def build_pdf_chunks(pdf_files: list[Path], chunk_size_words: int = 220, overlap_words: int = 40) -> list[PdfChunk]:
    chunks: list[PdfChunk] = []

    for pdf in pdf_files:
        pages = extract_pdf_pages(pdf)
        for page in pages:
            page_chunks = _chunk_text(page.combined_text, chunk_size_words, overlap_words)
            for idx, chunk_text in enumerate(page_chunks):
                chunks.append(
                    PdfChunk(
                        source_path=pdf,
                        page_number=page.page_number,
                        chunk_index=idx,
                        text=chunk_text,
                    )
                )

    return chunks


def build_pdf_page_contexts(pdf_files: list[Path]) -> list[PdfPageContext]:
    contexts: list[PdfPageContext] = []
    for pdf in pdf_files:
        contexts.extend(extract_pdf_pages(pdf))
    return contexts


def rank_pdf_pages(query_text: str, pages: list[PdfPageContext], top_k: int) -> list[RetrievalMatch]:
    if not pages or top_k <= 0:
        return []
    if not query_text.strip():
        return []

    corpus_texts = [page.combined_text for page in pages]
    if not any(text.strip() for text in corpus_texts):
        return []
    query_windows = _split_query_text(query_text)
    vectorizer = TfidfVectorizer(
        lowercase=True,
        stop_words=None,
        ngram_range=(1, 2),
        min_df=1,
        max_df=0.98,
        sublinear_tf=True,
    )

    try:
        matrix = vectorizer.fit_transform(corpus_texts + query_windows)
    except ValueError:
        return []
    page_matrix = matrix[: len(pages)]
    query_matrix = matrix[len(pages) :]
    score_matrix = cosine_similarity(page_matrix, query_matrix)

    file_indices: dict[str, list[int]] = defaultdict(list)
    for index, page in enumerate(pages):
        file_indices[str(page.source_path)].append(index)

    # Pick a primary source at file level. Consistently relevant files beat a
    # single lucky page, and landscape-heavy files get a small slide-deck boost.
    file_scores: dict[str, float] = {}
    for source, indices in file_indices.items():
        per_window = np.max(score_matrix[indices, :], axis=0)
        coverage_score = float(np.mean(per_window))
        peak_score = float(np.max(per_window))
        contexts = [pages[index] for index in indices]
        landscape_ratio = sum(_is_landscape(page) for page in contexts) / len(contexts)
        slide_boost = 1.15 if landscape_ratio >= 0.6 else 1.0
        file_scores[source] = (0.75 * coverage_score + 0.25 * peak_score) * slide_boost

    primary_source = max(file_scores, key=file_scores.get)
    primary_indices = file_indices[primary_source]
    primary_quota = min(top_k, max(1, math.ceil(top_k * 0.7)))

    # Find the best primary-deck page for each chronological transcript window,
    # then sample those candidates across the whole lecture rather than taking
    # only the strongest (often end-of-deck summary) pages.
    window_candidates: list[tuple[int, int, float]] = []
    seen_primary: set[int] = set()
    for window_index in range(len(query_windows)):
        local_scores = score_matrix[primary_indices, window_index]
        local_position = int(np.argmax(local_scores))
        page_index = primary_indices[local_position]
        score = float(local_scores[local_position])
        if score > 0 and page_index not in seen_primary:
            seen_primary.add(page_index)
            window_candidates.append((window_index, page_index, score))

    selected_indices: list[int] = []
    selected_scores: dict[int, float] = {}
    if len(window_candidates) <= primary_quota:
        sampled_candidates = window_candidates
    else:
        positions = np.linspace(0, len(window_candidates) - 1, primary_quota)
        sampled_candidates = [window_candidates[int(round(position))] for position in positions]

    for _, page_index, score in sampled_candidates:
        if page_index not in selected_scores:
            selected_indices.append(page_index)
            selected_scores[page_index] = score
    selected_indices.sort(key=lambda index: pages[index].page_number)

    # Fill remaining slots with the strongest supplementary evidence. Limit
    # each non-primary file so broad books/exam archives cannot crowd out the
    # actual lecture deck.
    aggregate_scores = np.max(score_matrix, axis=1)
    supplementary_threshold = float(np.max(aggregate_scores)) * 0.65
    supplementary_counts: dict[str, int] = defaultdict(int)
    for raw_index in np.argsort(aggregate_scores)[::-1]:
        page_index = int(raw_index)
        if len(selected_indices) >= top_k:
            break
        if page_index in selected_scores:
            continue
        score = float(aggregate_scores[page_index])
        if math.isnan(score) or score < supplementary_threshold:
            continue
        source = str(pages[page_index].source_path)
        if source == primary_source:
            continue
        if file_scores[source] < file_scores[primary_source] * 0.55:
            continue
        if supplementary_counts[source] >= 2:
            continue
        selected_indices.append(page_index)
        selected_scores[page_index] = score
        supplementary_counts[source] += 1

    # Small libraries may not contain enough supplementary sources. In that
    # case, fill any remaining slots from the primary deck.
    for raw_index in np.argsort(aggregate_scores)[::-1]:
        page_index = int(raw_index)
        if len(selected_indices) >= top_k:
            break
        if page_index in selected_scores:
            continue
        if str(pages[page_index].source_path) != primary_source:
            continue
        score = float(aggregate_scores[page_index])
        if math.isnan(score) or score <= 0:
            continue
        selected_indices.append(page_index)
        selected_scores[page_index] = score

    return [
        RetrievalMatch(
            chunk=PdfChunk(
                source_path=pages[index].source_path,
                page_number=pages[index].page_number,
                chunk_index=0,
                text=pages[index].combined_text,
            ),
            score=selected_scores[index],
        )
        for index in selected_indices
    ]


def _split_query_text(query_text: str, max_windows: int = 12) -> list[str]:
    words = query_text.split()
    if not words:
        return [query_text]
    window_size = max(250, math.ceil(len(words) / max_windows))
    windows = [
        " ".join(words[start : start + window_size])
        for start in range(0, len(words), window_size)
    ]
    return windows[:max_windows]


def _is_landscape(page: PdfPageContext) -> bool:
    return page.width > 0 and page.height > 0 and page.width >= page.height * 1.1


def rank_pdf_chunks(query_text: str, chunks: list[PdfChunk], top_k: int) -> list[RetrievalMatch]:
    return rank_pdf_chunks_internal(query_text=query_text, chunks=chunks, top_k=top_k, unique_by_file=False)


def rank_pdf_chunks_unique_files(query_text: str, chunks: list[PdfChunk], top_k: int) -> list[RetrievalMatch]:
    return rank_pdf_chunks_internal(query_text=query_text, chunks=chunks, top_k=top_k, unique_by_file=True)


def rank_pdf_chunks_internal(
    query_text: str,
    chunks: list[PdfChunk],
    top_k: int,
    unique_by_file: bool,
) -> list[RetrievalMatch]:
    if not chunks:
        return []
    if not query_text.strip():
        return []

    corpus_texts = [chunk.text for chunk in chunks]
    vectorizer = TfidfVectorizer(
        lowercase=True,
        stop_words=None,
        ngram_range=(1, 2),
        min_df=1,
        max_df=0.98,
        sublinear_tf=True,
    )

    matrix = vectorizer.fit_transform(corpus_texts + [query_text])
    corpus_tfidf = matrix[:-1]
    query_tfidf = matrix[-1]

    n_features = corpus_tfidf.shape[1]
    n_components = max(2, min(256, n_features - 1)) if n_features > 2 else 2

    if n_features > 2:
        svd = TruncatedSVD(n_components=n_components, random_state=42)
        reduced_corpus = svd.fit_transform(corpus_tfidf)
        reduced_query = svd.transform(query_tfidf)
        scores = cosine_similarity(reduced_corpus, reduced_query).ravel()
    else:
        scores = cosine_similarity(corpus_tfidf, query_tfidf).ravel()
    sorted_indices = np.argsort(scores)[::-1]

    matches: list[RetrievalMatch] = []
    seen_files: set[str] = set()
    for idx in sorted_indices:
        score = float(scores[idx])
        if math.isnan(score):
            continue
        if score <= 0:
            continue

        chunk = chunks[int(idx)]
        if unique_by_file:
            source_key = str(chunk.source_path)
            if source_key in seen_files:
                continue
            seen_files.add(source_key)

        matches.append(RetrievalMatch(chunk=chunk, score=score))
        if len(matches) >= top_k:
            break

    return matches


def _chunk_text(text: str, chunk_size_words: int, overlap_words: int) -> list[str]:
    words = text.split()
    if not words:
        return []

    chunks: list[str] = []
    step = max(1, chunk_size_words - overlap_words)

    for start in range(0, len(words), step):
        end = start + chunk_size_words
        piece = words[start:end]
        if not piece:
            continue
        chunks.append(" ".join(piece))
        if end >= len(words):
            break

    return chunks
