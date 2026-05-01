param(
  [string] $ExtensionId,

  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [string] $RepoRoot,
  [switch] $SkipExtensionCopy,
  [switch] $SkipRegistry
)

$ErrorActionPreference = "Stop"

function Protect-UserOnlyPath {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer) {
    $acl = [System.IO.Directory]::GetAccessControl($item.FullName)
  } else {
    $acl = [System.IO.File]::GetAccessControl($item.FullName)
  }
  $acl.SetAccessRuleProtection($true, $false)

  foreach ($rule in @($acl.Access)) {
    [void] $acl.RemoveAccessRuleSpecific($rule)
  }

  $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) {
    $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }

  $accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity.User,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritanceFlags,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($accessRule)
  if ($item.PSIsContainer) {
    [System.IO.Directory]::SetAccessControl($item.FullName, $acl)
  } else {
    [System.IO.File]::SetAccessControl($item.FullName, $acl)
  }
}

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "audit") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "screenshots") | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 24) {
  throw "Node.js 24 or newer is required. Found: $nodeVersion"
}

$extensionIdScript = Join-Path $RepoRoot "scripts\ensure-extension-key.js"
if (-not (Test-Path -LiteralPath $extensionIdScript)) {
  throw "Extension id script not found: $extensionIdScript"
}

$manifestExtensionId = (& $node $extensionIdScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not ($manifestExtensionId -match "^[a-p]{32}$")) {
  throw "Could not derive Chrome extension id from extension manifest."
}

if ($ExtensionId) {
  if (-not ($ExtensionId -match "^[a-p]{32}$")) {
    throw "ExtensionId must be the 32-character Chrome extension id."
  }
  if ($ExtensionId -ne $manifestExtensionId) {
    throw "ExtensionId $ExtensionId does not match manifest-derived extension id $manifestExtensionId."
  }
} else {
  $ExtensionId = $manifestExtensionId
}

$bridgeScript = Join-Path $RepoRoot "native-bridge\nativeMessagingShim.js"
$launcher = Join-Path $InstallDir "codex-chrome-operator-native-bridge.cmd"
$manifestPath = Join-Path $InstallDir "com.codex.chrome_operator.json"
$tokenPath = Join-Path $InstallDir "token.txt"
$configPath = Join-Path $InstallDir "config.json"
$extensionTarget = Join-Path $InstallDir "extension-unpacked"
$extensionIdPath = Join-Path $InstallDir "extension-id.txt"

if (-not (Test-Path -LiteralPath $bridgeScript)) {
  throw "Native bridge script not found: $bridgeScript"
}

if (-not (Test-Path -LiteralPath $tokenPath)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
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

$config = [ordered]@{
  port = 17391
  expectedExtensionId = $ExtensionId
} | ConvertTo-Json
Set-Content -LiteralPath $configPath -Value $config -Encoding ASCII
Set-Content -LiteralPath $extensionIdPath -Value $ExtensionId -NoNewline -Encoding ASCII

if (-not $SkipExtensionCopy) {
  $extensionSource = Join-Path $RepoRoot "extension"
  if (-not (Test-Path -LiteralPath (Join-Path $extensionSource "manifest.json"))) {
    throw "Extension manifest not found: $extensionSource"
  }

  $installFullPath = [System.IO.Path]::GetFullPath($InstallDir)
  $targetFullPath = [System.IO.Path]::GetFullPath($extensionTarget)
  if (-not $targetFullPath.StartsWith($installFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to copy extension outside install dir: $extensionTarget"
  }

  if (Test-Path -LiteralPath $extensionTarget) {
    Remove-Item -LiteralPath $extensionTarget -Recurse -Force
  }
  Copy-Item -LiteralPath $extensionSource -Destination $extensionTarget -Recurse
}

if (-not $SkipRegistry) {
  $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.chrome_operator"
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
}

$sensitivePaths = @(
  $InstallDir,
  (Join-Path $InstallDir "audit"),
  (Join-Path $InstallDir "screenshots"),
  $launcher,
  $manifestPath,
  $tokenPath,
  $configPath,
  $extensionIdPath
)
foreach ($pathToProtect in $sensitivePaths) {
  Protect-UserOnlyPath -Path $pathToProtect
}

Write-Host "Installed Codex Chrome Operator Native Messaging host."
Write-Host "Extension Id: $ExtensionId"
Write-Host "Manifest: $manifestPath"
Write-Host "Launcher: $launcher"
Write-Host "Config: $configPath"
if (-not $SkipExtensionCopy) {
  Write-Host "Unpacked Extension: $extensionTarget"
}
