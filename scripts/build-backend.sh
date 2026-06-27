#!/usr/bin/env bash
# Freeze the FastAPI backend into a standalone binary using PyInstaller.
set -e

BACKEND_SRC="../../babyAI-backend"
OUT_DIR="../vendor/backend"

echo "→ Installing PyInstaller..."
pip install pyinstaller

echo "→ Freezing backend..."
cd "$BACKEND_SRC"

pyinstaller backend.spec --clean --distpath "$(pwd)/../babyAI-desktop/vendor/backend"

echo "✓ Backend frozen → vendor/backend/api"
