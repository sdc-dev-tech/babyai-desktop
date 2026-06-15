# Downloads the portable PostgreSQL binaries for Windows (x64).
# Run once before building the installer.
# Requires: 7-Zip installed and on PATH, or adjust extraction command.

$PG_VERSION = "16.2-1"
$PG_URL     = "https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip"
$OUT_DIR    = "$PSScriptRoot\..\vendor\postgres"
$ZIP_PATH   = "$env:TEMP\pg-portable.zip"

Write-Host "→ Downloading portable PostgreSQL ${PG_VERSION}..."
Invoke-WebRequest -Uri $PG_URL -OutFile $ZIP_PATH -UseBasicParsing

Write-Host "→ Extracting..."
Expand-Archive -Path $ZIP_PATH -DestinationPath "$env:TEMP\pg-extract" -Force

# The zip contains a pgsql/ folder with bin/, lib/, share/
$PG_SRC = "$env:TEMP\pg-extract\pgsql"

# We only need bin/ lib/ share/ — skip the 500MB doc/pgAdmin
New-Item -ItemType Directory -Force -Path $OUT_DIR | Out-Null
Copy-Item "$PG_SRC\bin"   $OUT_DIR -Recurse -Force
Copy-Item "$PG_SRC\lib"   $OUT_DIR -Recurse -Force
Copy-Item "$PG_SRC\share" $OUT_DIR -Recurse -Force

Write-Host "✓ PostgreSQL binaries → vendor\postgres"
Write-Host "   Size: $((Get-ChildItem $OUT_DIR -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB) MB"
