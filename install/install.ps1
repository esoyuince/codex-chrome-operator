param(
  [Parameter(Mandatory = $true)]
  [string] $ExtensionId,

  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [string] $RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = "Stop"

if (-not ($ExtensionId -match "^[a-p]{32}$")) {
  throw "ExtensionId must be the 32-character Chrome extension id."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "audit") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "screenshots") | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
$bridgeScript = Join-Path $RepoRoot "native-bridge\nativeMessagingShim.js"
$launcher = Join-Path $InstallDir "codex-chrome-operator-native-bridge.cmd"
$manifestPath = Join-Path $InstallDir "com.codex.chrome_operator.json"
$tokenPath = Join-Path $InstallDir "token.txt"

if (-not (Test-Path -LiteralPath $bridgeScript)) {
  throw "Native bridge script not found: $bridgeScript"
}

if (-not (Test-Path -LiteralPath $tokenPath)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = [Convert]::ToBase64String($bytes).TrimEnd("=")
  Set-Content -LiteralPath $tokenPath -Value $token -NoNewline -Encoding ASCII
}

$launcherContent = @"
@echo off
set "CODEX_CHROME_OPERATOR_TOKEN="
for /f "usebackq delims=" %%T in ("$tokenPath") do set CODEX_CHROME_OPERATOR_TOKEN=%%T
"$node" "$bridgeScript"
"@
Set-Content -LiteralPath $launcher -Value $launcherContent -Encoding ASCII

$templatePath = Join-Path $PSScriptRoot "native-host-manifest.template.json"
$manifest = Get-Content -LiteralPath $templatePath -Raw
$manifest = $manifest.Replace("__HOST_PATH__", ($launcher.Replace("\", "\\")))
$manifest = $manifest.Replace("__EXTENSION_ID__", $ExtensionId)
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding ASCII

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.chrome_operator"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Host "Installed Codex Chrome Operator Native Messaging host."
Write-Host "Manifest: $manifestPath"
Write-Host "Launcher: $launcher"
