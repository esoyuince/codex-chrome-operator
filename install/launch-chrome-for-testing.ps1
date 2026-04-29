param(
  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [string] $ChromeForTestingPath,
  [string] $ProfileDir = "$env:LOCALAPPDATA\CodexChromeOperator\chrome-for-testing-profile",
  [int] $RemoteDebuggingPort = 9224
)

$ErrorActionPreference = "Stop"

$extensionIdPath = Join-Path $InstallDir "extension-id.txt"
$extensionDir = Join-Path $InstallDir "extension-unpacked"

if (-not (Test-Path -LiteralPath $extensionIdPath)) {
  throw "Extension id file not found. Run install\install.ps1 first."
}

if (-not (Test-Path -LiteralPath (Join-Path $extensionDir "manifest.json"))) {
  throw "Unpacked extension not found. Run install\install.ps1 first."
}

if (-not $ChromeForTestingPath) {
  $browserRoot = Join-Path $InstallDir "browsers\chrome"
  $candidate = Get-ChildItem -LiteralPath $browserRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "chrome-win64\chrome.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

  if (-not $candidate) {
    throw "Chrome for Testing not found under $browserRoot. Install it with: npx @puppeteer/browsers install chrome@stable --path `"$InstallDir\browsers`" --platform win64"
  }

  $ChromeForTestingPath = $candidate
}

$extensionId = (Get-Content -Raw -LiteralPath $extensionIdPath).Trim()
if (-not ($extensionId -match "^[a-p]{32}$")) {
  throw "Invalid extension id in $extensionIdPath"
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$arguments = @(
  "--user-data-dir=$ProfileDir",
  "--load-extension=$extensionDir",
  "--no-first-run",
  "--new-window",
  "--remote-debugging-port=$RemoteDebuggingPort",
  "chrome-extension://$extensionId/bootstrap.html"
)

$process = Start-Process -FilePath $ChromeForTestingPath -ArgumentList $arguments -PassThru
Write-Host "Launched Chrome for Testing."
Write-Host "PID: $($process.Id)"
Write-Host "Bootstrap: chrome-extension://$extensionId/bootstrap.html"
