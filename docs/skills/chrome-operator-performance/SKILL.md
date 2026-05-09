---
name: chrome-operator-performance
description: Use, diagnose, optimize, and live-test the Codex Chrome Operator browser extension. Use when operating this extension on real browser tasks, working on the codex-chrome-operator repo, checking profile binding and reload issues, debugging stale handles, guarded actions, action traces, tab indicators, gate detection false positives, debugger/click/type reliability, React-heavy sites, live smoke tests, performance regressions, or turning live automation findings into best-practice fixes.
---

# Chrome Operator Performance And Usage

This repo-owned skill is active for maintaining, testing, and using the Codex
Chrome Operator extension. Treat the operator as a current guarded automation
surface for this repo. When another browser tool is also available, choose
deliberately and record which layer is being tested.

## Tool Choice

- Prefer this operator for extension development, policy/approval debugging, live smoke tests, guarded actions, audit-log behavior, site-specific extractor work, and regressions reported against this repo.
- For ordinary browser tasks, use this operator when the user wants this extension exercised, guarded approvals/audit logs matter, or native/browser-plugin behavior is unreliable.
- When comparing both paths, record which layer failed: native browser tool, extension bridge, daemon policy, content script, debugger action, or site state.

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

Do not turn every live-task failure into code work. First try to complete the
user's browser task with the safest available workflow. Patch this repo when the
extension behavior itself is the blocker, the failure is reproducible, or the
user asked for development work on this operator.

## Correct Extension Use

Use the extension as a guarded browser operator, not as a raw click macro:

1. Confirm `operator.status` or `codex_chrome_status` before acting: profile, active tab, versions, pending approvals, emergency stop, and target origin readiness.
2. Prefer read-only observation first: `observe`, `read_page`, or `visual_observe` only when DOM confidence is low.
3. Keep observations compact by default. Use `tiny` or `medium`; switch to `full` only when the missing handles or page structure justify it.
4. Prefer focused `readPage` follow-ups with `refId`, `filter`, `depth`, and `maxChars` instead of repeated full-page dumps.
5. Use `codex_chrome_tab_operator_indicator` when a session-owned tab should make operator activity visible on the page; its Stop button routes to emergency stop.
6. For live smoke or risky UI debugging, enable `actionTrace` on basic actions so the page shows the click/fill/type cue and the result carries bounded trace metadata.
7. Verify the target account, page, and user-visible state before mutation. On social, commerce, upload, or account settings surfaces, name the target clearly to yourself before clicking.
8. Draft before final actions. Compose text, prepare upload previews, or prepare carts, then stop before publish, purchase, checkout, destructive changes, or account changes unless the user gives explicit action-time authorization.
9. Use fresh handles for mutations. If a handle is stale or ambiguous, re-observe and narrow by label, href, role, visible text, layout, or target summary.
10. Treat tool success as provisional until the page proves it. Verify final state through a posted status URL, changed UI state, uploaded preview, cart count, or another durable page signal.
11. Clean up accidental drafts, duplicate composers, and modal leftovers after a live action.

When the task is ordinary browser operation, prefer this use sequence over
editing repo code:

```text
status/readiness -> open or observe target -> verify target -> draft action -> ask if final/public/high-impact -> execute -> re-observe -> report evidence
```

## Live-Test Discipline

Keep live actions low, reversible where possible, and tied to the user's stated
goal. For public, destructive, account-changing, purchase, checkout, upload, or
publish actions, draft and verify first, then require explicit action-time
authorization before the final click or submit.

Prefer this observation loop:

```powershell
node scripts\operator-cli.js status
node scripts\operator-cli.js navigate <url>
node scripts\operator-cli.js observe <origin>
node scripts\operator-cli.js visual-observe <origin> --max-bytes 2000000
```

When handles fail, re-observe and narrow by label, role, href, stable app
attributes, target summary, and layout evidence. Never pass an empty or guessed
handle to a mutation command. For site-specific React/contenteditable issues,
read `references/live-test-findings.md` instead of loading those notes by
default.

## Optimization Rules

Keep observation payloads small by default. Use tiny/medium observe modes for iteration and visual observe only when layout or user-visible state matters.

Patch for measured failure modes:

- Gate detectors should require real auth fields before treating incidental "sign in" text in feeds as `AUTH_REQUIRED`.
- Handle recovery should prefer unique fingerprints, then stable identity such as `data-testid`, `data-test-id`, role/type/label, and finally previous layout proximity or stable index only when the repeated-control set remains aligned.
- Debugger target matching should support stable app attributes from both top-level target fields and content summaries such as `target.data.testid`; label and `bbox` should still narrow repeated controls.
- Contenteditable/React typing should update application state, not only DOM text. If DOM text appears but a submit button stays disabled, treat it as an input-event fidelity bug.
- Preflight should not discard explicit target summaries supplied by the caller.

## Verification Set

Use changed-surface tests first. For broad operator changes, prefer the repo
scripts:

```powershell
npm test
npm run check
```

For narrow investigations, run the smallest relevant `node --test` slice, then
broaden before claiming the operator is improved:

```powershell
node --test tests\contentScript.test.js tests\extensionSurface.test.js tests\codexAdapter.test.js tests\pageReader.test.js tests\sessionTabs.test.js
```

After install/restart, re-check:

- `extensionVersion` equals `bridgeVersion`
- `lastMismatch` is `null`
- `profileVerified` is `true`
- Chrome command line uses configured real profile
- The live page has no unexpected gates

## Reference

Read `references/live-test-findings.md` when using or debugging X/Twitter, React contenteditable controls, stale repeated controls, false auth gates, profile/reload confusion, or public-action verification.
