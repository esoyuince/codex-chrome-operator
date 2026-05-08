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
  assert.ok(manifest.permissions.includes('tabGroups'));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(manifest.permissions.includes('downloads.ui'));
  assert.ok(manifest.permissions.includes('history'));
  assert.ok(manifest.permissions.includes('bookmarks'));
  assert.ok(manifest.permissions.includes('sessions'));
  assert.ok(manifest.permissions.includes('favicon'));
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
  assert.match(html, /guarded-actions-toggle/);
  assert.match(html, /purchase-approvals-toggle/);
  assert.match(html, /Operational status/);
  assert.match(html, /session-tabs-count/);
  assert.match(html, /last-command/);
  assert.match(html, /download-watch-status/);
  assert.match(html, /pending-approvals/);
  assert.match(js, /operator\.blockedOriginsStatus/);
  assert.match(js, /operator\.daemonStatus/);
  assert.match(js, /operator\.policy\.status/);
  assert.match(js, /operator\.policy\.update/);
  assert.match(js, /operator\.approvals\.approve/);
  assert.match(js, /operator\.approvals\.reject/);
  assert.match(js, /operator\.approvals\.run/);
  assert.doesNotMatch(`${html}\n${js}`, /critical-permissions-toggle/);
  assert.doesNotMatch(`${html}\n${js}`, /criticalPermissionsEnabled/);
  assert.doesNotMatch(`${html}\n${js}`, /CRITICAL_APPROVAL_KINDS/);
  assert.doesNotMatch(`${html}\n${js}`, /permissionRequest/i);
  assert.doesNotMatch(`${html}\n${js}`, /profileBinding/i);
});

test('side panel treats daemon EXTENSION_CONNECTED status as connected', async () => {
  const vm = require('node:vm');
  const js = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.js'), 'utf8');
  const elements = new Map();

  function makeElement(id) {
    return {
      id,
      children: [],
      className: '',
      dataset: {},
      disabled: false,
      innerHTML: '',
      textContent: '',
      value: '',
      append(...children) {
        this.children.push(...children);
      },
      addEventListener() {},
      closest() {
        return null;
      },
      classList: {
        add: (...classes) => {
          const current = new Set(String(elements.get(id).className || '').split(/\s+/).filter(Boolean));
          for (const className of classes) {
            current.add(className);
          }
          elements.get(id).className = Array.from(current).join(' ');
        }
      }
    };
  }

  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, makeElement(id));
      }
      return elements.get(id);
    },
    createElement(tagName) {
      return makeElement(tagName);
    }
  };

  const activeTab = {
    id: 1,
    title: 'Example Domain',
    url: 'https://example.com/',
    origin: 'https://example.com',
    loadingState: 'complete'
  };
  const chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === 'operator.status') {
          return { ok: true, activeTab, connectionState: 'CONNECTED' };
        }
        if (message.type === 'operator.daemonStatus') {
          return {
            ok: true,
            result: {
              activeTab,
              connectionState: 'EXTENSION_CONNECTED',
              lastError: null,
              pendingApprovals: []
            }
          };
        }
        if (message.type === 'operator.approvals.list') {
          return { ok: true, result: { approvals: [] } };
        }
        if (message.type === 'operator.blockedOriginsStatus') {
          return { blockedOrigins: [], blocked: false, blockedPattern: null };
        }
        return { ok: true };
      }
    },
    storage: {
      local: {
        async get() {
          return {};
        }
      }
    },
    tabs: {
      async query() {
        return [];
      }
    }
  };

  vm.runInNewContext(js, {
    chrome,
    document,
    URL,
    setTimeout,
    clearTimeout
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get('status-badge').textContent, 'Ready');
  assert.equal(elements.get('permission-safe').textContent, 'Ready');
  assert.equal(
    elements.get('next-step').textContent,
    'Ready for Codex operator commands on this active origin.'
  );
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

test('background reads the real user-focused active tab before currentWindow fallback', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /lastFocusedWindow:\s*true/);
  assert.match(background, /currentWindow:\s*true/);
  assert.ok(
    background.indexOf('lastFocusedWindow: true') < background.indexOf('currentWindow: true'),
    'lastFocusedWindow should be queried before currentWindow fallback'
  );
  assert.match(background, /chrome\.windows\.onFocusChanged\.addListener/);
  assert.match(background, /window-focus-changed/);
});

