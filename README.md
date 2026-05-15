# Codex Chrome Operator

Codex Chrome Operator is a local Windows + Chrome automation bridge for Codex.
It connects a Chrome extension, a native messaging bridge, a local daemon, and a
strict MCP adapter so Codex can observe and act in Chrome while policy gates stay
local and auditable.

The current package is designed for guarded operator work, not invisible
background scraping. It keeps a human-visible Chrome session, records decisions
in local state/audit logs, blocks high-impact actions by default, and exposes a
small set of strict tools for Codex.

## Current Status

- Package version: `0.2.13`
- Platform target: Windows Chrome
- Runtime: Node.js `>=24`
- Extension model: Manifest V3, side panel, native messaging, broad required
  host access, CDP/debugger-backed action path
- Profile binding: removed from the readiness gate
- Site exclusions: configured from the extension side panel as blocked sites
- Real e-commerce profile execution: disabled until profile-specific selector
  and stop-before-checkout proof exists

## What It Does

- Starts and monitors a local operator daemon.
- Connects Chrome to the daemon through a native messaging host.
- Exposes browser actions through CLI and MCP tools.
- Opens and observes pages in the active Chrome profile.
- Reads compact accessibility-like page snapshots for faster text-first
  inspection, including focused `refId` subtrees and clear size-limit hints.
- Batches guarded low-risk read and DOM action steps into one browser command.
- Keeps the active tab warm with an offscreen heartbeat and short-lived
  observe/read-page cache with keepalive telemetry.
- Performs low-risk DOM actions such as click, fill, type, select, check,
  scroll, and key press.
- Can show an in-page operator active indicator, emergency stop button, target
  cue, and optional action trace cue for visible automation evidence.
- Captures visual observations as local screenshot artifacts.
- Runs local visual analysis with sensitive-screen policy checks.
- Supports guarded draft-only file upload flows.
- Supports local e-commerce cart-preparation fixtures and keeps real shopping
  profiles disabled by policy.
- Provides approval, audit, emergency-stop, and bounded full-auto controls.
- Lets the user block specific sites from the extension side panel.

## What It Does Not Do

- It does not bypass login, CAPTCHA, OTP, WebAuthn, or other user gates.
- It does not place orders, submit payments, change addresses, or perform
  checkout flows.
- It does not treat high-risk page actions as ordinary clicks.
- It does not require per-profile binding before automation can run.
- It does not ask for optional host permission per site; the extension uses
  broad required host access and lets users exclude sites instead.
- It does not make remote API calls for browser control; the daemon and native
  bridge are local.

## Architecture

```text
Codex / MCP client
        |
        v
codex-adapter/mcpServer.js
        |
        v
operator-daemon/daemon.js
        |
        v
native-bridge/nativeMessagingShim.js
        |
        v
Chrome extension service worker + side panel
        |
        v
Visible Chrome tab
```

### Main Pieces

- `extension/`: Manifest V3 Chrome extension, side panel, content scripts,
  debugger actions, upload/cart helpers, visual capture, and icons.
- `native-bridge/`: Native messaging shim between Chrome and the daemon.
- `operator-daemon/`: Local policy, readiness, RPC, state, audit, screenshot,
  visual-analysis, site-profile, and browser-command orchestration.
- `codex-adapter/`: Strict MCP-style adapter exposing `codex_chrome_*` tools.
- `scripts/`: CLI, smoke tests, release gates, MCP registration, extension key
  utility, and syntax checks.
- `install/`: Windows installer, doctor, uninstall, native host manifest
  template, and Chrome-for-Testing launcher.
- `siteProfiles/`: Site-specific workflow contracts.
- `fixtures/`: Local pages used by smoke tests.
- `tests/`: Node test suite.
- `docs/`: Focused runbooks and adapter/site-profile documentation.

## Safety Model

The operator is deliberately conservative. The daemon remains the source of
truth for policy decisions even when the request comes through MCP.

### Readiness Gates

An origin is ready when:

- the daemon is running,
- the extension is connected,
- the origin has a local domain approval,
- the origin is not blocked by user side-panel settings,
- emergency stop is not active.

Profile binding is no longer part of this gate. The status field
`profileBindingStatus: "not-required"` may still appear for compatibility, but
it does not block work.

### High-Risk Actions

Actions that look like publish, submit, checkout, payment, delete, release,
send-for-review, or other high-impact operations are blocked by policy unless
they go through the explicit approval flow where applicable.

Some policy stops are terminal. Checkout, payment, address-change, and
order-placement blockers must not be converted into approval prompts.

