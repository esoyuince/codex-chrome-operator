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
  assert.match(html, /id="guarded-actions-toggle" type="checkbox" checked disabled/);
  assert.match(html, /id="purchase-approvals-toggle" type="checkbox" disabled/);
  assert.match(html, /Operational status/);
  assert.match(html, /Token usage/);
  assert.match(html, /Action timeline/);
  assert.match(html, /session-tabs-count/);
  assert.match(html, /last-command/);
  assert.match(html, /download-watch-status/);
  assert.match(html, /chat-watch-status/);
  assert.match(html, /audit-timeline/);
  assert.match(html, /token-total/);
  assert.match(html, /token-input/);
  assert.match(html, /token-output/);
  assert.match(js, /renderTokenUsage/);
  assert.match(js, /renderChatWatcher/);
  assert.match(js, /readAuditTimeline/);
  assert.match(js, /renderAuditTimeline/);
  assert.match(js, /operator\.audit\.timeline/);
  assert.match(js, /SIDEPANEL_RPC_TIMEOUT_MS/);
  assert.match(js, /SIDEPANEL_NATIVE_TIMEOUT_MS/);
  assert.match(js, /withPanelTimeout/);
  assert.match(js, /Promise\.all/);
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
        this.textContent = this.children
          .map((child) => child && child.textContent ? child.textContent : '')
          .join('');
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
              pendingApprovals: [],
              tokenUsage: {
                inputTokens: 12,
                outputTokens: 34,
                totalTokens: 46,
                commandCount: 2,
                lastMethod: 'page.observe'
              }
            }
          };
        }
        if (message.type === 'operator.approvals.list') {
          return { ok: true, result: { approvals: [] } };
        }
        if (message.type === 'operator.audit.timeline') {
          return {
            ok: true,
            result: {
              timeline: [{
                method: 'operator.runtime.tab.locator',
                result: 'ok',
                tabId: 7,
                origin: 'https://example.com',
                actionKind: 'click'
              }]
            }
          };
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
  assert.equal(elements.get('token-total').textContent, '46');
  assert.equal(elements.get('token-input').textContent, '12');
  assert.equal(elements.get('token-output').textContent, '34');
  assert.equal(elements.get('token-command-count').textContent, '2');
  assert.equal(elements.get('token-last-command').textContent, 'page.observe');
  assert.equal(elements.get('audit-timeline').children.length, 1);
  assert.match(elements.get('audit-timeline').children[0].textContent, /runtime\.tab\.locator/);
  assert.equal(
    elements.get('next-step').textContent,
    'Ready for Codex operator commands on this active origin.'
  );
});

test('side panel auto-refreshes live token metrics while visible', () => {
  const js = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.js'), 'utf8');

  assert.match(js, /AUTO_REFRESH_INTERVAL_MS/);
  assert.match(js, /setInterval\(refreshIfVisible,\s*AUTO_REFRESH_INTERVAL_MS\)/);
  assert.match(js, /document\.addEventListener\('visibilitychange',\s*refreshIfVisible\)/);
  assert.match(js, /document\.visibilityState === 'hidden'/);
});