test('background fails closed when required click verification is inconclusive', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /requireVerified/);
  assert.match(background, /ACTION_RESULT_UNVERIFIED/);
});

test('background verifies debugger link clicks with observed navigation targets', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /navigationHrefForTarget/);
  assert.match(background, /preActionUrl:\s*ready\.tab\.url/);
  assert.match(background, /const observedTarget = params\.target \|\|/);
  assert.match(background, /target:\s*observedTarget/);
});

test('background exposes guarded session tab commands for hybrid operator mode', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /operatorSessionTabs/);
  assert.match(background, /operator\.tabs\.listUser/);
  assert.match(background, /operator\.tabs\.claim/);
  assert.match(background, /operator\.tabs\.create/);
  assert.match(background, /operator\.tabs\.finalize/);
  assert.match(background, /operator\.session\.name/);
  assert.match(background, /isClaimableUserTab/);
  assert.match(background, /chrome\.tabs\.group/);
  assert.match(background, /Codex Deliverables/);
  assert.match(background, /TAB_NOT_CLAIMABLE/);
  assert.match(background, /favIconUrl/);
  assert.match(background, /lastAccessed/);
});

test('background exposes browser context, download wait, session recovery, and target cue handlers', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const contentScript = fs.readFileSync(path.join(EXTENSION_DIR, 'contentScript.js'), 'utf8');

  assert.match(background, /operator\.context\.recentTabs/);
  assert.match(background, /operator\.context\.historySearch/);
  assert.match(background, /operator\.context\.bookmarkSearch/);
  assert.match(background, /operator\.downloads\.wait/);
  assert.match(background, /operator\.downloads\.show/);
  assert.match(background, /operator\.sessions\.reopenClosedTab/);
  assert.match(background, /operator\.tabs\.focus/);
  assert.match(background, /operator\.tabs\.pin/);
  assert.match(background, /operator\.tabs\.move/);
  assert.match(background, /operator\.tabs\.groupRename/);
  assert.match(background, /operator\.runtime\.tab\.showTarget/);
  assert.match(background, /chrome\.downloads\.search/);
  assert.match(background, /chrome\.downloads\.show/);
  assert.match(background, /chrome\.sessions\.restore/);
  assert.match(background, /chrome\.history\.search/);
  assert.match(background, /chrome\.bookmarks\.search/);
  assert.match(background, /chrome\.tabs\.move/);
  assert.match(background, /chrome\.tabs\.update/);
  assert.match(background, /chrome\.tabGroups\.update/);
  assert.match(contentScript, /content\.showTarget/);
  assert.match(contentScript, /codex-operator-target-cue/);
});

test('background exposes guarded CDP commands without arbitrary runtime evaluation', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const debuggerActions = fs.readFileSync(path.join(EXTENSION_DIR, 'debuggerActions.js'), 'utf8');

  assert.match(background, /operator\.cdp\.execute/);
  assert.match(background, /handleCdpCommand/);
  assert.match(debuggerActions, /runCdpCommand/);
  assert.match(debuggerActions, /CDP_METHOD_NOT_ALLOWED/);
  assert.match(debuggerActions, /Page\.captureScreenshot/);
  assert.match(debuggerActions, /Page\.getLayoutMetrics/);
  assert.match(debuggerActions, /Target\.getTargets/);
});

test('background injects compact page reader and intent extractors before the content script', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /accessibilitySnapshot\.js/);
  assert.match(background, /uiGraph\.js/);
  assert.match(background, /pageReader\.js/);
  assert.match(background, /intentExtractors\.js/);
  assert.ok(
    background.indexOf("'uiGraph.js'") < background.indexOf("'contentScript.js'"),
    'uiGraph.js should load before contentScript.js'
  );
  assert.ok(
    background.indexOf("'pageReader.js'") < background.indexOf("'contentScript.js'"),
    'pageReader.js should load before contentScript.js'
  );
  assert.ok(
    background.indexOf("'intentExtractors.js'") < background.indexOf("'contentScript.js'"),
    'intentExtractors.js should load before contentScript.js'
  );
});
