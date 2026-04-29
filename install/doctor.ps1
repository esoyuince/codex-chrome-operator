param(
  [string] $InstallDir = "$env:LOCALAPPDATA\CodexChromeOperator",
  [switch] $NoInstallCheck,
  [switch] $NoRegistryCheck
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$script:DoctorOk = $true
$checks = [ordered]@{}

function Add-Check {
  param(
    [string] $Name,
    [bool] $Ok,
    [string] $Code,
    [string] $Message,
    $Details = $null
  )

  $entry = [ordered]@{
    ok = $Ok
    code = $Code
    message = $Message
  }

  if ($null -ne $Details) {
    $entry.details = $Details
  }

  $checks[$Name] = $entry
  if (-not $Ok) {
    $script:DoctorOk = $false
  }
}

function Read-JsonFile {
  param([string] $Path)
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-DefaultRegistryValue {
  param([string] $Path)
  try {
    return (Get-Item -Path $Path -ErrorAction Stop).GetValue("")
  } catch {
    return $null
  }
}

function Same-Path {
  param([string] $Left, [string] $Right)
  if (-not $Left -or -not $Right) {
    return $false
  }

  $leftFull = [System.IO.Path]::GetFullPath($Left).TrimEnd("\")
  $rightFull = [System.IO.Path]::GetFullPath($Right).TrimEnd("\")
  return $leftFull.Equals($rightFull, [System.StringComparison]::OrdinalIgnoreCase)
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeVersion = $null
$nodeMajorOk = $false
if ($nodeCommand) {
  $nodeVersion = (& $nodeCommand.Source -p "process.versions.node").Trim()
  $nodeMajor = [int]($nodeVersion.Split(".")[0])
  $nodeMajorOk = $nodeMajor -ge 24
}
Add-Check "node" ($null -ne $nodeCommand -and $nodeMajorOk) "NODE_RUNTIME" "Node.js 24 or newer is available." ([ordered]@{
  path = if ($nodeCommand) { $nodeCommand.Source } else { $null }
  version = $nodeVersion
})

$daemonPath = Join-Path $repoRoot "operator-daemon\daemon.js"
$bridgePath = Join-Path $repoRoot "native-bridge\nativeMessagingShim.js"
$extensionManifestPath = Join-Path $repoRoot "extension\manifest.json"
$extensionIdScript = Join-Path $repoRoot "scripts\ensure-extension-key.js"

Add-Check "repoRoot" (Test-Path -LiteralPath $repoRoot) "REPO_ROOT" "Repository root is readable." ([ordered]@{ path = $repoRoot })
Add-Check "daemon" (Test-Path -LiteralPath $daemonPath) "DAEMON_FILE" "Daemon entrypoint exists." ([ordered]@{ path = $daemonPath })
Add-Check "bridge" (Test-Path -LiteralPath $bridgePath) "BRIDGE_FILE" "Native messaging bridge entrypoint exists." ([ordered]@{ path = $bridgePath })
Add-Check "extensionManifest" (Test-Path -LiteralPath $extensionManifestPath) "EXTENSION_MANIFEST" "Extension manifest exists." ([ordered]@{ path = $extensionManifestPath })

$expectedExtensionId = $null
if ($nodeCommand -and (Test-Path -LiteralPath $extensionIdScript)) {
  $expectedExtensionId = (& $nodeCommand.Source $extensionIdScript --no-write).Trim()
}
Add-Check "manifestExtensionId" ($expectedExtensionId -match "^[a-p]{32}$") "EXTENSION_ID_DERIVED" "Extension id is derived from the manifest key." ([ordered]@{
  extensionId = $expectedExtensionId
})

if (-not $NoInstallCheck) {
  $manifestPath = Join-Path $InstallDir "com.codex.chrome_operator.json"
  $launcherPath = Join-Path $InstallDir "codex-chrome-operator-native-bridge.cmd"
  $tokenPath = Join-Path $InstallDir "token.txt"
  $configPath = Join-Path $InstallDir "config.json"
  $extensionIdPath = Join-Path $InstallDir "extension-id.txt"
  $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.codex.chrome_operator"

  Add-Check "installDir" (Test-Path -LiteralPath $InstallDir) "INSTALL_DIR" "Install directory exists." ([ordered]@{ path = $InstallDir })

  $manifest = if (Test-Path -LiteralPath $manifestPath) { Read-JsonFile $manifestPath } else { $null }
  [object[]]$manifestAllowedOrigins = if ($manifest) { @($manifest.allowed_origins) } else { @() }
  $manifestExpectedOrigin = if ($expectedExtensionId) { "chrome-extension://$expectedExtensionId/" } else { $null }
  $manifestOk = $null -ne $manifest `
    -and $manifest.name -eq "com.codex.chrome_operator" `
    -and $manifest.type -eq "stdio" `
    -and [System.IO.Path]::IsPathRooted([string]$manifest.path) `
    -and (Test-Path -LiteralPath ([string]$manifest.path)) `
    -and $manifestAllowedOrigins.Count -eq 1 `
    -and $manifestAllowedOrigins[0] -eq $manifestExpectedOrigin
  Add-Check "nativeManifest" $manifestOk "NATIVE_MANIFEST" "Native messaging manifest is valid and bound to the checked-in extension id." ([ordered]@{
    path = $manifestPath
    hostPath = if ($manifest) { $manifest.path } else { $null }
    allowedOrigins = $manifestAllowedOrigins
    expectedOrigin = $manifestExpectedOrigin
  })

  $config = if (Test-Path -LiteralPath $configPath) { Read-JsonFile $configPath } else { $null }
  $configOk = $null -ne $config -and $config.expectedExtensionId -eq $expectedExtensionId
  Add-Check "configExtensionIdMatches" $configOk "CONFIG_EXTENSION_ID" "Config expectedExtensionId matches manifest-derived extension id." ([ordered]@{
    path = $configPath
    expectedExtensionId = if ($config) { $config.expectedExtensionId } else { $null }
    manifestExtensionId = $expectedExtensionId
  })

  $installedExtensionId = if (Test-Path -LiteralPath $extensionIdPath) { (Get-Content -LiteralPath $extensionIdPath -Raw).Trim() } else { $null }
  Add-Check "extensionIdFileMatches" ($installedExtensionId -eq $expectedExtensionId) "EXTENSION_ID_FILE" "Installed extension-id.txt matches manifest-derived extension id." ([ordered]@{
    path = $extensionIdPath
    installedExtensionId = $installedExtensionId
    manifestExtensionId = $expectedExtensionId
  })

  $launcherContent = if (Test-Path -LiteralPath $launcherPath) { Get-Content -LiteralPath $launcherPath -Raw } else { $null }
  $launcherOk = $null -ne $launcherContent `
    -and $launcherContent.Contains($tokenPath) `
    -and $launcherContent.Contains($bridgePath) `
    -and $launcherContent.Contains($nodeCommand.Source)
  Add-Check "launcher" $launcherOk "LAUNCHER" "Native bridge launcher points at the installed token, Node runtime, and repo bridge script." ([ordered]@{
    path = $launcherPath
    tokenPath = $tokenPath
    bridgePath = $bridgePath
    nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
  })

  $token = if (Test-Path -LiteralPath $tokenPath) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() } else { $null }
  Add-Check "token" ($null -ne $token -and $token.Length -ge 32) "TOKEN" "Native bridge token exists and is non-empty." ([ordered]@{
    path = $tokenPath
    length = if ($token) { $token.Length } else { 0 }
  })

  if (-not $NoRegistryCheck) {
    $registryValue = Get-DefaultRegistryValue $registryPath
    Add-Check "registryKey" (Test-Path -Path $registryPath) "REGISTRY_KEY" "Chrome native messaging registry key exists." ([ordered]@{ path = $registryPath })
    Add-Check "registryManifestPath" (Same-Path $registryValue $manifestPath) "REGISTRY_MANIFEST_PATH" "Registry default value points at installed native manifest." ([ordered]@{
      registryValue = $registryValue
      expectedManifestPath = $manifestPath
    })
  }
}

$failedCodes = @($checks.GetEnumerator() | Where-Object { -not $_.Value.ok } | ForEach-Object { $_.Value.code })

$report = [ordered]@{
  ok = $script:DoctorOk
  failedCodes = $failedCodes
  checks = $checks
}

$report | ConvertTo-Json -Depth 8

if (-not $script:DoctorOk) {
  exit 1
}
