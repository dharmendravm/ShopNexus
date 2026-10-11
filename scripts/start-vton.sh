#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VTON_DIR="${PROJECT_ROOT}/scripts/fashn-vton-local"
WORK_DIR="${VTON_DIR}/fashn-vton-1.5"

echo "=================================================="
echo "🧠 Starting Local FASHN VTON Server"
echo "=================================================="

# Check if setup has been run
if [ ! -d "${WORK_DIR}/.venv" ]; then
    echo "⚠️ Python environment not found! Running setup first..."
    bash "${PROJECT_ROOT}/scripts/autosetup.sh"
fi

source "${WORK_DIR}/.venv/bin/activate"

# Hardware auto-detection
OS_TYPE="$(uname -s)"
ARCH_TYPE="$(uname -m)"

if [ -z "$FASHN_DEVICE" ]; then
    if [ "$OS_TYPE" = "Darwin" ]; then
        if [ "$ARCH_TYPE" = "arm64" ]; then
            echo "🍎 Apple Silicon Mac detected (M1/M2/M3/M4) -> Using Metal GPU (mps)"
            export FASHN_DEVICE="mps"
        else
            echo "🍎 Intel Mac detected -> Using CPU"
            export FASHN_DEVICE="cpu"
        fi
    else
        if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
            echo "🚀 NVIDIA GPU detected -> Using CUDA"
            export FASHN_DEVICE="cuda"
        else
            echo "💻 No NVIDIA GPU found -> Using CPU"
            export FASHN_DEVICE="cpu"
        fi
    fi
else
    echo "⚙️ Using custom FASHN_DEVICE: $FASHN_DEVICE"
fi

export FASHN_WEIGHTS_DIR="${WORK_DIR}/weights"
export FASHN_LOCAL_HOST="127.0.0.1"
export FASHN_LOCAL_PORT="8000"

echo "🌐 Server listening on http://127.0.0.1:8000 (Device: $FASHN_DEVICE)"
echo "Press Ctrl+C to stop."
echo "=================================================="

python3 "${VTON_DIR}/server.py"
