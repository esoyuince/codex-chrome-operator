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

Gate handoff hints are returned for visible auth or anti-abuse gates such as
password, OTP, WebAuthn, and CAPTCHA. The hint carries the daemon
`resumePolicy`, for example `wait-and-reobserve`, and tells the caller to wait
for the user to complete the gate in Chrome before retrying with a fresh
observation.

Policy hints are returned for blockers such as `HOST_PERMISSION_REQUIRED`,
`DOMAIN_NOT_APPROVED`, profile binding errors, extension disconnects, and
emergency stop. Host permission hints include the permission page URL when the
daemon provides it and mark the step as requiring a user gesture.

Visual tools return screenshot artifact references and metadata. Raw screenshot
bytes and `dataUrl` fields are redacted before the result reaches Codex unless a
future policy explicitly allows a different handoff.

High-risk browser actions cannot be bypassed through this adapter. The operator
daemon still controls guarded mode, approval prompts, profile binding, host
permissions, audit logging, and emergency stop state.
