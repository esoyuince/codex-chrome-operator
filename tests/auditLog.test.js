const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  redactValue,
  redactObject,
  AuditLog
} = require('../operator-daemon/auditLog');
const { SessionManager } = require('../operator-daemon/sessionManager');

test('redactValue redacts Windows file paths and sensitive strings', () => {
  assert.equal(redactValue('C:/Users/example/Desktop/icon.png'), '[REDACTED_PATH:icon.png]');
  assert.equal(redactValue('C:\\Users\\example\\Desktop\\secret.txt'), '[REDACTED_PATH:secret.txt]');
  assert.equal(
    redactValue('Copy this token once: cfut_abcdefghijklmnopqrstuvwxyz1234567890'),
    'Copy this token once: [REDACTED_TOKEN]'
  );
  assert.equal(
    redactValue('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890'),
    'Authorization: Bearer [REDACTED_TOKEN]'
  );
  assert.equal(
    redactValue('Uploaded from C:\\Users\\example\\Desktop\\secret.txt'),
    'Uploaded from [REDACTED_PATH:secret.txt]'
  );
  assert.equal(redactValue('plain text'), 'plain text');
});

test('redactObject redacts sensitive keys recursively', () => {
  const redacted = redactObject({
    token: 'abc',
    nested: {
      password: 'secret',
      filePath: 'C:/Users/example/Desktop/icon.png',
      label: 'safe'
    }
  });

  assert.deepEqual(redacted, {
    token: '[REDACTED]',
    nested: {
      password: '[REDACTED]',
      filePath: '[REDACTED_PATH:icon.png]',
      label: 'safe'
    }
  });
});

test('AuditLog appends redacted JSONL entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const audit = new AuditLog(file);

  audit.append({
    sessionId: 'sess_1',
    method: 'page.uploadFile',
    params: {
      token: 'abc',
      path: 'C:/Users/example/Desktop/icon.png'
    }
  });

  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.sessionId, 'sess_1');
  assert.equal(entry.params.token, '[REDACTED]');
  assert.equal(entry.params.path, '[REDACTED_PATH:icon.png]');
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('AuditLog.tail returns recent redacted entries in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const audit = new AuditLog(file);

  audit.append({ requestId: 'req_1', token: 'secret-1' });
  audit.append({ requestId: 'req_2', path: 'C:/Users/example/Desktop/file.txt' });
  audit.append({ requestId: 'req_3' });

  const entries = audit.tail({ limit: 2 });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].requestId, 'req_2');
  assert.equal(entries[0].path, '[REDACTED_PATH:file.txt]');
  assert.equal(entries[1].requestId, 'req_3');
});

test('AuditLog.timeline returns a redacted action timeline without raw params', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const audit = new AuditLog(file);

  audit.append({
    requestId: 'req_observe',
    sessionId: 'session_1',
    agentId: 'agent-alpha',
    connectionId: 'conn_1',
    tabId: 7,
    method: 'operator.runtime.tab.observe',
    mode: 'guarded',
    origin: 'https://example.com',
    actionKind: 'observe',
    params: {
      token: 'secret-token',
      text: 'raw private prompt'
    },
    result: 'ok'
  });
  audit.append({
    requestId: 'req_click',
    sessionId: 'session_1',
    agentId: 'agent-alpha',
    tabId: 7,
    method: 'operator.runtime.tab.locator',
    origin: 'https://example.com',
    actionKind: 'click',
    targetSummary: 'button: Publish',
    params: {
      password: 'raw secret'
    },
    result: 'error',
    errorCode: 'HIGH_RISK_BLOCKED'
  });

  const timeline = audit.timeline({ limit: 5 });

  assert.deepEqual(timeline.map((entry) => ({
    requestId: entry.requestId,
    agentId: entry.agentId,
    tabId: entry.tabId,
    method: entry.method,
    actionKind: entry.actionKind,
    result: entry.result,
    errorCode: entry.errorCode,
    targetSummary: entry.targetSummary
  })), [{
    requestId: 'req_observe',
    agentId: 'agent-alpha',
    tabId: 7,
    method: 'operator.runtime.tab.observe',
    actionKind: 'observe',
    result: 'ok',
    errorCode: undefined,
    targetSummary: undefined
  }, {
    requestId: 'req_click',
    agentId: 'agent-alpha',
    tabId: 7,
    method: 'operator.runtime.tab.locator',
    actionKind: 'click',
    result: 'error',
    errorCode: 'HIGH_RISK_BLOCKED',
    targetSummary: 'button: Publish'
  }]);
  assert.equal(JSON.stringify(timeline).includes('raw secret'), false);
  assert.equal(JSON.stringify(timeline).includes('raw private prompt'), false);
});

test('AuditLog redacts sensitive token text outside sensitive keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const audit = new AuditLog(file);

  audit.append({
    method: 'page.read',
    response: {
      visibleTextSummary: 'API token was successfully created: cfut_abcdefghijklmnopqrstuvwxyz1234567890'
    }
  });

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('cfut_abcdefghijklmnopqrstuvwxyz1234567890'), false);
  assert.equal(raw.includes('[REDACTED_TOKEN]'), true);
});

test('AuditLog.tail skips oversized legacy entries without reading entire audit file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const audit = new AuditLog(file);
  fs.writeFileSync(file, `${JSON.stringify({ requestId: 'huge', text: 'x'.repeat(2 * 1024 * 1024) })}\n`, 'utf8');
  fs.appendFileSync(file, `${JSON.stringify({ requestId: 'recent' })}\n`, 'utf8');

  const entries = audit.tail({ limit: 2 });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].requestId, '[TRUNCATED_AUDIT_ENTRY]');
  assert.equal(entries[1].requestId, 'recent');
});

test('status recentEvents omits raw sensitive params from failed page commands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-audit-'));
  const session = new SessionManager({
    auditLogPath: path.join(dir, 'audit.jsonl'),
    statePath: path.join(dir, 'state.json'),
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });

  await session.handleRpc({
    id: 'type-secret',
    method: 'page.type',
    params: {
      origin: 'https://example.com',
      handle: 'password',
      text: 'raw password text',
      filePath: 'C:/Users/example/Desktop/secret.txt'
    }
  });

  const status = session.status();
  const serialized = JSON.stringify(status.recentEvents);
  assert.match(serialized, /pageCommandFailed/);
  assert.equal(serialized.includes('raw password text'), false);
  assert.equal(serialized.includes('C:/Users/example/Desktop/secret.txt'), false);
});
