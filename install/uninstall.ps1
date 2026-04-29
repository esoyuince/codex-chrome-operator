param(
  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [switch] $RemoveLogs,
  [switch] $SkipRegistry
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

if (-not $SkipRegistry) {
  $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.chrome_operator"
  if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Force
  }
}

$manifestPath = Join-Path $InstallDir "com.codex.chrome_operator.json"
$launcherPath = Join-Path $InstallDir "codex-chrome-operator-native-bridge.cmd"
$tokenPath = Join-Path $InstallDir "token.txt"
$configPath = Join-Path $InstallDir "config.json"
$extensionIdPath = Join-Path $InstallDir "extension-id.txt"
$extensionTarget = Join-Path $InstallDir "extension-unpacked"

foreach ($file in @($manifestPath, $launcherPath, $tokenPath, $configPath, $extensionIdPath)) {
  if (Test-Path -LiteralPath $file) {
    Remove-Item -LiteralPath $file -Force
  }
}

if (Test-Path -LiteralPath $extensionTarget) {
  $installFullPath = [System.IO.Path]::GetFullPath($InstallDir)
  $targetFullPath = [System.IO.Path]::GetFullPath($extensionTarget)
  if (-not $targetFullPath.StartsWith($installFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove extension outside install dir: $extensionTarget"
  }
  Remove-Item -LiteralPath $extensionTarget -Recurse -Force
}

if ($RemoveLogs -and (Test-Path -LiteralPath $InstallDir)) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host "Uninstalled Codex Chrome Operator Native Messaging host."
