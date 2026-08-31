# Robert — pull & run from source (Windows). Run in PowerShell:
#   git clone <repo>; cd robert\pluely; .\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
function Say($m){ Write-Host "`n> $m" -ForegroundColor Cyan }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "Install Node.js 20+ from https://nodejs.org, then re-run."; exit 1 }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Say "Install Rust from https://rustup.rs, then re-run."; exit 1 }
if (-not (Test-Path "C:\Program Files\LLVM\bin")) { Say "Installing LLVM (needed by whisper-rs)…"; choco install llvm -y --no-progress }
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
Say "Installing JS dependencies…"; npm install
Say "Building Robert (first build takes a few minutes)…"; npm run tauri build
Write-Host "`nBuilt. Installer is in src-tauri\target\release\bundle\nsis\  — or run:  npm run tauri dev"