test('side panel keeps policy toggles disabled while initial refresh is loading', () => {
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
      checked: true,
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
  const pending = new Promise(() => {});
  const chrome = {
    runtime: {
      sendMessage() {
        return pending;
      }
    },
    storage: {
      local: {
        get() {
          return pending;
        }
      }
    },
    tabs: {
      query() {
        return pending;
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

  assert.equal(elements.get('guarded-actions-toggle').disabled, true);
  assert.equal(elements.get('purchase-approvals-toggle').disabled, true);
  assert.match(elements.get('summary').textContent, /Checking Chrome operator status/);
});

test('side panel fails fast when daemon policy reads hang', async () => {
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
      checked: true,
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
  const pending = new Promise(() => {});
  const messages = [];
  const chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'operator.status') {
          return { ok: true, activeTab, connectionState: 'CONNECTED' };
        }
        if (message.type === 'operator.blockedOriginsStatus') {
          return { blockedOrigins: [], blocked: false, blockedPattern: null };
        }
        return pending;
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
    setTimeout: (callback) => {
      return setTimeout(callback, 5);
    },
    clearTimeout
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(elements.get('guarded-actions-toggle').disabled, true);
  assert.equal(elements.get('purchase-approvals-toggle').disabled, true);
  assert.equal(elements.get('permission-action').textContent, 'Unavailable');
  assert.equal(elements.get('permission-critical').textContent, 'Unavailable');
  assert.doesNotMatch(elements.get('summary').textContent, /Checking Chrome operator status/);
  assert.match(elements.get('next-step').textContent, /(failed|timed out|disconnected|unavailable)/i);
  assert.ok(messages.some((message) => message.type === 'operator.policy.status' && message.timeoutMs === 2500));
});

test('side panel keeps policy toggle failures visible', async () => {
  const vm = require('node:vm');
  const js = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.js'), 'utf8');
  const elements = new Map();
  const listeners = new Map();

  function makeElement(id) {
    return {
      id,
      children: [],
      className: '',
      dataset: {},
      disabled: false,
      checked: true,
      innerHTML: '',
      textContent: '',
      value: '',
      append(...children) {
        this.children.push(...children);
      },
      addEventListener(type, handler) {
        listeners.set(`${id}:${type}`, handler);
      },
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
              pendingApprovals: [],
              policy: { guardedActionsEnabled: true, purchaseApprovalsEnabled: false }
            }
          };
        }
        if (message.type === 'operator.approvals.list') {
          return { ok: true, result: { approvals: [] } };
        }
        if (message.type === 'operator.policy.status') {
          return {
            ok: true,
            result: { policy: { guardedActionsEnabled: true, purchaseApprovalsEnabled: false } }
          };
        }
        if (message.type === 'operator.policy.update') {
          return {
            ok: false,
            error: { code: 'UNKNOWN_METHOD', message: 'Unknown method: operator.policy.update' }
          };
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

  elements.get('guarded-actions-toggle').checked = false;
  listeners.get('guarded-actions-toggle:change')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.get('next-step').textContent, /Policy update failed: Unknown method/);
});

test('side panel does not reuse a stale in-flight refresh after policy update', async () => {
  const vm = require('node:vm');
  const js = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.js'), 'utf8');
  const elements = new Map();
  const listeners = new Map();

  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function makeElement(id) {
    return {
      id,
      children: [],
      className: '',
      dataset: {},
      disabled: false,
      checked: true,
      innerHTML: '',
      textContent: '',
      value: '',
      append(...children) {
        this.children.push(...children);
      },
      addEventListener(type, handler) {
        listeners.set(`${id}:${type}`, handler);
      },
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
  let policy = { guardedActionsEnabled: true, purchaseApprovalsEnabled: false };
  let holdNextAuditTimeline = false;
  let heldAuditTimeline = null;
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
              pendingApprovals: [],
              policy: { ...policy }
            }
          };
        }
        if (message.type === 'operator.approvals.list') {
          return { ok: true, result: { approvals: [] } };
        }
        if (message.type === 'operator.policy.status') {
          return { ok: true, result: { policy: { ...policy } } };
        }
        if (message.type === 'operator.policy.update') {
          policy = { ...policy, guardedActionsEnabled: message.guardedActionsEnabled };
          return { ok: true, result: { policy: { ...policy } } };
        }
        if (message.type === 'operator.audit.timeline') {
          if (holdNextAuditTimeline) {
            holdNextAuditTimeline = false;
            heldAuditTimeline = deferred();
            return heldAuditTimeline.promise;
          }
          return { ok: true, result: { timeline: [] } };
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('guarded-actions-toggle').checked, true);

  holdNextAuditTimeline = true;
  const staleRefresh = listeners.get('refresh:click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(heldAuditTimeline, 'manual refresh should be held after reading the old policy');

  elements.get('guarded-actions-toggle').checked = false;
  listeners.get('guarded-actions-toggle:change')();
  await new Promise((resolve) => setImmediate(resolve));

  heldAuditTimeline.resolve({ ok: true, result: { timeline: [] } });
  await staleRefresh;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get('guarded-actions-toggle').checked, false);
  assert.equal(elements.get('permission-action').textContent, 'Off');
});

