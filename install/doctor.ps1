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

function Test-UserOnlyAcl {
  param([string[]] $Paths)

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $currentUserSid = $identity.User.Value
  $results = @()
  $allOk = $true

  foreach ($pathToCheck in $Paths) {
    $exists = Test-Path -LiteralPath $pathToCheck
    $protected = $false
    $unexpectedAllow = @()
    $denyRules = @()
    $currentUserFullControl = $false

    if ($exists) {
      $item = Get-Item -LiteralPath $pathToCheck
      if ($item.PSIsContainer) {
        $acl = [System.IO.Directory]::GetAccessControl($item.FullName)
      } else {
        $acl = [System.IO.File]::GetAccessControl($item.FullName)
      }
      $protected = $acl.AreAccessRulesProtected
      foreach ($rule in @($acl.Access)) {
        try {
          $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        } catch {
          $sid = $rule.IdentityReference.Value
        }
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
          $denyRules += $rule.IdentityReference.Value
          continue
        }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
          continue
        }
        if ($sid -ne $currentUserSid) {
          $unexpectedAllow += $rule.IdentityReference.Value
        } elseif (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) {
          $currentUserFullControl = $true
        }
      }
    }

    $pathOk = $exists -and $protected -and $unexpectedAllow.Count -eq 0 -and $denyRules.Count -eq 0 -and $currentUserFullControl
    if (-not $pathOk) {
      $allOk = $false
    }
    $results += [ordered]@{
      path = $pathToCheck
      exists = $exists
      protected = $protected
      currentUserFullControl = $currentUserFullControl
      denyRules = $denyRules
      unexpectedAllow = $unexpectedAllow
    }
  }

  return [ordered]@{
    ok = $allOk
    paths = $results
  }
}

function Test-TokenSecretStorage {
  param(
    [string] $Token,
    [hashtable] $Files
  )

  $leaked = @()
  if ($Token) {
    foreach ($entry in $Files.GetEnumerator()) {
      if (-not (Test-Path -LiteralPath $entry.Value)) {
        continue
      }
      $content = Get-Content -LiteralPath $entry.Value -Raw
      if ($content.Contains($Token)) {
        $leaked += $entry.Key
      }
    }
  }

  return [ordered]@{
    ok = $leaked.Count -eq 0
    leakedLocations = $leaked
  }
}

function Get-Sha256FileHash {
  param([string] $Path)

  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($stream)
    return -join ($digest | ForEach-Object { $_.ToString("x2") })
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Get-ExtensionTreeState {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{
      exists = $false
      hash = $null
      files = @{}
    }
  }

  $root = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
  $files = [ordered]@{}
  $entries = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName)) {
    $fullName = [System.IO.Path]::GetFullPath($file.FullName)
    $relative = $fullName.Substring($root.Length).TrimStart("\").Replace("\", "/")
    $hash = Get-Sha256FileHash $fullName
    $files[$relative] = $hash
    $entries += "$relative`0$hash"
  }

  $text = $entries -join "`n"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $digest = $sha.ComputeHash($bytes)
    $treeHash = -join ($digest | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
  }

  return [ordered]@{
    exists = $true
    hash = $treeHash
    files = $files
  }
}

function Compare-ExtensionTrees {
  param(
    [string] $RepoExtensionDir,
    [string] $InstalledExtensionDir
  )

  $repo = Get-ExtensionTreeState $RepoExtensionDir
  $installed = Get-ExtensionTreeState $InstalledExtensionDir

  if (-not $installed.exists) {
    return [ordered]@{
      ok = $true
      skipped = $true
      reason = "installed-extension-copy-missing"
      repoHash = $repo.hash
      installedHash = $null
      missingFiles = @()
      extraFiles = @()
      differentFiles = @()
    }
  }

  $repoNames = @($repo.files.Keys)
  $installedNames = @($installed.files.Keys)
  $missing = @($repoNames | Where-Object { -not $installed.files.Contains($_) } | Sort-Object)
  $extra = @($installedNames | Where-Object { -not $repo.files.Contains($_) } | Sort-Object)
  $different = @($repoNames | Where-Object {
    $installed.files.Contains($_) -and $installed.files[$_] -ne $repo.files[$_]
  } | Sort-Object)

  return [ordered]@{
    ok = $repo.exists -and $installed.exists -and $repo.hash -eq $installed.hash
    skipped = $false
    reason = $null
    repoHash = $repo.hash
    installedHash = $installed.hash
    missingFiles = $missing
    extraFiles = $extra
    differentFiles = $different
  }
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
  $extensionTarget = Join-Path $InstallDir "extension-unpacked"
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

  $extensionSync = Compare-ExtensionTrees (Join-Path $repoRoot "extension") $extensionTarget
  Add-Check "installedExtensionSync" $extensionSync.ok "INSTALLED_EXTENSION_SYNC" "Installed unpacked extension matches the checked-in extension tree when present." ([ordered]@{
    path = $extensionTarget
    skipped = $extensionSync.skipped
    reason = $extensionSync.reason
    repoHash = $extensionSync.repoHash
    installedHash = $extensionSync.installedHash
    missingFiles = $extensionSync.missingFiles
    extraFiles = $extensionSync.extraFiles
    differentFiles = $extensionSync.differentFiles
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

  $tokenStorage = Test-TokenSecretStorage $token @{
    config = $configPath
    nativeManifest = $manifestPath
    extensionId = $extensionIdPath
  }
  Add-Check "tokenSecretStorage" $tokenStorage.ok "TOKEN_SECRET_STORAGE" "Token is stored only in token.txt and launcher read command." ([ordered]@{
    leakedLocations = $tokenStorage.leakedLocations
  })

  $aclCheck = Test-UserOnlyAcl @(
    $InstallDir,
    (Join-Path $InstallDir "audit"),
    (Join-Path $InstallDir "screenshots"),
    $manifestPath,
    $launcherPath,
    $tokenPath,
    $configPath,
    $extensionIdPath
  )
  Add-Check "userOnlyAcl" $aclCheck.ok "USER_ONLY_ACL" "Install secrets and audit directories are protected by current-user-only ACLs." ([ordered]@{
    paths = $aclCheck.paths
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
