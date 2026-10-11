#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=================================================="
echo "✨ ShopNexus 1-Command Full Auto Setup"
echo "=================================================="

cd "$PROJECT_ROOT"

# Step 1: Environment File (.env)
echo "📁 [1/5] Checking environment configuration (.env)..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "   ✅ Created .env from .env.example"
    else
        echo "   ⚠️ .env not found. Please create one."
    fi
else
    echo "   ✅ .env already exists."
fi

# Step 2: Node Dependencies
echo "📦 [2/5] Installing Node.js dependencies..."
npm install

# Step 3: Database & Prisma Setup
echo "🗄️  [3/5] Setting up Prisma ORM & PostgreSQL..."
npx prisma generate
# Auto-resolve baseline if database already has tables (Prevents P3005 error)
npx prisma migrate deploy || {
    echo "   ⚙️ Non-empty schema detected, baselining migration..."
    npx prisma migrate resolve --applied 20240530213853_create_session_table 2>/dev/null || true
    npx prisma migrate deploy || npx prisma db push
}
echo "   ✅ Database & Prisma client ready."

# Step 4: Python & FASHN VTON Local Setup
echo "🐍 [4/5] Setting up Local FASHN VTON AI Engine..."
VTON_DIR="${PROJECT_ROOT}/scripts/fashn-vton-local"
WORK_DIR="${VTON_DIR}/fashn-vton-1.5"

if ! command -v python3 &>/dev/null; then
    echo "   ❌ Python 3 is not installed! Please install Python 3.10 or 3.11."
    exit 1
fi

if [ ! -d "$WORK_DIR" ]; then
    echo "   📥 Cloning FASHN VTON repository..."
    git clone https://github.com/fashn-AI/fashn-vton-1.5.git "$WORK_DIR"
fi

cd "$WORK_DIR"
if [ ! -d ".venv" ]; then
    echo "   ⚡ Creating virtual environment..."
    python3 -m venv .venv
fi

source .venv/bin/activate
echo "   ⚡ Installing Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -e .
pip install --quiet -r "${VTON_DIR}/requirements.txt"

if [ ! -d "./weights" ] || [ -z "$(ls -A ./weights 2>/dev/null)" ]; then
    echo "   📥 Downloading FASHN AI weights (this may take a few minutes)..."
    python3 scripts/download_weights.py --weights-dir ./weights
fi
echo "   ✅ AI Engine configured."

cd "$PROJECT_ROOT"

# Step 5: Finished
echo "=================================================="
echo "🎉 Setup Completed Successfully!"
echo "=================================================="
echo ""
echo "👉 To start the app, open 2 terminal tabs:"
echo ""
echo "   Tab 1 (Start Local AI Engine):"
echo "   $ npm run vton:start"
echo ""
echo "   Tab 2 (Start Shopify App):"
echo "   $ npm run dev"
echo "=================================================="
