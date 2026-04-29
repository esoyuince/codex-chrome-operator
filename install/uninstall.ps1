param(
  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [switch] $RemoveLogs
)

$ErrorActionPreference = "Stop"

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.chrome_operator"
if (Test-Path -LiteralPath $registryPath) {
  Remove-Item -LiteralPath $registryPath -Force
}

$manifestPath = Join-Path $InstallDir "com.codex.chrome_operator.json"
$launcherPath = Join-Path $InstallDir "codex-chrome-operator-native-bridge.cmd"
$tokenPath = Join-Path $InstallDir "token.txt"

foreach ($file in @($manifestPath, $launcherPath, $tokenPath)) {
  if (Test-Path -LiteralPath $file) {
    Remove-Item -LiteralPath $file -Force
  }
}

if ($RemoveLogs -and (Test-Path -LiteralPath $InstallDir)) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host "Uninstalled Codex Chrome Operator Native Messaging host."
