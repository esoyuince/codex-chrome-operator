# Codex Chrome Operator Windows Runbook

This is the Windows + Chrome closeout path for the current operator package.

## Final Gate

Run the complete M6 closeout gate before handing the package to a user:

```powershell
npm run release:m6
```

The command runs the existing release gates with clean Chrome smoke enabled,
then performs a sandbox install, sandbox doctor, sandbox uninstall, and cleanup
check in a temporary install directory.

For a faster local iteration that skips the visible Chrome clean smoke:

```powershell
npm run release:m6 -- --skip-clean-smoke
```

## Install

Install the native messaging host and copy the unpacked extension into the
default per-user install directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1
```

The installer writes:

- `%LOCALAPPDATA%\CodexChromeOperator\config.json`
- `%LOCALAPPDATA%\CodexChromeOperator\token.txt`
- `%LOCALAPPDATA%\CodexChromeOperator\com.codex.chrome_operator.json`
- `%LOCALAPPDATA%\CodexChromeOperator\extension-unpacked`
- the HKCU Chrome Native Messaging host registry key

Load `%LOCALAPPDATA%\CodexChromeOperator\extension-unpacked` from
`chrome://extensions` with Developer Mode enabled.

## Doctor

Verify the installed native host, extension id binding, token storage, ACLs, and
registry path:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\doctor.ps1
```

The doctor output is JSON. `ok: true` is the expected installed state.

## First Profile Setup

Bind and verify the Chrome profile that owns the operator session:

```powershell
npm run operator:cli -- profile-onboard
```

Use the opened setup page in Chrome, then rerun:

```powershell
npm run operator:cli -- profile-doctor
```

## First Origin

Prepare an origin and grant the optional host permission from the extension
permission page:

```powershell
npm run operator:cli -- prepare-origin https://example.com
```

After permission is granted, verify readiness:

```powershell
npm run operator:cli -- wait-ready https://example.com
```

Then run a low-risk observation:

```powershell
npm run operator:cli -- open-observe https://example.com
```

## Uninstall

Remove the native messaging host registration and installed runtime files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1
```

To remove logs and screenshots too:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1 -RemoveLogs
```
