# Transcriber (PoliWebex + Whisper + Codex lecture notes)

This project automates lecture note preparation with this pipeline:

1. Download lecture recordings with [PoliWebex](https://github.com/sup3rgiu/PoliWebex)
2. Transcribe recordings with `faster-whisper`
3. Search a course-material folder recursively for `.pdf` files
4. Extract each PDF page, run OCR when available, and semantically rank relevant pages against transcript content
5. Generate ready-to-use Obsidian lecture notes with the locally authenticated
   Codex CLI, inline slide images, MathJax formulas, course-material links, and
   JSON retrieval evidence. Transcript-only and manual prompt-pack modes remain available.

## Requirements

### System dependencies (Linux)

```bash
sudo apt update
sudo apt install -y ffmpeg aria2 nodejs npm tesseract-ocr
```

PoliWebex uses browser automation for login; this is intended for desktop Linux with GUI.

### Python dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Install and authenticate Codex once:

```bash
codex login
codex login status
```

The default note model is `gpt-5.6-luna` with `high` reasoning. `codex exec`
reuses the local ChatGPT login, so no OpenAI API key is needed.

## Setup

1. Clone PoliWebex inside this workspace:

```bash
git clone https://github.com/sup3rgiu/PoliWebex
cd PoliWebex
npm install
cd ..
```

2. Configure environment:

```bash
cp .env.example .env
```

Then edit `.env` and set `POLIWEBEX_PATH` (for in-workspace clone it is typically `/absolute/path/to/Transcriber/PoliWebex`).

If Node/aria2c are installed but not visible in non-interactive shells, set:

- `NODE_BIN=/absolute/path/to/node`
- `ARIA2C_BIN=/absolute/path/to/aria2c`
- `FFMPEG_BIN=/absolute/path/to/ffmpeg` (optional if already in PATH)
- `POLIWEBEX_RUN_ON_HOST=true` to force running downloader on host (useful in Flatpak terminals with no GUI `DISPLAY`)

## Usage

Run with one or more lecture URLs (fully non-interactive). The default mode
generates Obsidian notes:

```bash
python -m src.cli \
  --urls "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/XYZ" \
         "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/ABC" \
  --materials-path "/path/to/course-materials" \
  --output-root "/path/to/obsidian-vault"
```

For a batch, put one URL on each line of a text file. Empty lines and lines
beginning with `#` are ignored:

```text
# recordings.txt
https://politecnicomilano.webex.com/.../playback/XYZ
https://politecnicomilano.webex.com/.../playback/ABC
```

```bash
python -m src.cli \
  --urls-file recordings.txt \
  --materials-path "/path/to/course-materials" \
  --output-root "/path/to/obsidian-vault"
```

`--urls` and `--urls-file` can be used together; duplicates are processed once.

Interactive mode (asks for lecture URL(s), materials path, notes mode, and output folder after launch):

```bash
python -m src.cli
```

When running interactively, the CLI also asks whether you want transcript-only
output, a prompt pack, or Codex-generated Obsidian notes.

From inside the project folder:

```bash
./run_transcriber.sh --verbose
```

Run from your home directory for a new lecture:

```bash
cd ~
/home/aleo113/Documents/Transcriber/run_transcriber.sh --verbose
```

You can also pass all normal CLI flags to the launcher:

```bash
/home/aleo113/Documents/Transcriber/run_transcriber.sh \
  --urls "https://.../playback/XYZ" \
  --materials-path "/path/to/course-materials" \
  --top-k 20 \
  --verbose
```

It will prompt:
- `Enter lecture URL(s), separated by spaces:`
- `Enter materials folder path:`
- `Enter output folder path [notes]:`
- `Select 1, 2, or 3 [3]:`

### Useful flags

- `--poliwebex-path /path/to/PoliWebex`: override env var
- `--retry-interval 2`: PoliWebex retry interval
- `--top-k 15`: number of retrieved PDF pages per lecture
- `--no-skip-keyring`: do not pass `-k` to PoliWebex
- `--verbose`: debug logging
- `--notes-mode transcript-only|prompt-pack|api`: choose the output mode explicitly
- `--urls-file recordings.txt`: read one recording URL per line
- `--codex-model gpt-5.6-luna`: override the Codex model
- `--codex-reasoning-effort high`: override reasoning effort

## Outputs

The selected output folder is intended to be an Obsidian vault. It contains only
the generated notes and one shared attachment folder. Preliminary files are
always written to the repository's `artifacts/` directory, not to this folder:

- `<readable lecture title>.md` Obsidian-ready lecture notes, all at the vault root
- `assets/*.png` rendered slide pages shared by all notes

All intermediate files are stored separately under the repository's `artifacts/`:

- `artifacts/downloads/<lecture_id>/...` downloaded media
- `artifacts/processed/<lecture_id>/transcript.txt` and `transcript.json`
- `artifacts/prompt_packs/<lecture_id>.md` manual prompt packs
- `artifacts/metadata/<lecture_id>.json` retrieval and artifact metadata
- `artifacts/logs/run.log` pipeline logs

During Codex note generation, the terminal reports when Codex is invoked, when it
returns, and the exact path of the final note. The same messages are retained in
`artifacts/logs/run.log`.

The program can still read transcripts and metadata from previous output-relative
layouts for cache compatibility, but new runs use the repository `artifacts/`
directory exclusively for preliminary files.

## Notes

- Only PDF files are scanned in the materials folder.
- Retrieval compares chronological transcript windows with individual pages,
  selects a coherent primary slide deck, and keeps only strong supplementary matches.
- PDF text layers are used directly; OCR runs for image-only or nearly empty pages
  when `tesseract` is installed.
- Codex receives both extracted page text and the selected slide PNGs as native
  image inputs, so diagrams, layout, and formulas are visible during note generation.
- Generated notes use `$...$` and `$$...$$` MathJax delimiters, Obsidian image
  embeds, and file/page links back to the original PDFs.
- The current pipeline transcribes recordings with local `faster-whisper` before
  invoking Codex. Codex CLI and `gpt-5.6-luna` do not accept an MP3 as a direct
  note-generation input; replacing local transcription would require a separate
  audio-transcription API stage and its own API billing.
- Prompt-pack/metadata filenames are URL-derived lecture IDs; when a URL is too generic (for example ending in `playback`), a stable URL hash and collision-safe suffix are used to avoid overwriting files.
