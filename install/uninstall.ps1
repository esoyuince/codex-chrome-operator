param(
  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [switch] $RemoveLogs,
  [switch] $SkipRegistry
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

function Test-PathInside {
  param(
    [string] $Parent,
    [string] $Child
  )
  $parentFullPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $childFullPath = [System.IO.Path]::GetFullPath($Child)
  return $childFullPath.StartsWith($parentFullPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeRecursiveInstallRemoval {
  param([string] $Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $leaf = Split-Path -Leaf $fullPath
  if ($leaf -notmatch '(?i)codex.*operator|operator.*codex') {
    throw "Refusing to recursively remove install dir without Codex Operator path name: $fullPath"
  }

  $markers = @(
    "com.codex.chrome_operator.json",
    "codex-chrome-operator-native-bridge.cmd",
    "token.txt",
    "config.json",
    "extension-id.txt",
    "extension-unpacked",
    "audit",
    "screenshots"
  )
  $hasMarker = $false
  foreach ($marker in $markers) {
    $markerPath = Join-Path $fullPath $marker
    if ((Test-Path -LiteralPath $markerPath) -and (Test-PathInside -Parent $fullPath -Child $markerPath)) {
      $hasMarker = $true
      break
    }
  }
  if (-not $hasMarker) {
    throw "Refusing to recursively remove install dir without Codex Operator sentinel files: $fullPath"
  }
}

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

if ($RemoveLogs -and (Test-Path -LiteralPath $InstallDir)) {
  Assert-SafeRecursiveInstallRemoval -Path $InstallDir
}

foreach ($file in @($manifestPath, $launcherPath, $tokenPath, $configPath, $extensionIdPath)) {
  if (Test-Path -LiteralPath $file) {
    Remove-Item -LiteralPath $file -Force
  }
}

if (Test-Path -LiteralPath $extensionTarget) {
  if (-not (Test-PathInside -Parent $InstallDir -Child $extensionTarget)) {
    throw "Refusing to remove extension outside install dir: $extensionTarget"
  }
  Remove-Item -LiteralPath $extensionTarget -Recurse -Force
}

if ($RemoveLogs -and (Test-Path -LiteralPath $InstallDir)) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host "Uninstalled Codex Chrome Operator Native Messaging host."
