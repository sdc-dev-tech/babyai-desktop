#!/usr/bin/env bash
# Freeze the FastAPI backend into a standalone binary using PyInstaller.
set -e

BACKEND_SRC="../../babyAI-backend"
OUT_DIR="../vendor/backend"

echo "→ Installing PyInstaller..."
pip install pyinstaller

echo "→ Freezing backend..."
cd "$BACKEND_SRC"

pyinstaller \
  --onefile \
  --name api \
  --distpath "$(pwd)/../babyAI-desktop/vendor/backend" \
  --workpath /tmp/pyinstaller-build \
  --specpath /tmp/pyinstaller-spec \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import psycopg2 \
  --hidden-import anthropic \
  --collect-all fastapi \
  --collect-all starlette \
  api/main.py

echo "✓ Backend frozen → vendor/backend/api"