test('side panel disables policy toggles when policy status is unavailable', async () => {
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
      checked: true,
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
              pendingApprovals: [],
              policy: { guardedActionsEnabled: true, purchaseApprovalsEnabled: false }
            }
          };
        }
        if (message.type === 'operator.approvals.list') {
          return { ok: true, result: { approvals: [] } };
        }
        if (message.type === 'operator.policy.status') {
          return {
            ok: false,
            error: { code: 'UNKNOWN_METHOD', message: 'Unknown method: operator.policy.status' }
          };
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

  assert.equal(elements.get('guarded-actions-toggle').disabled, true);
  assert.equal(elements.get('purchase-approvals-toggle').disabled, true);
  assert.equal(elements.get('guarded-actions-toggle').checked, true);
  assert.equal(elements.get('permission-action').textContent, 'Unavailable');
  assert.equal(elements.get('permission-critical').textContent, 'Unavailable');
  assert.match(elements.get('next-step').textContent, /Policy controls unavailable: Unknown method/);
});

test('side panel keeps global policy toggles enabled on non-web active tabs', async () => {
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
      checked: false,
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
    title: 'New Tab',
    url: 'chrome://newtab/',
    origin: 'null',
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
              pendingApprovals: [],
              policy: { guardedActionsEnabled: false, purchaseApprovalsEnabled: true }
            }
          };
        }
        if (message.type === 'operator.approvals.list') {
          return { ok: true, result: { approvals: [] } };
        }
        if (message.type === 'operator.policy.status') {
          return {
            ok: true,
            result: { policy: { guardedActionsEnabled: false, purchaseApprovalsEnabled: true } }
          };
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

  assert.equal(elements.get('guarded-actions-toggle').disabled, false);
  assert.equal(elements.get('purchase-approvals-toggle').disabled, false);
  assert.equal(elements.get('guarded-actions-toggle').checked, false);
  assert.equal(elements.get('purchase-approvals-toggle').checked, true);
  assert.equal(elements.get('permission-safe').textContent, 'Blocked');
  assert.equal(elements.get('permission-action').textContent, 'Off');
  assert.equal(elements.get('permission-critical').textContent, 'Approval');
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
  assert.match(fs.readFileSync(offscreenJsPath, 'utf8'), /SW_KEEPALIVE/);
  assert.match(fs.readFileSync(offscreenJsPath, 'utf8'), /heartbeatSequence/);

  assert.match(background, /operator\.warmSession/);
  assert.match(background, /ensureOffscreenDocument/);
  assert.match(background, /content\.batch/);
  assert.match(background, /extension\.activeTabWarmup/);
  assert.match(background, /operator\.offscreenHeartbeat/);
  assert.match(background, /lastOffscreenHeartbeat/);
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

test('background rejects active-tab actions when the queued tab lock no longer matches', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /expectedActiveTabId/);
  assert.match(background, /expectedTabId:\s*params\.expectedActiveTabId/);
  assert.match(background, /TAB_MISMATCH/);
  assert.match(background, /Active tab changed before the queued page action could dispatch/);
});

test('background bounds side panel native RPC timeouts', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /function sidePanelNativeTimeout\(message\)/);
  assert.match(background, /Math\.min\(Math\.max\(Math\.round\(value\),\s*500\),\s*NATIVE_RPC_TIMEOUT_MS\)/);
  for (const messageType of [
    'operator.daemonStatus',
    'operator.approvals.list',
    'operator.policy.status',
    'operator.audit.timeline',
    'operator.policy.update'
  ]) {
    const index = background.indexOf(`message.type === '${messageType}'`);
    assert.notEqual(index, -1, `${messageType} handler should exist`);
    assert.match(
      background.slice(index, index + 560),
      /timeoutMs:\s*sidePanelNativeTimeout\(message\)/,
      `${messageType} should pass bounded side panel timeout`
    );
  }
});

