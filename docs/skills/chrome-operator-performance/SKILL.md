---
name: chrome-operator-performance
description: Use, diagnose, optimize, and live-test the Codex Chrome Operator browser extension. Use when operating the extension on real browser tasks, working on the codex-chrome-operator repo, Chrome extension reload/profile binding issues, stale handles, gate detection false positives, debugger/click/type reliability, X/Twitter or other React-heavy sites, live smoke tests, performance regressions, or when asked to turn live automation findings into best-practice fixes.
---

# Chrome Operator Performance And Usage

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

Do not turn every live-task failure into code work. First try to complete the user's browser task with the safest available operator workflow. Patch the repo only when the extension behavior itself is the blocker, the failure is reproducible, or the user asked for development work.

## Correct Extension Use

Use the extension as a guarded browser operator, not as a raw click macro:

1. Confirm `operator.status` or `codex_chrome_status` before acting: profile, active tab, versions, pending approvals, emergency stop, and target origin readiness.
2. Prefer read-only observation first: `observe`, `read_page`, or `visual_observe` only when DOM confidence is low.
3. Keep observations compact by default. Use `tiny` or `medium`; switch to `full` only when the missing handles or page structure justify it.
4. Verify the target account, page, and user-visible state before mutation. On social, commerce, upload, or account settings surfaces, name the target clearly to yourself before clicking.
5. Draft before final actions. Compose text, prepare upload previews, or prepare carts, then stop before publish, purchase, checkout, destructive changes, or account changes unless the user gives explicit action-time authorization.
6. Use fresh handles for mutations. If a handle is stale or ambiguous, re-observe and narrow by label, href, role, visible text, layout, or target summary.
7. Treat tool success as provisional until the page proves it. Verify final state through a posted status URL, changed UI state, uploaded preview, cart count, or another durable page signal.
8. Clean up accidental drafts, duplicate composers, and modal leftovers after a live action.

When the task is ordinary browser operation, prefer this use sequence over editing repo code:

```text
status/readiness -> open or observe target -> verify target -> draft action -> ask if final/public/high-impact -> execute -> re-observe -> report evidence
```

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

When a CLI handle fails, retry with a fresh `observe` handle and, if needed, direct RPC with an explicit target summary. If the target is not in the default tiny handle window, request `mode: "full"` and a larger `maxActionableHandles`; never pass an empty or guessed handle to a mutation command. Do not assume `data-testid` alone is unique on React feeds; combine stable attributes with visible label, href, role, and bounded layout evidence such as `bbox`.

Remember that `scripts/operator-cli.js click <origin> <handle>` carries only the handle. On React-heavy pages where the handle can stale between observation and click, use direct RPC so `page.click` includes both the handle and the observed target summary:

```json
{
  "origin": "https://x.com",
  "handle": "el_<pageState>_<index>",
  "target": {
    "tag": "button",
    "role": "button",
    "type": "button",
    "label": "Yanıtla",
    "data": { "testid": "tweetButton" },
    "testid": "tweetButton",
    "bbox": { "x": 1160, "y": 885, "width": 84, "height": 36 }
  }
}
```

For X reply tests, prefer the intent composer when the target tweet id is known:

```text
https://x.com/intent/post?in_reply_to=<tweet-id>&text=<urlencoded-text>
```

This avoids React/contenteditable typing drift. If X renders both a modal composer and an inline timeline composer, expect duplicate `Yanıtla` controls. A content `batch` click can report `clicked` while X ignores the untrusted programmatic event; treat that as inconclusive until the composer closes and the account-authored reply appears. After explicit user authorization, a foreground Chrome `Ctrl+Enter` OS key event is a useful fallback for the open, prefilled composer. Always verify the posted status link and watch for leftover top-level compose drafts.

For X duplicate composers, prefer the modal submit button when using the intent composer: `data.testid`/`testid` usually equals `tweetButton`, while inline controls may be `tweetButtonInline`. If both controls share a label or test id, select by the previous observed `bbox` or layout proximity. After submit, navigate to the returned status URL or observe the page until the composer is gone; a remaining top-level `tweetTextarea_0` with an enabled `tweetButtonInline` can be a leftover standalone draft and must be cleared before reporting success.

## Optimization Rules

Keep observation payloads small by default. Use tiny/medium observe modes for iteration and visual observe only when layout or user-visible state matters.

Patch for measured failure modes:

- Gate detectors should require real auth fields before treating incidental "sign in" text in feeds as `AUTH_REQUIRED`.
- Handle recovery should prefer unique fingerprints, then stable identity such as `data-testid`, `data-test-id`, role/type/label, and finally previous layout proximity or stable index only when the repeated-control set remains aligned.
- Debugger target matching should support stable app attributes from both top-level target fields and content summaries such as `target.data.testid`; label and `bbox` should still narrow repeated controls.
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

Read `references/live-test-findings.md` when using or debugging X/Twitter, React contenteditable controls, stale repeated controls, false auth gates, profile/reload confusion, or public-action verification.
