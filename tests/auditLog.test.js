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

test('redactValue redacts Windows file paths and sensitive strings', () => {
  assert.equal(redactValue('C:/Users/example/Desktop/icon.png'), '[REDACTED_PATH:icon.png]');
  assert.equal(redactValue('C:\\Users\\example\\Desktop\\secret.txt'), '[REDACTED_PATH:secret.txt]');
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
