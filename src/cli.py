from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import from_env
from .logging_utils import setup_logging
from .pipeline import run_pipeline


PROJECT_ROOT = Path(__file__).resolve().parent.parent
INTERMEDIATE_ROOT = PROJECT_ROOT / "artifacts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download lecture videos with PoliWebex, transcribe them, match relevant PDFs, "
            "and generate either manual prompt packs or Codex-powered Obsidian lecture notes."
        )
    )
    parser.add_argument(
        "--urls",
        nargs="+",
        required=False,
        help="One or more WebEx lecture URLs.",
    )
    parser.add_argument(
        "--urls-file",
        default=None,
        help="Text file containing one WebEx lecture URL per line; blank lines and # comments are ignored.",
    )
    parser.add_argument(
        "--materials-path",
        required=False,
        help="Path to course-material root folder (PDF files are scanned recursively).",
    )
    parser.add_argument(
        "--output-root",
        default=None,
        help="Obsidian output folder; notes and shared assets are written here, intermediates under the repository artifacts/.",
    )
    parser.add_argument(
        "--poliwebex-path",
        default=None,
        help="Path to cloned PoliWebex repo. If omitted, uses POLIWEBEX_PATH env var.",
    )
    parser.add_argument(
        "--retry-interval",
        type=int,
        default=1,
        help="PoliWebex retry interval in seconds.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=None,
        help="Top-K retrieved PDF chunks for the prompt pack.",
    )
    parser.add_argument(
        "--notes-mode",
        choices=["transcript-only", "prompt-pack", "api"],
        default=None,
        help="Choose transcript-only output, manual prompt packs, or Codex-generated Obsidian notes.",
    )
    parser.add_argument(
        "--codex-model",
        default=None,
        help="Codex model used for note generation (default: gpt-5.6-luna).",
    )
    parser.add_argument(
        "--codex-reasoning-effort",
        choices=["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        default=None,
        help="Codex reasoning effort used for note generation (default: high).",
    )
    parser.add_argument(
        "--video-frames",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable selective lecture-video frames in Codex notes (default: enabled).",
    )
    parser.add_argument(
        "--video-frame-interval",
        type=int,
        default=None,
        help="Seconds between low-resolution video probes (default: 60).",
    )
    parser.add_argument(
        "--max-video-frames",
        type=int,
        default=None,
        help="Maximum selected video-frame candidates per lecture (default: 8).",
    )
    parser.add_argument(
        "--max-total-images",
        type=int,
        default=None,
        help="Hard combined limit for slide and video images sent to Codex (default: 12).",
    )
    parser.add_argument(
        "--prefetch-downloads",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Download one upcoming batch recording while processing the current one (default: enabled).",
    )
    parser.add_argument(
        "--no-skip-keyring",
        action="store_true",
        help="Use PoliWebex keyring storage (default skips keyring via -k).",
    )
    parser.add_argument(
        "--default-language",
        default=None,
        help="Default transcription language (e.g. en, fr). If omitted, language detection is used.",
    )
    parser.add_argument(
        "--num-cores",
        type=int,
        default=None,
        help="Number of CPU cores to use for transcription. If omitted, uses the current environment settings.",
    )
    parser.add_argument(
        "--transcription-profile",
        choices=["fast", "balanced", "accurate"],
        default=None,
        help="Transcription strategy (default: balanced).",
    )
    parser.add_argument(
        "--whisper-retry-model",
        default=None,
        help="Model used for uncertain regions or the accurate profile (default: medium).",
    )
    parser.add_argument(
        "--vad",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable voice-activity filtering during transcription (default: enabled).",
    )
    parser.add_argument(
        "--whisper-max-retry-fraction",
        type=float,
        default=None,
        help="Maximum fraction of a lecture selectively retranscribed (default: 0.25).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    return parser.parse_args()


def load_urls_file(path_value: str) -> list[str]:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"URL file not found: {path}")

    urls: list[str] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if not line.startswith(("http://", "https://")):
            raise ValueError(f"Invalid URL in {path} at line {line_number}: {line}")
        urls.append(line)
    return urls


def collect_urls(args: argparse.Namespace) -> list[str]:
    candidates = list(args.urls or [])
    if args.urls_file:
        file_urls = load_urls_file(args.urls_file)
        if not file_urls and not candidates:
            raise ValueError(f"URL file contains no lecture URLs: {args.urls_file}")
        candidates.extend(file_urls)

    urls: list[str] = []
    seen: set[str] = set()
    for url in candidates:
        normalized = url.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)
    return urls


