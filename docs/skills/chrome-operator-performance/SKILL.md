---
name: chrome-operator-performance
description: Diagnose, optimize, and live-test Codex Chrome Operator browser automation. Use when working on the codex-chrome-operator repo, Chrome extension reload/profile binding issues, stale handles, gate detection false positives, debugger/click/type reliability, X/Twitter or other React-heavy sites, live smoke tests, performance regressions, or when asked to turn live automation findings into best-practice fixes.
---

# Chrome Operator Performance

## Core Workflow

Start from repo truth and installed-extension truth:

1. Check `git status --short` and preserve unrelated dirty work.
2. Check `node scripts/operator-cli.js status` for `configuredProfile`, `profileVerified`, `extensionVersion`, `bridgeVersion`, `lastMismatch`, `activeTab`, and pending approvals.
3. If the user reports extension reload/profile weirdness, verify the real Chrome launch command uses `--user-data-dir=<real Chrome User Data>` and `--profile-directory=Default` before judging browser behavior.
4. Install with `powershell -ExecutionPolicy Bypass -File install/install.ps1` after extension edits, then fully restart Chrome when background/content scripts must reload.
5. Run targeted tests before and after live validation. Prefer the narrow suite for changed surfaces, then broaden when shared operator behavior changes.

Use live browser evidence as a diagnostic, not only as a demo. When a live task fails, classify the failure layer before patching:

- **Profile/install layer**: wrong Chrome profile, stale unpacked extension, version mismatch, disconnected bridge.
- **Gate layer**: false `AUTH_REQUIRED`, CAPTCHA/login/OTP/webAuthn gate, sensitive visual block.
- **Handle layer**: stale pageState, repeated controls, ambiguous recovery, layout drift.
- **Debugger layer**: `chrome.debugger` target matching, click pointer dispatch, unsupported page.
- **App-state layer**: React/contenteditable state not updated even though DOM text appears changed.
- **Policy layer**: high-risk action approval, publish/checkout/payment guard.

## Live-Test Discipline

For public web actions such as posting on X, keep the action count low and relevant. Draft the text, verify the target page and account, then submit only when the control is truly enabled and the user has authorized the public action.

Prefer these observations:

```powershell
node scripts\operator-cli.js status
node scripts\operator-cli.js navigate <url>
Start-Sleep -Seconds 10
node scripts\operator-cli.js observe <origin>
node scripts\operator-cli.js visual-observe <origin> --max-bytes 2000000
```

When a CLI handle fails, retry with a fresh `observe` handle and, if needed, direct RPC with an explicit target summary. Do not assume `data-testid` alone is unique on React feeds; combine stable attributes with visible label, href, role, or bounded layout evidence.

For X reply tests, prefer the intent composer when the target tweet id is known:

```text
https://x.com/intent/post?in_reply_to=<tweet-id>&text=<urlencoded-text>
```

This avoids React/contenteditable typing drift. If X renders both a modal composer and an inline timeline composer, expect duplicate `Yanıtla` controls. A content `batch` click can report `clicked` while X ignores the untrusted programmatic event; treat that as inconclusive until the composer closes and the account-authored reply appears. After explicit user authorization, a foreground Chrome `Ctrl+Enter` OS key event is a useful fallback for the open, prefilled composer. Always verify the posted status link and watch for leftover top-level compose drafts.

## Optimization Rules

Keep observation payloads small by default. Use tiny/medium observe modes for iteration and visual observe only when layout or user-visible state matters.

Patch for measured failure modes:

- Gate detectors should require real auth fields before treating incidental "sign in" text in feeds as `AUTH_REQUIRED`.
- Handle recovery should prefer unique fingerprints, then stable layout/index only when the previous repeated-control set remains aligned.
- Debugger target matching should support stable app attributes such as `data-testid`, but label should still narrow repeated controls.
- Contenteditable/React typing should update application state, not only DOM text. If DOM text appears but a submit button stays disabled, treat it as an input-event fidelity bug.
- Preflight should not discard explicit target summaries supplied by the caller.

## Verification Set

Use changed-surface tests first:

```powershell
node --test tests\gateDetector.test.js tests\pageHandles.test.js tests\debuggerActions.test.js
```

Use broader operator safety tests before claiming improvement:

```powershell
node --test tests\controlServer.test.js tests\contentScript.test.js tests\extensionSurface.test.js tests\pageHandles.test.js tests\gateDetector.test.js tests\debuggerActions.test.js
```

After install/restart, re-check:

- `extensionVersion` equals `bridgeVersion`
- `lastMismatch` is `null`
- `profileVerified` is `true`
- Chrome command line uses configured real profile
- The live page has no unexpected gates

## Reference

Read `references/live-test-findings.md` when debugging X/Twitter, React contenteditable controls, stale repeated controls, false auth gates, or profile/reload confusion.
