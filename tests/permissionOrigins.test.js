const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasBroadHostPermission,
  permissionPatternToOrigin,
  permissionPatternsToOrigins
} = require('../extension/permissionOrigins');

test('permissionPatternToOrigin accepts exact http origins only', () => {
  assert.equal(permissionPatternToOrigin('https://example.com/*'), 'https://example.com');
  assert.equal(permissionPatternToOrigin('http://127.0.0.1:18286/*'), 'http://127.0.0.1:18286');
  assert.equal(permissionPatternToOrigin('*://example.com/*'), null);
  assert.equal(permissionPatternToOrigin('https://*.example.com/*'), null);
  assert.equal(permissionPatternToOrigin('<all_urls>'), null);
});

test('permissionPatternsToOrigins deduplicates and drops broad patterns', () => {
  assert.deepEqual(permissionPatternsToOrigins([
    'https://example.com/*',
    'https://example.com/*',
    'https://other.example/*',
    '*://broad.example/*'
  ]), [
    'https://example.com',
    'https://other.example'
  ]);
});

test('hasBroadHostPermission detects all-url grants', () => {
  assert.equal(hasBroadHostPermission(['https://example.com/*']), false);
  assert.equal(hasBroadHostPermission(['<all_urls>']), true);
});
