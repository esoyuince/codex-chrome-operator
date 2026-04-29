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

Visual tools return screenshot artifact references and metadata. Raw screenshot
bytes and `dataUrl` fields are redacted before the result reaches Codex unless a
future policy explicitly allows a different handoff.

High-risk browser actions cannot be bypassed through this adapter. The operator
daemon still controls guarded mode, approval prompts, profile binding, host
permissions, audit logging, and emergency stop state.
