const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
}

function readPngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString('hex', 0, 8), '89504e470d0a1a0a');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25]
  };
}

test('manifest exposes the operator as a Chrome side panel with debugger actions', () => {
  const manifest = readManifest();

  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.action.default_title, 'Codex Operator');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

test('manifest ships Chrome extension icon assets for toolbar and store surfaces', () => {
  const manifest = readManifest();
  const expectedIcons = {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  };

  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, expectedIcons);
  assert.equal(fs.existsSync(path.join(EXTENSION_DIR, 'icons', 'operator-icon.svg')), true);

  for (const [size, relativePath] of Object.entries(expectedIcons)) {
    const filePath = path.join(EXTENSION_DIR, relativePath);
    const dimensions = readPngDimensions(filePath);
    assert.equal(dimensions.width, Number(size));
    assert.equal(dimensions.height, Number(size));
    assert.equal(dimensions.colorType, 6);
  }
});

test('extension no longer ships popup, host-permission request, or profile binding pages', () => {
  for (const file of [
    'popup.html',
    'popup.js',
    'permissionRequest.html',
    'permissionRequest.js',
    'profileSetup.html',
    'profileSetup.js'
  ]) {
    assert.equal(fs.existsSync(path.join(EXTENSION_DIR, file)), false, `${file} should be removed`);
  }
});

test('side panel exposes action permissions, purchase approval, and blocked-site settings', () => {
  const html = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.html'), 'utf8');
  const js = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.js'), 'utf8');

  assert.match(html, /Blocked sites/);
  assert.match(html, /Action permissions/);
  assert.match(html, /Place order \/ purchase/);
  assert.match(html, /pending-approvals/);
  assert.match(js, /operator\.blockedOriginsStatus/);
  assert.match(js, /operator\.daemonStatus/);
  assert.match(js, /operator\.approvals\.approve/);
  assert.match(js, /operator\.approvals\.reject/);
  assert.match(js, /operator\.approvals\.run/);
  assert.doesNotMatch(`${html}\n${js}`, /critical-permissions-toggle/);
  assert.doesNotMatch(`${html}\n${js}`, /criticalPermissionsEnabled/);
  assert.doesNotMatch(`${html}\n${js}`, /CRITICAL_APPROVAL_KINDS/);
  assert.doesNotMatch(`${html}\n${js}`, /permissionRequest/i);
  assert.doesNotMatch(`${html}\n${js}`, /profileBinding/i);
});

test('background reconnects native bridge after Chrome startup without popup interaction', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /chrome\.runtime\.onStartup\.addListener/);
  assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(background, /scheduleNativeReconnect/);
  assert.match(background, /connectNative\(\{ retryOnFailure: true \}\)/);
});

test('extension ships offscreen warm-session heartbeat and active-tab warmup wiring', () => {
  const manifest = readManifest();
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const offscreenHtmlPath = path.join(EXTENSION_DIR, 'offscreen.html');
  const offscreenJsPath = path.join(EXTENSION_DIR, 'offscreen.js');

  assert.ok(manifest.permissions.includes('offscreen'));
  assert.equal(fs.existsSync(offscreenHtmlPath), true);
  assert.equal(fs.existsSync(offscreenJsPath), true);
  assert.match(fs.readFileSync(offscreenJsPath, 'utf8'), /operator\.offscreenHeartbeat/);

  assert.match(background, /operator\.warmSession/);
  assert.match(background, /ensureOffscreenDocument/);
  assert.match(background, /content\.batch/);
  assert.match(background, /extension\.activeTabWarmup/);
  assert.match(background, /operator\.offscreenHeartbeat/);
});

test('background injects compact page reader and intent extractors before the content script', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /pageReader\.js/);
  assert.match(background, /intentExtractors\.js/);
  assert.ok(
    background.indexOf("'pageReader.js'") < background.indexOf("'contentScript.js'"),
    'pageReader.js should load before contentScript.js'
  );
  assert.ok(
    background.indexOf("'intentExtractors.js'") < background.indexOf("'contentScript.js'"),
    'intentExtractors.js should load before contentScript.js'
  );
});
