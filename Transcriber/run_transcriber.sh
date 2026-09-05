#!/usr/bin/env bash
set -euo pipefail

# Resolve project root from this script location, even when invoked via symlink.
SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  LINK_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" = /* ]] || SCRIPT_PATH="$LINK_DIR/$SCRIPT_PATH"
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
VENV_PYTHON3="$SCRIPT_DIR/.venv/bin/python3"
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"

resolve_venv_python() {
  if [[ -x "$VENV_PYTHON3" ]]; then
    echo "$VENV_PYTHON3"
    return 0
  fi
  if [[ -x "$VENV_PYTHON" ]]; then
    echo "$VENV_PYTHON"
    return 0
  fi
  return 1
}

if ! PYTHON_BIN="$(resolve_venv_python)"; then
  echo "Virtual environment missing or broken. Recreating at $SCRIPT_DIR/.venv..." >&2
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found on PATH." >&2
    exit 1
  fi
  if [[ -d "$SCRIPT_DIR/.venv" ]]; then
    rm -rf "$SCRIPT_DIR/.venv"
  fi
  python3 -m venv "$SCRIPT_DIR/.venv"
  PYTHON_BIN="$(resolve_venv_python || true)"
  if [[ -z "$PYTHON_BIN" ]]; then
    echo "ERROR: could not initialize virtual environment under $SCRIPT_DIR/.venv/bin" >&2
    exit 1
  fi
  if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    "$PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
  fi
  if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    echo "ERROR: pip is missing in the virtual environment and could not be bootstrapped." >&2
    echo "Install python3-venv/pip on your system, then rerun this script." >&2
    exit 1
  fi
  "$PYTHON_BIN" -m pip install -r "$SCRIPT_DIR/requirements.txt"
fi

# Ensure imports like "src.cli" resolve even when launched from outside the repo.
cd "$SCRIPT_DIR"

# Repair partially initialized environments (e.g., recreated venv without deps).
if ! "$PYTHON_BIN" -c "import src.cli" >/dev/null 2>&1; then
  echo "Installing missing Python dependencies from requirements.txt..." >&2
  if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    "$PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
  fi
  if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    echo "ERROR: pip is missing in the virtual environment and could not be bootstrapped." >&2
    echo "Install python3-venv/pip on your system, then rerun this script." >&2
    exit 1
  fi
  "$PYTHON_BIN" -m pip install -r "$SCRIPT_DIR/requirements.txt"
fi

if [[ -z "${POLIWEBEX_RUN_ON_HOST:-}" ]]; then
  if command -v flatpak-spawn >/dev/null 2>&1; then
    export POLIWEBEX_RUN_ON_HOST="true"
  else
    export POLIWEBEX_RUN_ON_HOST="false"
  fi
fi

exec "$PYTHON_BIN" -m src.cli \
  --poliwebex-path "$SCRIPT_DIR/PoliWebex" \
  "$@"