test('runtime tab navigation does not activate background session tabs', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const tabInfoStart = background.indexOf('function tabInfo(tab)');
  const tabInfoEnd = background.indexOf('function sessionTabInfo', tabInfoStart);
  const tabInfoBlock = background.slice(tabInfoStart, tabInfoEnd);
  const start = background.indexOf("if (method === 'operator.runtime.tab.goto')");
  const end = background.indexOf("if (method === 'operator.runtime.tab.observe')", start);
  const block = background.slice(start, end);

  assert.ok(tabInfoStart !== -1 && tabInfoEnd !== -1, 'tabInfo should be present');
  assert.match(tabInfoBlock, /pendingUrl:\s*tab\.pendingUrl \|\| null/);
  assert.ok(start !== -1 && end !== -1, 'runtime tab goto block should be present');
  assert.match(block, /chrome\.tabs\.update\(tab\.id,\s*\{\s*url:\s*params\.url\s*\}\)/s);
  assert.doesNotMatch(block, /active:\s*true/);
  assert.doesNotMatch(block, /\.\.\.tabInfo\(targetTab\)[\s\S]*url:\s*params\.url/);
  assert.match(block, /requestedUrl:\s*params\.url/);
});

test('background fails closed when required click verification is inconclusive', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /requireVerified/);
  assert.match(background, /ACTION_RESULT_UNVERIFIED/);
  assert.match(background, /shouldRetryPostActionVerification/);
  assert.match(background, /postActionRetryDelayMs/);
  assert.match(background, /postActionVerifyDelayMs/);
  assert.match(background, /articleTextAppearsInSnapshot/);
});

test('background waits before the first post-action verification snapshot when requested', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const start = background.indexOf('async function attachPostActionSnapshot');
  const end = background.indexOf('async function attachActionTraceCue', start);
  const block = background.slice(start, end);

  assert.ok(start !== -1 && end !== -1, 'attachPostActionSnapshot should be present');
  assert.ok(
    block.indexOf('await sleep(verifyDelayMs)') < block.indexOf("type: 'content.observe'"),
    'postActionVerifyDelayMs should delay before the first observation/verification pass'
  );
});

test('background preserves debugger runtime verification for input actions', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /runtimeVerificationForActionResponse/);
  assert.match(background, /actionResponseRuntimeVerificationMatches/);
  assert.match(background, /runtime verified/);
  assert.ok(
    background.indexOf('runtimeVerificationForActionResponse') < background.indexOf('if (params.requireVerified === true'),
    'runtime verification should be considered before required post-action failure'
  );
});

test('background verifies debugger link clicks with observed navigation targets', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  assert.match(background, /navigationHrefForTarget/);
  assert.match(background, /preActionUrl:\s*ready\.tab\.url/);
  assert.match(background, /const requestedTarget = targetForActionParams\(params\);/);
  assert.match(background, /const observedTarget = targetForActionParams\(/);
  assert.match(background, /target:\s*observedTarget/);
});

test('background forwards form fill policy to the content script', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const start = background.indexOf("if (command.method === 'page.formFillExecute')");
  const end = background.indexOf("if (command.method === 'page.visualInspectTarget')", start);
  const block = background.slice(start, end);

  assert.ok(start !== -1 && end !== -1, 'page.formFillExecute handler should be present');
  assert.match(block, /approval:\s*params\.approval/);
  assert.match(block, /policy:\s*params\.policy/);
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
  assert.match(background, /boundedChromePromise/);
  assert.match(background, /Codex Deliverables/);
  assert.match(background, /originMetadata/);
  assert.match(background, /syncSessionGroupMetadataFromChrome/);
  assert.match(background, /chrome\.tabs\.onRemoved\.addListener/);
  assert.match(background, /TAB_NOT_CLAIMABLE/);
  assert.match(background, /favIconUrl/);
  assert.match(background, /lastAccessed/);
});

