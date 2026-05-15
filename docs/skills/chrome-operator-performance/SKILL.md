---
name: chrome-operator-performance
description: Use, diagnose, optimize, and live-test the Codex Chrome Operator browser extension. Use when operating this extension on real browser tasks, working on the codex-chrome-operator repo, using codex_chrome_* MCP tools, checking profile binding and reload issues, debugging session tabs, stale handles, target contracts, guarded actions, action traces, tab indicators, gate detection false positives, debugger/click/type/fill/check/select reliability, DOM quiet waits, React-heavy sites, live smoke tests, performance regressions, or turning live automation findings into best-practice fixes.
---

# Chrome Operator Performance And Usage

This repo-owned skill is active for maintaining, testing, and using the Codex
Chrome Operator extension. Treat the operator as a current guarded automation
surface for this repo. When another browser tool is also available, choose
deliberately and record which layer is being tested.

## Tool Choice

- Prefer this operator for extension development, policy/approval debugging, live smoke tests, guarded actions, audit-log behavior, site-specific extractor work, and regressions reported against this repo.
- Prefer `codex_chrome_*` MCP tools when they are available. Use `tool_search` to expose missing Chrome Operator tools before falling back to `node scripts/operator-cli.js`.
- For ordinary browser tasks, use this operator when the user wants this extension exercised, guarded approvals/audit logs matter, or native/browser-plugin behavior is unreliable.
- When comparing both paths, record which layer failed: native browser tool, extension bridge, daemon policy, content script, debugger action, or site state.

## Core Workflow

Start from repo truth and installed-extension truth:

1. Check `git status --short` and preserve unrelated dirty work.
2. Check `codex_chrome_status` with compact detail, or `node scripts/operator-cli.js status` if the MCP tool is not active. Confirm `profileReady`, `profileVerified`, `extensionVersion`, `bridgeVersion`, `lastMismatch`, `activeTab`, `sessionTabs`, pending approvals, and emergency stop state.
3. When tab identity matters, work against session-owned tabs with `codex_chrome_session_tabs`, `codex_chrome_claim_tab`, `codex_chrome_tab_focus`, and tab-scoped tools. Do not rely on whichever Chrome tab is active unless the task explicitly allows it.
4. If the user reports extension reload/profile weirdness, verify the real Chrome launch command uses `--user-data-dir=<real Chrome User Data>` and `--profile-directory=Default` before judging browser behavior.
5. Install with `powershell -ExecutionPolicy Bypass -File install/install.ps1` after extension edits. Then run `install/doctor.ps1` and, for changed extension files, confirm the installed unpacked copy under `%LOCALAPPDATA%\CodexChromeOperator\extension-unpacked` contains the expected patch.
6. Ask the user to reload the unpacked Chrome extension after install. Re-check `codex_chrome_status` for a fresh connection and version match before live testing.
7. Run targeted tests before and after live validation. Prefer the narrow suite for changed surfaces, then broaden when shared operator behavior changes.

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

## Current MCP Surface

Use the MCP surface by intent, and keep payloads small:

- Status, policy, audit, and watcher diagnostics: `codex_chrome_status`, `codex_chrome_approvals_list`, policy tools, `codex_chrome_audit_timeline`, and chat watcher tools when exposed. The audit timeline is redacted local metadata and also appears in the side panel; use it for debugging flow, not for reading page content. Chat watchers are observe-only, allowlisted, session-tab leased, and dedupe unchanged unread targets.
- Session tabs: `codex_chrome_session_tabs`, `codex_chrome_claim_tab`, `codex_chrome_tab_focus`, `codex_chrome_new_tab`, `codex_chrome_finalize_tabs`, `codex_chrome_name_session`. Use tab-scoped tools for live smoke so grouped or background tabs do not confuse the run.
- Observation: `codex_chrome_tab_observe`, `codex_chrome_tab_read_page`, `codex_chrome_tab_visual_observe`, `codex_chrome_tab_visual_analyze`, and `codex_chrome_tab_visual_inspect_target`. Prefer `tiny` or `medium`, `summaryMaxChars`, `maxActionableHandles`, and targeted `read_page` filters. Use tab-scoped visual tools for session tabs; they use CDP screenshot artifacts instead of active-tab capture. Warm-cache hits are tab-scoped; still re-observe after navigation or mutation.
- Active-tab visual diagnostics: `codex_chrome_visual_observe`, `codex_chrome_visual_analyze`, and `codex_chrome_visual_inspect_target` are for CLI/internal diagnostics only. They require `expectedActiveTabId` and `diagnosticActiveTab: true`; prefer tab visual tools for all agent work.
- Narrow actions: prefer `codex_chrome_tab_locator` for handle, selector, or text-based resolve/action in session tabs. Use direct handle tools (`codex_chrome_fill`, `codex_chrome_type`, `codex_chrome_clear`, `codex_chrome_click`, `codex_chrome_focus`, `codex_chrome_check`) with a session-owned `tabId` when a fresh handle is already proven.
- Uploads: prefer `codex_chrome_tab_upload_file` for session-owned tab uploads. It validates assets in the daemon, supports the `social-media-draft` alias for JPEG/PNG screenshots, and uses a guarded CDP `DOM.setFileInputFiles` backend so native file picker focus is not part of the workflow.
- Verification: for mutating actions, use `requireVerified`, explicit `verify` conditions such as `valueEquals` or `textAppears`, `postActionSnapshot: "delta"`, and `actionTrace` labels. Report provider, verification evidence, focused element value, gates, and content script version.
- Discovery: if a needed tool is not callable in the current context, call `tool_search` for the exact `codex_chrome_*` tool before switching to CLI or another browser layer.

