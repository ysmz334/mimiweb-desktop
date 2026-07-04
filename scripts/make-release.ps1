# ============================================================================
# リリース配布物を release/ にまとめて生成するスクリプト
#
#   出力 (release/):
#     - mimiweb-desktop-{version}-windows-x64-setup.exe   (NSIS インストーラ)
#     - mimiweb-desktop-{version}-windows-x64.zip          (ポータブル版)
#     - SHA256SUMS.txt                                     (上記2ファイルのハッシュ)
#
#   使い方:
#     pwsh -File scripts/make-release.ps1 -BuildFirst   # tauri build から実行（推奨）
#     pwsh -File scripts/make-release.ps1               # ビルド済み成果物をパッケージのみ
#
#   ※ VOICEVOX エンジンは初回起動時に自動ダウンロードされるため配布物には含めません。
# ============================================================================
param(
    [switch]$BuildFirst  # 付けると npm run tauri build からやり直す
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot  = (Resolve-Path "$PSScriptRoot\..").Path
$tauriConf = Get-Content "$repoRoot\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version   = $tauriConf.version
$outDir    = "$repoRoot\release"

# ── ビルド ───────────────────────────────────────────────────────────────────
if ($BuildFirst) {
    Write-Host "Building release (npm run tauri build)..." -ForegroundColor Cyan
    Push-Location $repoRoot
    npm run tauri build
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw "tauri build に失敗しました (exit $LASTEXITCODE)" }
}

# ── 出力ディレクトリを作り直す ───────────────────────────────────────────────
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ── 1. インストーラ (NSIS) を配布名でコピー ─────────────────────────────────
$nsis = "$repoRoot\src-tauri\target\release\bundle\nsis\mimiweb-desktop_${version}_x64-setup.exe"
if (-not (Test-Path $nsis)) {
    throw "インストーラが見つかりません: $nsis`n先に 'npm run build:installer' を実行するか -BuildFirst を付けてください。"
}
$installerName = "mimiweb-desktop-$version-windows-x64-setup.exe"
Copy-Item $nsis "$outDir\$installerName"

# ── 2. ポータブル ZIP を作成 ─────────────────────────────────────────────────
$exe = "$repoRoot\src-tauri\target\release\mimiweb-desktop.exe"
if (-not (Test-Path $exe)) {
    throw "リリースバイナリが見つかりません: $exe`n先に 'npm run build:installer' を実行するか -BuildFirst を付けてください。"
}
$zipName = "mimiweb-desktop-$version-windows-x64.zip"
$staging = "$outDir\_portable"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item $exe "$staging\mimiweb-desktop.exe"
Compress-Archive -Path "$staging\*" -DestinationPath "$outDir\$zipName"
Remove-Item -Recurse -Force $staging

# ── 3. SHA256SUMS.txt を生成（ASCII / BOM なし） ─────────────────────────────
$lines = foreach ($name in @($installerName, $zipName)) {
    $h = (Get-FileHash "$outDir\$name" -Algorithm SHA256).Hash.ToLower()
    "$h  $name"
}
($lines -join "`n") + "`n" | Out-File -Encoding ascii "$outDir\SHA256SUMS.txt"

# ── 結果表示 ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Release assets ready: $outDir" -ForegroundColor Green
Get-ChildItem $outDir | Sort-Object Name | ForEach-Object {
    Write-Host ("  {0,10:N0} bytes  {1}" -f $_.Length, $_.Name)
}
Write-Host ""
Write-Host "次の3ファイルを GitHub Release に添付してください:" -ForegroundColor Cyan
Write-Host "  - $installerName"
Write-Host "  - $zipName"
Write-Host "  - SHA256SUMS.txt"