test('background reports session tab close failures without marking them closed', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const start = background.indexOf("if (method === 'operator.tabs.finalize')");
  const end = background.indexOf("if (method === 'operator.session.name')", start);
  const block = background.slice(start, end);

  assert.ok(start !== -1 && end !== -1, 'operator.tabs.finalize block should be present');
  assert.match(block, /const closeFailed = \[\]/);
  assert.match(block, /closeFailed\.push/);
  assert.doesNotMatch(block, /catch\s*\{[\s\S]*closed\.push\(tabId\)/);
  assert.match(block, /result:\s*\{\s*kept,\s*closed,\s*released,\s*closeFailed\s*\}/s);
});

test('background bounds session tab creation so native RPCs do not hang indefinitely', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const helperStart = background.indexOf('async function createSessionChromeTab');
  const helperEnd = background.indexOf('async function handleSessionTabCommand', helperStart);
  const helperBlock = background.slice(helperStart, helperEnd);
  const createStart = background.indexOf("if (method === 'operator.tabs.create')");
  const createEnd = background.indexOf("if (method === 'operator.tabs.listSession')", createStart);
  const createBlock = background.slice(createStart, createEnd);

  assert.ok(helperStart !== -1 && helperEnd !== -1, 'bounded tab creation helper should be present');
  assert.match(helperBlock, /boundedChromePromise\(chrome\.tabs\.create/);
  assert.match(createBlock, /createSessionChromeTab\(\)/);
  assert.match(createBlock, /if \(!tab\)/);
  assert.match(createBlock, /TAB_CREATE_FAILED/);
});

test('background bounds session tab metadata refresh calls', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const groupStart = background.indexOf('async function tabGroupTitlesById');
  const groupEnd = background.indexOf('function userTabInfo', groupStart);
  const groupBlock = background.slice(groupStart, groupEnd);
  const syncStart = background.indexOf('async function syncSessionGroupMetadataFromChrome');
  const syncEnd = background.indexOf('async function refreshSessionTabsFromChrome', syncStart);
  const syncBlock = background.slice(syncStart, syncEnd);
  const refreshStart = background.indexOf('async function refreshSessionTabsFromChrome');
  const refreshEnd = background.indexOf('async function createSessionChromeTab', refreshStart);
  const refreshBlock = background.slice(refreshStart, refreshEnd);

  assert.match(groupBlock, /boundedChromePromise\(chrome\.tabGroups\.get/);
  assert.match(syncBlock, /boundedChromePromise\(chrome\.tabs\.get/);
  assert.match(refreshBlock, /boundedChromePromise\(chrome\.tabs\.get/);
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
  assert.match(background, /operator\.runtime\.tab\.indicator/);
  assert.match(background, /runtimeLocatorAction\.js/);
  assert.match(background, /chrome\.downloads\.search/);
  assert.match(background, /chrome\.downloads\.show/);
  assert.match(background, /chrome\.sessions\.restore/);
  assert.match(background, /chrome\.history\.search/);
  assert.match(background, /chrome\.bookmarks\.search/);
  assert.match(background, /chrome\.tabs\.move/);
  assert.match(background, /chrome\.tabs\.update/);
  assert.match(background, /chrome\.tabGroups\.update/);
  assert.match(contentScript, /content\.showTarget/);
  assert.match(contentScript, /content\.operatorIndicator/);
  assert.match(contentScript, /content\.actionTrace/);
  assert.match(background, /actionability:\s*actionResult\.actionability/);
  assert.match(background, /source:\s*Object\.keys\(resolvedTarget\)/);
  assert.match(contentScript, /codex-operator-target-cue/);
  assert.match(contentScript, /codex-operator-active-indicator/);
});

test('background forwards runtime locator policy to debugger preflight', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const start = background.indexOf("if (method === 'operator.runtime.tab.locator')");
  const end = background.indexOf("return { ok: false, error: { code: 'UNKNOWN_METHOD'", start);
  const block = background.slice(start, end);
  const helperStart = background.indexOf('async function dispatchRuntimeTabLocatorAction');
  const helperEnd = background.indexOf('async function handleRuntimeCommand', helperStart);
  const helperBlock = background.slice(helperStart, helperEnd);

  assert.ok(start !== -1 && end !== -1, 'operator.runtime.tab.locator handler should be present');
  assert.ok(helperStart !== -1 && helperEnd !== -1, 'runtime locator action helper should be present');
  assert.match(helperBlock, /approval:\s*params\.approval/);
  assert.match(helperBlock, /policy:\s*params\.policy/);
  assert.match(block, /runLocatorActionWithRetry/);
  assert.match(block, /resolveRuntimeTabLocator\(tab\.id,\s*params,\s*\{\s*includeTargetContract:\s*true\s*\}\)/);
  assert.match(helperBlock, /preflightDebuggerAction\(\{ tab \}, action,/);
});

test('background forwards batch policy to the content script', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const start = background.indexOf("if (command.method === 'page.batch')");
  const end = background.indexOf("if (command.method === 'page.visualObserve')", start);
  const block = background.slice(start, end);

  assert.ok(start !== -1 && end !== -1, 'page.batch handler should be present');
  assert.match(block, /approval:\s*params\.approval/);
  assert.match(block, /policy:\s*params\.policy/);
});

test('background forwards targetContract into debugger stale-handle recovery target', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const helperStart = background.indexOf('function targetForActionParams');
  const helperEnd = background.indexOf('async function preflightDebuggerAction', helperStart);
  const helperBlock = background.slice(helperStart, helperEnd);
  const actionStart = background.indexOf('const requestedTarget = targetForActionParams(params);');
  const actionEnd = background.indexOf('const tracedResponse = await attachActionTraceCue', actionStart);
  const actionBlock = background.slice(actionStart, actionEnd);

  assert.ok(helperStart !== -1 && helperEnd !== -1, 'targetForActionParams helper should be present');
  assert.match(helperBlock, /targetContract/);
  assert.match(helperBlock, /accessibleName/);
  assert.match(helperBlock, /dataRisk/);
  assert.match(helperBlock, /data\.risk/);
  assert.match(actionBlock, /targetForActionParams\(params\)/);
  assert.match(actionBlock, /target:\s*requestedTarget/);
});