## Live-Test Discipline

Keep live actions low, reversible where possible, and tied to the user's stated
goal. For public, destructive, account-changing, purchase, checkout, upload, or
publish actions, draft and verify first, then require explicit action-time
authorization before the final click or submit.

Prefer this observation loop:

```powershell
codex_chrome_status detail=compact
codex_chrome_tab_locator action=resolve selector=<stable selector> tabId=<session tab>
codex_chrome_tab_locator action=clear requireVerified=true verify=valueEquals:"" tabId=<session tab>
codex_chrome_tab_locator action=type textValue=<text> requireVerified=true verify=valueEquals:<text> actionTrace=true postActionSnapshot=delta tabId=<session tab>
```

Use the CLI equivalents only when the MCP tool is unavailable:

```powershell
node scripts\operator-cli.js status
node scripts\operator-cli.js observe <origin>
node scripts\operator-cli.js visual-observe <origin> <expectedActiveTabId>
```

When handles fail, re-observe and narrow by label, role, href, stable app
attributes, target summary, and layout evidence. Never pass an empty or guessed
handle to a mutation command. For site-specific React/contenteditable issues,
read `references/live-test-findings.md` instead of loading those notes by
default.

For a reload/live smoke after extension edits, prove the whole path:

- `codex_chrome_status` shows connected, version match, no pending approvals, and the intended session-owned tab.
- Fresh resolve finds the target without stale handles. On large commerce sites, confirm the target is not falsely `occluded:true`.
- `clear`, `fill`, and `type` use `requireVerified` and explicit value checks. Include a Unicode/Turkish sample when input fidelity is the question.
- Upload tests use `codex_chrome_tab_upload_file` with a fresh file-input handle and then re-observe for the site preview; do not use OS SendKeys or native picker handoffs as success proof.
- If `type` via `chrome.debugger.Input.insertText` returns `TEXT_INSERTION_NOT_OBSERVED`, classify it as debugger/input fidelity. The current operator should attempt a bounded runtime-verified fallback; if fallback also fails, keep the action failed and patch with a regression test.
- Final cleanup leaves reversible fields empty unless the user wanted otherwise.

## Optimization Rules

Keep observation payloads small by default. Use tiny/medium observe modes for iteration and visual observe only when layout or user-visible state matters.

Patch for measured failure modes:

- Gate detectors should require real auth fields before treating incidental "sign in" text in feeds as `AUTH_REQUIRED`.
- Handle recovery should prefer unique fingerprints, then stable identity such as `data-testid`, `data-test-id`, role/type/label, and finally previous layout proximity or stable index only when the repeated-control set remains aligned.
- Debugger target matching should support stable app attributes from both top-level target fields and content summaries such as `target.data.testid`; label and `bbox` should still narrow repeated controls.
- Contenteditable/React typing should update application state, not only DOM text. If DOM text appears but a submit button stays disabled, treat it as an input-event fidelity bug.
- Preflight should not discard explicit target summaries supplied by the caller.
- Occlusion checks should use multiple hit-test points and treat wrapper or ancestor hits that contain the target as reachable, not as blockers.
- Debugger runtime verification is stronger than unchanged post-action snapshots for input actions. Preserve `text-value` and `text-inserted` verification evidence instead of overwriting it with inconclusive snapshot deltas.
- `targetContract` data should improve recovery without bloating observations. Keep contracts compact and prefer stable attributes over repeated full DOM dumps.
- `smoke:dynamic-dom` is helper-level DOM quiet coverage. For live dynamic page proof, run `smoke:clean`; it drives the dynamic fixture through Chrome, the extension, native messaging, and `operator.runtime.tab.*`.
- Fill/check/select/type hardening should remain fail-closed: a mutation is not successful unless the runtime can verify the requested value or state.
- Record/replay traces should preserve context drift signals such as `pageStateId`, visual region kinds, screenshot artifact metadata, and focus disturbance without storing raw `dataUrl` screenshot payloads.
- Local-basic visual analysis currently recognizes product cards, rating stars, prices, tables, charts, images, badges, and primary action buttons. Treat this as a local heuristic layer, not full OCR.

## Verification Set

Use changed-surface tests first. For broad operator changes, prefer the repo
scripts:

```powershell
npm test
npm run check
npm run smoke:dynamic-dom
npm run release:m1
```

For narrow investigations, run the smallest relevant `node --test` slice, then
broaden before claiming the operator is improved:

```powershell
node --test tests\contentScript.test.js tests\extensionSurface.test.js tests\debuggerActions.test.js
```

After install/restart, re-check:

- `extensionVersion` equals `bridgeVersion`
- `lastMismatch` is `null`
- `profileVerified` is `true`
- `contentScriptVersion` in live observations matches the expected package version
- Chrome command line uses configured real profile
- The live page has no unexpected gates

## Reference

Read `references/live-test-findings.md` when using or debugging X/Twitter, React contenteditable controls, stale repeated controls, false auth gates, profile/reload confusion, or public-action verification.