def prompt_missing_inputs(args: argparse.Namespace) -> tuple[list[str], str]:
    urls = collect_urls(args)
    if not urls:
        raw_urls = input("Enter lecture URL(s), separated by spaces: ").strip()
        urls = [item for item in raw_urls.split() if item]
        if not urls:
            raise ValueError("At least one lecture URL is required.")

    materials_path = args.materials_path
    if not materials_path:
        materials_path = input("Enter materials folder path: ").strip()
        if not materials_path:
            raise ValueError("Materials folder path is required.")

    return urls, materials_path


def prompt_output_root(args: argparse.Namespace) -> str:
    if args.output_root:
        return args.output_root

    raw_output_root = input("Enter output folder path [notes]: ").strip()
    return raw_output_root or "notes"


def prompt_notes_mode(args: argparse.Namespace) -> str:
    if args.notes_mode:
        return args.notes_mode

    print("Choose output mode:")
    print("  1) transcript only")
    print("  2) prompt pack for manual note writing")
    print("  3) Codex-generated Obsidian lecture notes")

    raw_choice = input("Select 1, 2, or 3 [3]: ").strip()
    if raw_choice in {"2", "prompt-pack", "prompt pack"}:
        return "prompt-pack"
    if raw_choice in {"1", "transcript-only", "transcript only"}:
        return "transcript-only"
    if raw_choice in {"", "3", "api", "notes"}:
        return "api"

    raise ValueError("Invalid output mode selected. Choose 1, 2, or 3.")


def main() -> int:
    args = parse_args()

    try:
        urls, materials_path = prompt_missing_inputs(args)
        output_root = prompt_output_root(args)
        output_root_path = Path(output_root).expanduser().resolve()
        try:
            output_root_path.relative_to(INTERMEDIATE_ROOT.resolve())
        except ValueError:
            pass
        else:
            raise ValueError(
                f"Output folder must be separate from the repository artifacts folder: {output_root_path}"
            )
        setup_logging(INTERMEDIATE_ROOT / "logs", verbose=args.verbose)
        notes_mode = prompt_notes_mode(args)
        config = from_env(
            explicit_poliwebex_path=args.poliwebex_path,
            top_k_matches=args.top_k,
            explicit_whisper_language=args.default_language,
            explicit_whisper_num_cores=args.num_cores,
            explicit_notes_mode=notes_mode,
            explicit_codex_model=args.codex_model,
            explicit_codex_reasoning_effort=args.codex_reasoning_effort,
            explicit_video_frames_enabled=args.video_frames,
            explicit_video_frame_interval_seconds=args.video_frame_interval,
            explicit_max_video_frames=args.max_video_frames,
            explicit_max_total_images=args.max_total_images,
            explicit_prefetch_downloads=args.prefetch_downloads,
            explicit_whisper_profile=args.transcription_profile,
            explicit_whisper_retry_model=args.whisper_retry_model,
            explicit_whisper_vad_filter=args.vad,
            explicit_whisper_max_retry_fraction=args.whisper_max_retry_fraction,
        )
        artifacts = run_pipeline(
            urls=urls,
            materials_root=Path(materials_path).expanduser().resolve(),
            output_root=output_root_path,
            config=config,
            retry_interval=args.retry_interval,
            skip_keyring=not args.no_skip_keyring,
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Generated artifacts:")
    for item in artifacts:
        if item.notes_markdown is not None:
            print(f"- {item.lecture_id}: final note created at {item.notes_markdown}")
            print(f"  metadata: {item.metadata_json}")
            continue
        elif item.prompt_markdown is not None:
            generated_output = item.prompt_markdown
        else:
            generated_output = item.transcript_txt
        print(f"- {item.lecture_id}: {generated_output} | {item.metadata_json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