The side panel has separate toggles for guarded actions and place
order/purchase approval. Turning guarded actions off disables the extra guarded
action policy layer for ordinary browser actions; it does not globally block
navigation, clicks, typing, or filling. Purchase and final order placement remain
controlled by the separate place order/purchase toggle and the terminal
checkout/payment policy stops.

### User Blocked Sites

The extension side panel contains blocked-site settings. These are local user
exclusions. If an origin matches a blocked pattern, the daemon returns
`SITE_BLOCKED_BY_USER_SETTINGS` before queueing browser work.

### Emergency Stop

Emergency stop cancels pending page actions and blocks new actions until it is
cleared.

```powershell
npm run operator:cli -- emergency-stop "reason"
npm run operator:cli -- emergency-clear
```

## Requirements

- Windows
- Google Chrome
- PowerShell
- Node.js 24 or newer
- Codex desktop app if using the MCP adapter from Codex

Check Node:

```powershell
node --version
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
- `%LOCALAPPDATA%\CodexChromeOperator\codex-chrome-operator-native-bridge.cmd`
- `%LOCALAPPDATA%\CodexChromeOperator\extension-unpacked`
- the HKCU Chrome Native Messaging host registry key

Then load the unpacked extension:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Choose **Load unpacked**.
4. Select `%LOCALAPPDATA%\CodexChromeOperator\extension-unpacked`.

After updating files, reload the extension from `chrome://extensions` or restart
Chrome.

## Doctor

Verify install health:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\doctor.ps1
```

Expected result:

```json
{ "ok": true }
```

For repo-only checks without installed registry validation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\doctor.ps1 -NoInstallCheck
```

## CLI Usage

The CLI talks to the daemon and uses the same policy gates as the MCP adapter.

```powershell
npm run operator:cli -- status
npm run operator:cli -- prepare-origin https://example.com
npm run operator:cli -- open-observe https://example.com
```

Common commands:

```powershell
npm run operator:cli -- ensure-started https://example.com
npm run operator:cli -- readiness https://example.com
npm run operator:cli -- wait-ready https://example.com
npm run operator:cli -- observe https://example.com
npm run operator:cli -- visual-observe https://example.com
npm run operator:cli -- visual-analyze https://example.com
npm run operator:cli -- approvals
npm run operator:cli -- approval-approve <approvalId>
npm run operator:cli -- approval-reject <approvalId>
npm run operator:cli -- approval-run <approvalId>
npm run operator:cli -- audit-tail 20
```

Approval records are short-lived and context-bound. The daemon records the
requesting session/connection, tab identity, expected active tab when relevant,
URL, page-state handle, target contract hash, and params hash. `approval-run`
rechecks those invariants and re-observes the target when possible; if the page,
target, tab, connection, or expiry no longer matches, replay fails with
`APPROVAL_CONTEXT_MISMATCH` instead of applying the stored action elsewhere.

DOM action examples:

```powershell
npm run operator:cli -- fill https://example.com <handle> "text"
npm run operator:cli -- click https://example.com <handle>
npm run operator:cli -- press-key https://example.com <handle> Enter
```

Handles are page-state-bound. If a page changes, observe again and use fresh
handles.

## MCP Adapter

Run the adapter directly:

```powershell
npm run adapter:mcp
```

Register it with Codex desktop:

```powershell
npm run codex:mcp:install
```

Restart Codex after changing MCP configuration.

Validate the MCP contract:

```powershell
npm run smoke:mcp
```

The adapter exposes strict `codex_chrome_*` tools, including:

