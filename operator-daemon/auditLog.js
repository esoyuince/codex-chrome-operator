'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE_KEY_PATTERN = /token|secret|password|otp|recovery|cookie|authorization|bearer|cvv|card/i;
const WINDOWS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function redactValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (WINDOWS_PATH_PATTERN.test(value)) {
    const normalized = value.replace(/\\/g, '/');
    return `[REDACTED_PATH:${path.basename(normalized)}]`;
  }
  return value;
}

function redactObject(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = redactObject(entryValue, entryKey);
    }
    return result;
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  return redactValue(value);
}

class AuditLog {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(entry) {
    const redacted = redactObject(entry);
    const withTimestamp = {
      timestamp: new Date().toISOString(),
      ...redacted
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(withTimestamp)}\n`, 'utf8');
    return withTimestamp;
  }
}

module.exports = {
  redactValue,
  redactObject,
  AuditLog
};