test('background lets runtime handle locators use targetContract for stale recovery', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const helperStart = background.indexOf('async function resolveRuntimeTabLocator');
  const helperEnd = background.indexOf('async function dispatchRuntimeTabLocatorAction', helperStart);
  const helperBlock = background.slice(helperStart, helperEnd);

  assert.ok(helperStart !== -1 && helperEnd !== -1, 'runtime locator resolver should be present');
  assert.match(helperBlock, /targetForActionParams\(params\)/);
  assert.match(helperBlock, /targetContract/);
  assert.match(helperBlock, /STALE_HANDLE/);
});

test('background blocks debugger actions from a supplied high-risk target before dispatch', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const helperStart = background.indexOf('async function preflightDebuggerAction');
  const helperEnd = background.indexOf('async function handleOperatorCommand', helperStart);
  const helperBlock = background.slice(helperStart, helperEnd);

  assert.ok(helperStart !== -1 && helperEnd !== -1, 'debugger preflight helper should be present');
  assert.match(helperBlock, /requestedRisk/);
  assert.match(helperBlock, /params\.target[\s\S]*CodexActionPolicy\.classifyActionRisk/);
  assert.match(helperBlock, /requestedRisk[\s\S]*return \{ ok: false, error: requestedRisk \}/);
  assert.match(helperBlock, /effectiveRisk/);
});

test('background exposes guarded CDP commands without arbitrary runtime evaluation', () => {
  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  const debuggerActions = fs.readFileSync(path.join(EXTENSION_DIR, 'debuggerActions.js'), 'utf8');

  assert.match(background, /operator\.cdp\.execute/);
  assert.match(background, /handleCdpCommand/);
  assert.match(debuggerActions, /runCdpCommand/);
  assert.match(debuggerActions, /CDP_METHOD_NOT_ALLOWED/);
  assert.match(debuggerActions, /Page\.captureScreenshot/);
  assert.match(debuggerActions, /Page\.handleJavaScriptDialog/);
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
