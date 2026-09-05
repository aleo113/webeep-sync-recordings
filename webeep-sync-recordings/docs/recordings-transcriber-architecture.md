# Recordings and Transcriber integration

The Electron application owns WeBeep authentication, Moodle resource discovery,
the recording catalogue, downloads, job policy, persistence, and UI state.
Transcriber remains a separate Python project and owns transcription, PDF
retrieval, prompt packs, and notes generation.

## Development setup

Install Transcriber as an editable local dependency in its virtual environment:

```sh
cd /home/aleo113/Documents/Transcriber
.venv/bin/python -m pip install --no-build-isolation -e .
```

In WeBeep Sync settings, set **Python executable** to:

```text
/home/aleo113/Documents/Transcriber/.venv/bin/python
```

No source is copied and no Git submodule is used.

## Process boundaries

- React renderer: catalogue, selection, status, progress, and errors.
- Electron main: authenticated discovery, downloads, persistence, and IPC.
- Python worker: one isolated Transcriber job per process.

The worker reads one JSON command from stdin and emits JSON Lines events on
stdout. Cancelling a transcription terminates only its worker process.

## Discovery

All Moodle URL activities are inspected. The authenticated hidden browser
resolves Moodle redirects and classifies the final target:

- a WebEx target becomes one catalogue entry;
- an Aunica/RecMan target is expanded into its contained WebEx recordings;
- unrelated targets are ignored and logged.

Recordings are deduplicated by WebEx recording ID. Discovery never implies a
download unless the separate automatic-download setting is enabled.

## Credentials

The integration reuses the authenticated Electron session. It does not write
SPID passwords or provider API keys to either repository. The compatibility
credential helper refuses to save anything when Electron secure storage is not
available.