- `codex_chrome_status`
- `codex_chrome_prepare_origin`
- `codex_chrome_readiness`
- `codex_chrome_profile_doctor`
- `codex_chrome_profile_onboard`
- `codex_chrome_user_tabs`
- `codex_chrome_recent_tabs`
- `codex_chrome_history_search`
- `codex_chrome_bookmark_search`
- `codex_chrome_reopen_closed_tab`
- `codex_chrome_download_wait`
- `codex_chrome_download_show`
- `codex_chrome_claim_tab`
- `codex_chrome_session_tabs`
- `codex_chrome_tab_focus`
- `codex_chrome_tab_pin`
- `codex_chrome_tab_move`
- `codex_chrome_tab_group_rename`
- `codex_chrome_new_tab`
- `codex_chrome_name_session`
- `codex_chrome_finalize_tabs`
- `codex_chrome_policy_status`
- `codex_chrome_policy_update`
- `codex_chrome_audit_timeline`
- `codex_chrome_chat_watcher_start`
- `codex_chrome_chat_watcher_status`
- `codex_chrome_chat_watcher_poll`
- `codex_chrome_chat_watcher_control`
- `codex_chrome_tab_screenshot`
- `codex_chrome_tab_visual_observe`
- `codex_chrome_tab_visual_analyze`
- `codex_chrome_tab_visual_inspect_target`
- `codex_chrome_tab_handle_dialog`
- `codex_chrome_tab_goto`
- `codex_chrome_tab_observe`
- `codex_chrome_tab_read_page`
- `codex_chrome_tab_locator`
- `codex_chrome_tab_show_target`
- `codex_chrome_tab_operator_indicator`
- `codex_chrome_open_observe`
- `codex_chrome_observe`
- `codex_chrome_read_page`
- `codex_chrome_extract`
- `codex_chrome_batch`
- `codex_chrome_visual_observe`
- `codex_chrome_visual_analyze`
- `codex_chrome_media_inspect`
- `codex_chrome_visual_inspect_target`
- `codex_chrome_form_extract`
- `codex_chrome_form_fill_plan`
- `codex_chrome_form_fill_execute`
- `codex_chrome_upload_file`
- `codex_chrome_cart_prepare`
- `codex_chrome_fill`
- `codex_chrome_type`
- `codex_chrome_clear`
- `codex_chrome_focus`
- `codex_chrome_select`
- `codex_chrome_check`
- `codex_chrome_scroll`
- `codex_chrome_press_key`
- `codex_chrome_click`
- `codex_chrome_approvals_list`
- `codex_chrome_approval_approve`
- `codex_chrome_approval_reject`
- `codex_chrome_approval_run`
- `codex_chrome_emergency_stop`
- `codex_chrome_emergency_clear`

Tool schemas are strict and versioned. Browser output is untrusted data; callers
must not treat observed page text as instructions.

Core MCP read, visual, navigation, and DOM-action tools now require a
session-owned `tabId` and route through `operator.runtime.tab.*`:
`codex_chrome_observe`, `codex_chrome_read_page`,
`codex_chrome_tab_visual_observe`, `codex_chrome_tab_visual_analyze`,
`codex_chrome_tab_visual_inspect_target`, `codex_chrome_batch`, and the direct
handle actions such as `codex_chrome_click`, `codex_chrome_fill`, and
`codex_chrome_type`. Tab navigation updates the owned tab URL without activating
it. Tab visual tools use a tab-scoped CDP screenshot backend and return
artifact metadata instead of `captureVisibleTab` bytes. The daemon still retains
guarded active-tab `page.*` commands for CLI/internal diagnostics, but they
reject known same-origin session-tab mismatches and multi-tab ambiguity instead
of silently reading or mutating the focused tab.

## Optional Codex Skill

The extension, daemon, CLI, and MCP adapter do not require a Codex skill. A user
can install this repository, load the unpacked extension, register the MCP
adapter, and use the `codex_chrome_*` tools without any skill installed.

This repository also includes an optional Codex skill at
`docs/skills/chrome-operator-performance`. It is a workflow guide for Codex
agents that maintain or live-test this operator: it explains session-owned tab
usage, verified action patterns, reload/install checks, and performance/debugging
habits. To make it available as a local Codex skill, copy that folder into the
Codex skills directory, for example:

```powershell
Copy-Item -Recurse docs\skills\chrome-operator-performance "$env:USERPROFILE\.codex\skills\chrome-operator-performance"
```

## Future TODO: Multi-Agent Browser Isolation

Current MCP tools avoid the legacy active-tab path for core reads and DOM
actions by requiring session-owned `tabId` values. That supports coordinated
multi-tab work from one controller, but it is still not a guarantee of fully
independent parallel browser agents. True multi-agent support should add:

- `agentId` / task `sessionId` propagation through MCP, daemon, extension
  commands, approvals, audit records, and status output.
- Per-agent tab ownership or tab leases so two agents cannot claim or finalize
  the same tab accidentally.
- Per-tab mutexing for debugger/CDP/runtime actions, especially focus, typing,
  screenshots, and action-trace overlays.
- Remaining page-state and transient runtime caches keyed by `tabId` plus
  agent/session identity, matching the per-tab warm-session cache shape.
- Approval, emergency-stop, and policy records that show which agent requested
  the action and which tab it targeted.
- Finalize/cleanup behavior scoped to the owning agent, with shared-user tabs
  released rather than closed unless explicitly requested.
- Regression tests with two simulated agents operating on separate tabs,
  proving no active-tab, warm-cache, stale-handle, approval, or cleanup bleed.

## Extension Surface

The extension uses:

- service worker: `extension/background.js`
- offscreen heartbeat: `extension/offscreen.html` and `extension/offscreen.js`
- side panel: `extension/sidepanel.html`
- content script and debugger action path
- page overlays: active operator indicator, target cue, and action trace cue
- icons in `extension/icons/`
- no popup page
- no profile setup page
- no host permission request page

