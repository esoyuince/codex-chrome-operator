'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE_KEY_PATTERN = /token|secret|password|otp|recovery|cookie|authorization|bearer|cvv|card/i;
const WINDOWS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const EMBEDDED_WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'<>|]+/g;
const CLOUDFLARE_TOKEN_PATTERN = /\bcf[a-z0-9]{0,12}_[A-Za-z0-9_-]{20,}\b/g;
const BEARER_SECRET_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{20,}\b/gi;
const CURL_AUTH_HEADER_PATTERN = /(-H\s+["']Authorization:\s*Bearer\s+)[^"']+(["'])/gi;
const GENERIC_SECRET_ASSIGNMENT_PATTERN = /\b(token|api[-_ ]?key|secret)(\s*[:=]\s*)([A-Za-z0-9._~+\/=-]{16,})/gi;
const MAX_AUDIT_STRING_LENGTH = 16000;
const MAX_AUDIT_LINE_LENGTH = 1024 * 1024;
const MAX_TAIL_READ_BYTES = 8 * 1024 * 1024;

function truncateAuditString(value) {
  if (value.length <= MAX_AUDIT_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_AUDIT_STRING_LENGTH)}...[TRUNCATED ${value.length - MAX_AUDIT_STRING_LENGTH} chars]`;
}

function redactSensitiveText(value) {
  return value
    .replace(CURL_AUTH_HEADER_PATTERN, '$1[REDACTED_TOKEN]$2')
    .replace(BEARER_SECRET_PATTERN, '$1[REDACTED_TOKEN]')
    .replace(CLOUDFLARE_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(GENERIC_SECRET_ASSIGNMENT_PATTERN, '$1$2[REDACTED_TOKEN]');
}

function redactWindowsPathToken(value) {
  let pathValue = value;
  let trailing = '';
  while (/[),.;!?]$/.test(pathValue)) {
    trailing = `${pathValue.slice(-1)}${trailing}`;
    pathValue = pathValue.slice(0, -1);
  }
  const normalized = pathValue.replace(/\\/g, '/');
  return `[REDACTED_PATH:${path.basename(normalized)}]${trailing}`;
}

function redactWindowsPaths(value) {
  if (WINDOWS_PATH_PATTERN.test(value)) {
    return redactWindowsPathToken(value);
  }
  return value.replace(EMBEDDED_WINDOWS_PATH_PATTERN, redactWindowsPathToken);
}

function redactValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return truncateAuditString(redactSensitiveText(redactWindowsPaths(value)));
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

  tail({ limit = 20 } = {}) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const stat = fs.statSync(this.filePath);
    if (stat.size <= 0) {
      return [];
    }
    const bytesToRead = Math.min(stat.size, MAX_TAIL_READ_BYTES);
    const start = stat.size - bytesToRead;
    const fd = fs.openSync(this.filePath, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) {
      const firstLineBreak = text.search(/\r?\n/);
      text = firstLineBreak === -1 ? '' : text.slice(firstLineBreak + 1);
    }

    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-normalizedLimit)
      .map((line) => {
        if (line.length > MAX_AUDIT_LINE_LENGTH) {
          return {
            timestamp: null,
            requestId: '[TRUNCATED_AUDIT_ENTRY]',
            omittedBytes: line.length
          };
        }
        try {
          return JSON.parse(line);
        } catch (error) {
          return {
            timestamp: null,
            requestId: '[UNPARSEABLE_AUDIT_ENTRY]',
            error: error.message
          };
        }
      });
  }
}

module.exports = {
  redactValue,
  redactObject,
  AuditLog
};
