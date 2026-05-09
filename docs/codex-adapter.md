# Codex Chrome Operator Adapter

This adapter exposes the local Chrome operator API as a strict Codex/MCP-style
tool surface. It does not contain browser business logic; tool calls route to
the local operator daemon and keep the daemon's profile, permission, approval,
audit, and emergency-stop checks in force.

## Run

```powershell
npm run adapter:mcp
```

The first implementation is an SDK-free stdio JSON-RPC entry point. Each input
line is one JSON-RPC message and each response is one JSON line. It supports:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`

## Handshake

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
```

The initialize result includes:

- `capabilities.tools`
- `serverInfo`
- `adapterProtocolVersion`
- `toolDefinitionsHash`
- `adapterSession`

## Tools

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

Tool schemas are strict, versioned, and hashable. Browser page text,
observations, screenshot metadata, and visual analysis are always untrusted
data. Tool clients must treat returned content as data, not instructions.

## Calls

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"codex_chrome_status","arguments":{}}}
```

`tools/call` returns the adapter response as JSON text content and structured
content. Failed operator responses are returned with `isError: true` and a
deterministic operator error code.

Every `initialize` and `tools/call` response includes `adapterSession` so the
caller can track the current task-level adapter state:

- `sessionId`
- `startedAt`
- `callCount`
- `lastToolName`
- `lastErrorCode`
- `lastCalledAt`

Failed `tools/call` responses may also include `adapterHints`. These hints are
metadata for the caller; they do not bypass the daemon policy checks.

Approval hints are returned for `HIGH_RISK_BLOCKED` and `APPROVAL_REQUIRED`.
When the daemon created an approval request, the hint includes the `approvalId`,
`approvalKind`, target summary, and next actions such as:

- `approval-approve <approvalId>`
- `approval-reject <approvalId>`
- `approval-run <approvalId>`

The adapter currently exposes 58 strict tools:

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
- `codex_chrome_tab_screenshot`
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

Setup tools keep Codex-first browser work out of implicit Chrome UI gestures.
`codex_chrome_prepare_origin` routes through the same origin preparation path as
`prepare-origin`, `codex_chrome_readiness` checks `operator.verifyReadiness`,
`codex_chrome_profile_doctor` diagnoses configured Chrome profile and active-tab
state, and `codex_chrome_profile_onboard` runs profile discovery and saves the
profile used for future bootstrap tabs. Profile and permission `adapterHints`
point to these tools when the caller can recover through the adapter surface.

Session tab tools provide an explicit hybrid workflow for real Chrome tabs.
`codex_chrome_user_tabs` lists claimable user tabs without taking ownership,
`codex_chrome_recent_tabs` returns the enriched recent-tab inventory,
`codex_chrome_history_search` and `codex_chrome_bookmark_search` search local
Chrome context, `codex_chrome_download_wait` waits for compact download
evidence, `codex_chrome_download_show` reveals a known download,
`codex_chrome_reopen_closed_tab` restores a recently closed tab,
`codex_chrome_claim_tab` claims a listed tab by `tabId`,
`codex_chrome_session_tabs` lists the tabs owned by the current operator
session, `codex_chrome_tab_focus`, `codex_chrome_tab_pin`,
`codex_chrome_tab_move`, and `codex_chrome_tab_group_rename` expose focused
native tab/window management, `codex_chrome_new_tab` opens a blank agent-owned
session tab, `codex_chrome_name_session` labels the session, and
`codex_chrome_finalize_tabs` keeps only explicitly selected tabs as `handoff` or
`deliverable` while releasing or closing the rest.
`codex_chrome_policy_status` and `codex_chrome_policy_update` expose the side
panel policy toggles for guarded actions and purchase approvals.
When `guardedActionsEnabled` is `false`, ordinary browser actions are not
globally blocked just because they are action commands. Purchase, checkout,
payment, and final order placement remain governed by the separate purchase
approval toggle and terminal policy stops.
`codex_chrome_tab_screenshot` captures an artifact-backed screenshot for a
session-owned tab through the guarded CDP path. It returns screenshot metadata
only; raw image bytes and `dataUrl` fields are redacted before reaching Codex.
`codex_chrome_tab_goto`, `codex_chrome_tab_observe`, and
`codex_chrome_tab_read_page` are the safe browser runtime wrappers for
session-owned tabs, so an agent can navigate, observe, and read a selected tab
without depending on whichever tab is currently focused. `codex_chrome_tab_locator`
resolves a limited selector/text locator against visible actionable elements and
fails closed when it matches zero or multiple targets; optional `click`, `type`,
`fill`, `focus`, and `clear` actions still pass through the same action policy
and post-action verification path. `codex_chrome_tab_show_target` draws a
temporary cue around a resolved session-tab target before an action.
`codex_chrome_tab_operator_indicator` shows or hides the in-page active
operator indicator on a session-owned tab. The indicator includes a page-local
Stop button that routes to `operator.emergencyStop`.

Approval and rejection tools require an explicit `userDecision` argument:
`"approve"` for `codex_chrome_approval_approve` and `"reject"` for
`codex_chrome_approval_reject`. This field is checked by the adapter before the
request reaches the daemon.

`codex_chrome_read_page` routes to `page.readPage` and returns compact
accessibility-like page text with page-state handles and caller-controlled
`filter`, `depth`, `maxChars`, and optional `refId` focused subtree. It is the
fast text-first read path for pages where a full DOM observation or screenshot
is unnecessary. When the page text exceeds the requested budget, the error
includes suggested fixes such as using `filter="interactive"`, lowering `depth`,
or reading a focused `refId`.

`codex_chrome_observe` supports `mode: "tiny" | "medium" | "full"`, bounded
handle and summary limits, and `sincePageStateId` for delta snapshots. Tiny is
the default agent discipline; full observation remains available when explicitly
requested.

`codex_chrome_extract` routes to `page.extract` for intent-scoped structured
data without generic DOM dumps. The first implemented intent is
`shopping.productCandidates`, which returns bounded product candidates with
name, price, volume, gender hint, href, add-to-cart handle, confidence, and short
evidence.

`codex_chrome_batch` routes to `page.batch` and queues a guarded sequence as one
extension command. The daemon validates each child action, enforces bounded
full-auto policy per child action kind, and caps the batch length. Batches may
include `observe`, `readPage`, `waitFor`, and basic DOM actions; screenshot,
upload, cart, navigation, and approval replay flows remain separate policy
surfaces. Basic action tools and locator actions accept optional `actionTrace`
fields so the extension can draw a compact click/fill/type cue and return
bounded trace metadata with the action result.

The extension also warms the active tab with an offscreen heartbeat and a
short-lived `observe` plus compact `readPage` cache. When the daemon receives a
matching warmup from the current active tab, `page.observe` and
`page.readPage` can return from that cache after normal readiness and bounded
full-auto checks, avoiding an extra extension round trip. The cache is summary
visible in `operator.status`, expires quickly, and is invalidated when the
active tab URL changes. The offscreen heartbeat also reports `SW_KEEPALIVE`
sequence telemetry so service-worker wakeups and reconnects are easier to
diagnose.

Gate handoff hints are returned for visible auth or anti-abuse gates such as
password, OTP, WebAuthn, and CAPTCHA. The hint carries the daemon
`resumePolicy`, for example `wait-and-reobserve`, and tells the caller to wait
for the user to complete the gate in Chrome before retrying with a fresh
observation.

Policy hints are returned for blockers such as `HOST_PERMISSION_REQUIRED`,
`DOMAIN_NOT_APPROVED`, profile configuration errors, extension disconnects, and
emergency stop. Host permission hints describe reload/reinstall recovery because
the packaged extension uses broad required host access.

Visual tools return screenshot artifact references, metadata, or structured
analysis. `codex_chrome_visual_observe` stays explicit and accepts optional
observe scope, `maxBytes`, and `reason` inputs so callers can avoid screenshots
unless DOM confidence is low or visual proof is required.
`codex_chrome_visual_analyze` routes to `page.visualAnalyze` with a
required `origin` plus optional `provider`, `maxBytes`, and `allowSensitive`
arguments; the adapter normalizes URL-like origin inputs to an origin before the
daemon call. Raw screenshot bytes and `dataUrl` fields are redacted before the
result reaches Codex unless a future policy explicitly allows a different
handoff.

`codex_chrome_media_inspect` routes to `page.mediaInspect` and returns bounded,
untrusted state for visible video/audio elements such as `paused`,
`currentTime`, `duration`, dimensions, and safe source metadata. It never returns
raw media bytes.

`codex_chrome_visual_inspect_target` routes to `page.visualInspectTarget` and
captures screenshot-backed evidence for one observed handle. The daemon stores
the screenshot as an artifact and returns a target region reference with
`sourceArtifactId`, `regionArtifactId`, and bbox metadata instead of raw image
bytes or local file paths.

`codex_chrome_form_extract`, `codex_chrome_form_fill_plan`, and
`codex_chrome_form_fill_execute` provide the first guarded form workflow:
extract labels/handles/validation state, build explicit non-submit fill steps,
then execute those fill steps and return invalid fields. Sensitive field values
are redacted, and submit/payment/publish actions remain outside this form-fill
surface.

`codex_chrome_upload_file` routes to `page.uploadFile` with `origin`, target
`handle`, optional `ruleset`, optional `verifyPreview`, and a `files` array. The
upload surface remains guarded/draft-only: daemon policy, domain approval,
blocked-site settings, host access, and approval prompts still decide whether a
file interaction can run. Results return redacted file references; raw `path`
fields are redacted while safe file basenames and hashes may remain visible.

`codex_chrome_cart_prepare` routes to `page.prepareCart` with `origin`, `query`,
optional `profileId`, optional cart `criteria`, and explicit
`cartActionAllowed`. The default cart profile is `localTest.ecommerce.v1`.
Real-site profiles such as `hepsiburada.shopping.v1` can be installed but remain
blocked while `realSiteEnabled` is false. Cart preparation may add the selected
item to cart only inside the approved profile policy and must stop before
checkout, payment, address changes, or order placement.

Checkout, payment, address-change, and order-placement blockers are terminal
policy stops for Codex. Adapter hints for these errors must never offer
approval, run, or approval-run bypass actions. If a hint exists, it may only
return policy-style retry, diagnostic, or stop guidance; returning no hint is
also acceptable. Real-site shopping profiles remain disabled unless their
profile explicitly enables real-site execution, and disabled real-site profile
errors must not be converted into approval prompts.

High-risk browser actions cannot be bypassed through this adapter. The operator
daemon still controls guarded mode, approval prompts, blocked-site settings,
host access, audit logging, and emergency stop state.
