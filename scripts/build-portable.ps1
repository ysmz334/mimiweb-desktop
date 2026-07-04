# ポータブル ZIP 配布物を作成するスクリプト
# 事前に `npm run tauri build` でリリースビルドを作成しておくこと
#
# 出力: dist/mimiweb-desktop-{version}-windows-x64.zip
#   ├── mimiweb-desktop.exe   (アプリ本体)
#   └── (voicevox_engine/ は初回起動時に自動ダウンロード)

param(
    [switch]$BuildFirst  # このスイッチを付けると tauri build から実行する
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── バージョン取得 ──────────────────────────────────────────────────────────
$tauriConf = Get-Content "$PSScriptRoot\..\src-tauri\tauri.conf.json" | ConvertFrom-Json
$version   = $tauriConf.version

# ── ビルド ─────────────────────────────────────────────────────────────────
if ($BuildFirst) {
    Write-Host "Building release..." -ForegroundColor Cyan
    Push-Location "$PSScriptRoot\.."
    npm run tauri build
    Pop-Location
}

# ── 入出力パス ──────────────────────────────────────────────────────────────
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$exe      = "$repoRoot\src-tauri\target\release\mimiweb-desktop.exe"
$outDir   = "$repoRoot\dist"
$zipName  = "mimiweb-desktop-$version-windows-x64"
$staging  = "$outDir\$zipName"
$zipPath  = "$outDir\$zipName.zip"

if (-not (Test-Path $exe)) {
    Write-Error "リリースバイナリが見つかりません: $exe`n先に 'npm run tauri build' を実行してください。"
    exit 1
}

# ── ステージング ────────────────────────────────────────────────────────────
Write-Host "Staging: $staging" -ForegroundColor Cyan
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Copy-Item $exe "$staging\mimiweb-desktop.exe"

# ── ZIP 作成 ────────────────────────────────────────────────────────────────
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path "$staging\*" -DestinationPath $zipPath

# ── クリーンアップ ──────────────────────────────────────────────────────────
Remove-Item -Recurse -Force $staging

# ── SHA256 チェックサム ────────────────────────────────────────────────────
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
$checksum = "$hash  $zipName.zip"
$checksumPath = "$outDir\SHA256SUMS.txt"

if (Test-Path $checksumPath) {
    $existing = Get-Content $checksumPath | Where-Object { $_ -notmatch [regex]::Escape("$zipName.zip") }
    ($existing + $checksum) | Out-File -Encoding utf8 $checksumPath
} else {
    $checksum | Out-File -Encoding utf8 $checksumPath
}

Write-Host ""
Write-Host "Done: $zipPath" -ForegroundColor Green
Write-Host "  SHA256: $hash"
Write-Host "  チェックサム: $checksumPath"
Write-Host "  VOICEVOX エンジンは初回起動時に自動ダウンロードされます。"
