#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${SCRIPT_DIR}/fashn-vton-1.5"

echo "=================================================="
echo "🚀 1-Click Local FASHN VTON Server Launcher"
echo "=================================================="

# Step 1: Clone FASHN VTON open-source repo if missing
if [ ! -d "$WORK_DIR" ]; then
    echo "📦 [1/4] Cloning FASHN VTON repository..."
    git clone https://github.com/fashn-AI/fashn-vton-1.5.git "$WORK_DIR"
fi

cd "$WORK_DIR"

# Step 2: Create Python virtual environment if missing
if [ ! -d ".venv" ]; then
    echo "🐍 [2/4] Creating Python virtual environment..."
    python3 -m venv .venv
fi

source .venv/bin/activate

# Step 3: Install requirements
echo "⚡ [3/4] Checking Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -e .
pip install --quiet -r "${SCRIPT_DIR}/requirements.txt"

# Step 4: Download weights if missing
if [ ! -d "./weights" ] || [ -z "$(ls -A ./weights 2>/dev/null)" ]; then
    echo "📥 [4/4] Downloading model weights to ./weights..."
    python3 scripts/download_weights.py --weights-dir ./weights
fi

export FASHN_WEIGHTS_DIR="${WORK_DIR}/weights"
export FASHN_LOCAL_HOST="127.0.0.1"
export FASHN_LOCAL_PORT="8000"

echo "=================================================="
echo "✅ Setup Ready! Server running on http://127.0.0.1:8000"
echo "=================================================="

python3 "${SCRIPT_DIR}/server.py"
