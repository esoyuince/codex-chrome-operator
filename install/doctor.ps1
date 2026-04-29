param(
  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [switch] $NoInstallCheck
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$checks = [ordered]@{}

$checks.node = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
$checks.repoRoot = Test-Path -LiteralPath $repoRoot
$checks.daemon = Test-Path -LiteralPath (Join-Path $repoRoot "operator-daemon\daemon.js")
$checks.bridge = Test-Path -LiteralPath (Join-Path $repoRoot "native-bridge\nativeMessagingShim.js")
$checks.extensionManifest = Test-Path -LiteralPath (Join-Path $repoRoot "extension\manifest.json")

if (-not $NoInstallCheck) {
  $manifestPath = Join-Path $InstallDir "com.codex.chrome_operator.json"
  $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.chrome_operator"
  $checks.installDir = Test-Path -LiteralPath $InstallDir
  $checks.nativeManifest = Test-Path -LiteralPath $manifestPath
  $checks.registryKey = Test-Path -LiteralPath $registryPath
}

$failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value })

$checks | ConvertTo-Json -Depth 3

if ($failed.Count -gt 0) {
  exit 1
}
