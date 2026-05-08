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

The adapter currently exposes 41 strict tools:

- `codex_chrome_status`
- `codex_chrome_prepare_origin`
- `codex_chrome_readiness`
- `codex_chrome_profile_doctor`
- `codex_chrome_profile_onboard`
- `codex_chrome_user_tabs`
- `codex_chrome_claim_tab`
- `codex_chrome_session_tabs`
- `codex_chrome_new_tab`
- `codex_chrome_name_session`
- `codex_chrome_finalize_tabs`
- `codex_chrome_tab_screenshot`
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
`codex_chrome_claim_tab` claims a listed tab by `tabId`,
`codex_chrome_session_tabs` lists the tabs owned by the current operator
session, `codex_chrome_new_tab` opens a blank agent-owned session tab,
`codex_chrome_name_session` labels the session, and
`codex_chrome_finalize_tabs` keeps only explicitly selected tabs as `handoff` or
`deliverable` while releasing or closing the rest.
`codex_chrome_tab_screenshot` captures an artifact-backed screenshot for a
session-owned tab through the guarded CDP path. It returns screenshot metadata
only; raw image bytes and `dataUrl` fields are redacted before reaching Codex.

Approval and rejection tools require an explicit `userDecision` argument:
`"approve"` for `codex_chrome_approval_approve` and `"reject"` for
`codex_chrome_approval_reject`. This field is checked by the adapter before the
request reaches the daemon.

`codex_chrome_read_page` routes to `page.readPage` and returns compact
accessibility-like page text with page-state handles and a caller-controlled
`maxChars` budget. It is the fast text-first read path for pages where a full DOM
observation or screenshot is unnecessary.

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
surfaces.

The extension also warms the active tab with an offscreen heartbeat and a
short-lived `observe` plus compact `readPage` cache. When the daemon receives a
matching warmup from the current active tab, `page.observe` and
`page.readPage` can return from that cache after normal readiness and bounded
full-auto checks, avoiding an extra extension round trip. The cache is summary
visible in `operator.status`, expires quickly, and is invalidated when the
active tab URL changes.

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