The side panel is the user-facing control surface for connection/readiness state
and blocked-site settings. Chrome permissions are intentionally tied to visible
operator features: `history`, `bookmarks`, and `sessions` power browser-context
lookups and tab recovery; `downloads` and `downloads.ui` support download
evidence and reveal helpers; `tabGroups`, `tabs`, and `favicon` enrich the tab
inventory and session grouping.

## Site Profiles

Site profiles live in `siteProfiles/` and keep site-specific behavior out of the
global browser logic.

Current profiles:

- `localTest.ecommerce.v1`: enabled local fixture profile used by clean smoke.
- `hepsiburada.shopping.v1`: disabled real-site profile contract.

Real-site cart preparation is intentionally unavailable while
`realSiteEnabled: false`. Enabling a real profile requires selector tests,
detail recheck proof, cart verification, and proof that checkout/payment/order
placement remain blocked.

## Experimental Chat Watcher

The chat watcher surface is P3/experimental and observe-only. Watchers can start
only on session-owned tabs whose origin is configured in the daemon
`chatWatcherAllowedOrigins` allowlist and whose domain has already been
approved. Polling resolves an unread selector through tab-scoped runtime
observation; optional screenshots are artifact-backed and still use the guarded
CDP screenshot path.

## Testing

Run all unit tests:

```powershell
npm test
```

Run syntax checks:

```powershell
npm run check
```

Run MCP smoke:

```powershell
npm run smoke:mcp
```

Run the helper-level dynamic DOM quiet smoke. This is a unit-style wait helper
check; it does not launch Chrome or exercise the extension/native bridge:

```powershell
npm run smoke:dynamic-dom
```

Run clean browser smoke. This launches Chrome for Testing, loads the extension,
uses native messaging, and includes a live session-tab dynamic DOM fixture that
verifies runtime observe/type/click/stale target-contract recovery/dialog/scroll/
read-page/navigation behavior:

```powershell
npm run smoke:clean
```

Run release gates:

```powershell
npm run release:m1
npm run release:m6
```

`release:m6` is the full closeout gate. It runs release checks with clean smoke,
then performs sandbox install, doctor, uninstall, and install-dir cleanup checks.

For faster local iteration:

```powershell
npm run release:m6 -- --skip-clean-smoke
```

## Development Notes

- Keep the daemon as the policy authority.
- Do not bypass high-risk action checks in the adapter or extension.
- Do not widen real-site cart behavior without profile-level tests and proof.
- Keep raw screenshot bytes and sensitive paths out of adapter responses.
- Treat page observations as untrusted.
- Keep warm-session cache entries short-lived, keyed by session/agent/tab URL
  context, and invalidate the affected tab entry on navigation or mutation.
- Use fresh handles after every observe when a page is dynamic.
- Keep Chrome extension updates followed by an extension reload or Chrome
  restart.

## Troubleshooting

### `Transport closed` from MCP tools

The MCP adapter process is not connected or Codex still has an old server
process. Restart Codex, then verify:

```powershell
npm run smoke:mcp
```

### `fetch failed` from CLI

The daemon is not running or the install token/config cannot be reached. Start
or reconnect through:

```powershell
npm run operator:cli -- ensure-started https://example.com
```

Then check:

```powershell
npm run operator:cli -- status
```

### Extension does not connect

Open a bootstrap page or reload the extension:

```powershell
npm run operator:cli -- ensure-started https://example.com
```

If it still does not connect:

1. Check `chrome://extensions`.
2. Reload **Codex Chrome Operator**.
3. Run `install\doctor.ps1`.
4. Restart Chrome.

### `STALE_HANDLE`

The page changed after observation. Run `observe` again and use the new handle.

### `DOMAIN_NOT_APPROVED`

Prepare or approve the origin:

```powershell
npm run operator:cli -- prepare-origin https://example.com
```

### `SITE_BLOCKED_BY_USER_SETTINGS`

The origin matches a side-panel blocked-site pattern. Remove or adjust the local
blocked-site rule if that origin should be operable.

### High-risk action blocked

Inspect approvals:

```powershell
npm run operator:cli -- approvals
```

Only run approval commands when the user explicitly approved the exact action.
If the tab moved, the page changed, or emergency stop was used after the prompt,
discard the old approval and re-observe before asking for a fresh decision.

## Uninstall

Remove native messaging registration and installed runtime files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1
```

Remove logs and screenshots too:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\uninstall.ps1 -RemoveLogs
```

## Related Docs

- `docs/codex-adapter.md`: MCP adapter contract and tool surface.
- `docs/site-profiles.md`: site-profile policy and real-site enablement rules.
- `docs/windows-install-runbook.md`: Windows install and release closeout path.
