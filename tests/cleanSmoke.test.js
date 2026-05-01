const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertPathInside,
  bindSmokeProfile,
  clickElement,
  findChromeForTesting,
  resolveSmokeConfig,
  restoreFileSnapshot,
  snapshotFile
} = require('../scripts/clean-smoke');

function readFixture(name) {
  const file = path.join(__dirname, '..', 'fixtures', name);
  assert.equal(fs.existsSync(file), true, `${name} should exist`);
  return fs.readFileSync(file, 'utf8');
}

function assertIncludesAll(content, expectedSubstrings) {
  for (const expected of expectedSubstrings) {
    assert.match(content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

test('assertPathInside accepts child paths and rejects traversal', () => {
  const root = path.join(os.tmpdir(), 'codex-smoke-root');

  assert.doesNotThrow(() => assertPathInside(root, path.join(root, 'profile')));
  assert.throws(() => assertPathInside(root, path.join(os.tmpdir(), 'elsewhere')), /outside/);
});

test('findChromeForTesting selects highest installed browser directory', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-install-'));
  const oldChrome = path.join(installDir, 'browsers', 'chrome', 'win64-1', 'chrome-win64', 'chrome.exe');
  const newChrome = path.join(installDir, 'browsers', 'chrome', 'win64-2', 'chrome-win64', 'chrome.exe');
  fs.mkdirSync(path.dirname(oldChrome), { recursive: true });
  fs.mkdirSync(path.dirname(newChrome), { recursive: true });
  fs.writeFileSync(oldChrome, '');
  fs.writeFileSync(newChrome, '');

  assert.equal(findChromeForTesting(installDir), newChrome);
});

test('resolveSmokeConfig creates deterministic clean profile and URLs', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-install-'));
  const chromePath = path.join(installDir, 'browsers', 'chrome', 'win64-9', 'chrome-win64', 'chrome.exe');
  fs.mkdirSync(path.dirname(chromePath), { recursive: true });
  fs.writeFileSync(chromePath, '');
  fs.writeFileSync(path.join(installDir, 'extension-id.txt'), 'abcdefghijklmnopabcdefghijklmnop');

  const config = resolveSmokeConfig({
    installDir,
    root: path.join(os.tmpdir(), 'repo'),
    fixturePort: 18181,
    debugPort: 9231,
    runId: 'unit'
  });

  assert.equal(config.chromeForTestingPath, chromePath);
  assert.equal(config.origin, 'http://127.0.0.1:18181');
  assert.equal(config.debugBaseUrl, 'http://127.0.0.1:9231');
  assert.equal(config.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(config.profileDir, path.join(installDir, 'clean-smoke-unit'));
});

test('clean smoke snapshots and restores operator state file', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-install-'));
  const statePath = path.join(installDir, 'state.json');
  const original = JSON.stringify({
    configuredProfile: {
      userDataDir: 'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\User Data',
      profileDirectory: 'Default',
      profileBindingId: 'profbind_live'
    }
  });
  fs.writeFileSync(statePath, original);

  const snapshot = snapshotFile(statePath);
  fs.writeFileSync(statePath, JSON.stringify({
    configuredProfile: {
      userDataDir: path.join(installDir, 'clean-smoke-unit'),
      profileDirectory: 'Default',
      profileBindingId: 'profbind_smoke'
    }
  }));

  restoreFileSnapshot(statePath, snapshot);

  assert.equal(fs.readFileSync(statePath, 'utf8'), original);
});

test('clean smoke restore removes state file when it did not previously exist', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-install-'));
  const statePath = path.join(installDir, 'state.json');

  const snapshot = snapshotFile(statePath);
  fs.writeFileSync(statePath, JSON.stringify({ configuredProfile: { profileBindingId: 'profbind_smoke' } }));

  restoreFileSnapshot(statePath, snapshot);

  assert.equal(fs.existsSync(statePath), false);
});

test('bindSmokeProfile configures the transient smoke profile without setup', () => {
  const calls = [];
  const result = bindSmokeProfile(
    {
      profileDir: 'C:\\Operator\\clean-smoke-unit'
    },
    {
      baseUrl: 'http://127.0.0.1:17391',
      token: 'cli-token'
    },
    (args, settings) => {
      calls.push({ args, settings });
      return {
        ok: true,
        result: {
          userDataDir: 'C:\\Operator\\clean-smoke-unit',
          profileDirectory: 'Default',
          profileLabel: 'Codex Clean Smoke',
          profileBindingId: 'profileless',
          profileBindingVersion: 1
        }
      };
    }
  );

  assert.deepEqual(calls, [{
    args: ['profile-bind', 'C:\\Operator\\clean-smoke-unit', 'Default', 'Codex Clean Smoke'],
    settings: {
      baseUrl: 'http://127.0.0.1:17391',
      token: 'cli-token'
    }
  }]);
  assert.equal(result.profileBindingId, 'profileless');
  assert.equal(result.profileDirectory, 'Default');
  assert.equal(result.setupUrl, undefined);
});

test('clickElement can fall back to a DOM click for fixture-only controls', async () => {
  const calls = [];
  async function send(method, params = {}) {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate' && params.expression.includes('getBoundingClientRect')) {
      return {
        result: {
          result: {
            value: { x: 10, y: 20 }
          }
        }
      };
    }
    return {};
  }

  await clickElement(send, 'completeGate', { fallbackDomClick: true });

  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 3);
  assert.equal(calls.at(-1).method, 'Runtime.evaluate');
  assert.match(calls.at(-1).params.expression, /completeGate/);
  assert.match(calls.at(-1).params.expression, /\.click\(\)/);
});

test('visual cards fixture exposes product card and analyzer hooks', () => {
  const html = readFixture('visual-cards.html');

  assertIncludesAll(html, [
    '<title>Codex Operator Visual Cards Fixture</title>',
    'id="visual-cards-fixture"',
    'data-fixture="visual-cards"',
    'data-analyzer-surface="product-cards"',
    'id="product-card-coastal-lamp"',
    'data-visual-card="product"',
    'data-product-id="sku-coastal-lamp"',
    'data-seller-id="seller-harbor-works"',
    'id="seller-rating-coastal-lamp"',
    'data-analyzer-field="seller-rating"',
    'data-rating="4.8"',
    'aria-label="Seller rating 4.8 out of 5"',
    'Analyzer hook: product-card',
    'id="validation-panel"',
    'data-validation-state="needs-review"',
    'id="validation-dialog"',
    'role="dialog"',
    'id="merchant-note-editor"',
    'contenteditable="true"',
    'data-analyzer-field="merchant-note"'
  ]);
  assert.equal((html.match(/data-visual-card="product"/g) || []).length, 3);
});

test('sensitive page fixture exposes a visual policy block marker', () => {
  const html = readFixture('sensitive-page.html');

  assertIncludesAll(html, [
    '<title>Codex Operator Sensitive Policy Fixture</title>',
    'id="sensitive-page-fixture"',
    'data-fixture="sensitive-page"',
    'id="sensitive-policy-marker"',
    'data-sensitive-page="true"',
    'data-visual-policy="block"',
    'data-analysis-policy="block"',
    'data-expected-error-code="VISUAL_PROVIDER_POLICY_BLOCKED"',
    'data-gate-type="ACCOUNT_SECURITY_REAUTH_REQUIRED"',
    'role="alert"',
    'Sensitive action',
    'account security'
  ]);
});

test('mock Play Console fixture exposes upload targets and release controls', () => {
  const html = readFixture('mock-play-console.html');

  assertIncludesAll(html, [
    '<title>Codex Operator Mock Play Console Fixture</title>',
    'id="mock-play-console-fixture"',
    'data-fixture="mock-play-console"',
    'id="appIconUpload"',
    'data-upload-role="playStoreAppIcon"',
    'accept="image/png"',
    'id="featureGraphicUpload"',
    'data-upload-role="playStoreFeatureGraphic"',
    'accept="image/png,image/jpeg"',
    'id="phoneScreenshotUpload"',
    'data-upload-role="playStorePhoneScreenshot"',
    'multiple',
    'data-preview-role="playStoreAppIcon"',
    'data-preview-role="playStoreFeatureGraphic"',
    'data-preview-role="playStorePhoneScreenshot"',
    'data-validation-message="playStoreAppIcon"',
    'data-validation-message="playStoreFeatureGraphic"',
    'data-validation-message="playStorePhoneScreenshot"',
    'id="saveDraftButton"',
    'Save draft',
    'id="sendForReviewButton"',
    'data-risk="high"',
    'Send for review'
  ]);
});

test('mock commerce fixture exposes product cards, cart, and blocked checkout controls', () => {
  const html = readFixture('mock-commerce.html');

  assertIncludesAll(html, [
    '<title>Codex Operator Mock Commerce Fixture</title>',
    'id="mock-commerce-fixture"',
    'data-fixture="mock-commerce"',
    'data-commerce-search',
    'data-commerce-sort',
    'data-visual-card="product"',
    'data-product-id="mac-mini-budget-low-rating"',
    'data-product-id="mac-mini-eligible-base"',
    'data-product-id="mac-mini-pro-rated"',
    'data-product-id="mac-mini-out-of-stock"',
    'data-price="24.999 TL"',
    'data-currency="TRY"',
    'data-seller-name=',
    'data-seller-rating=',
    'data-availability=',
    'data-shipping=',
    'data-cart-action="add"',
    'data-cart-count',
    'data-detail-recheck',
    'data-risk="checkout"'
  ]);
  assert.equal((html.match(/<article[\s\S]*?data-visual-card="product"/g) || []).length, 4);
});

test('extension wires upload and cart helpers into background and content scripts', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  const contentScript = fs.readFileSync(path.join(__dirname, '..', 'extension', 'contentScript.js'), 'utf8');

  assertIncludesAll(background, [
    "importScripts('permissionOrigins.js', 'visualCapture.js', 'fileUpload.js', 'cartWorkflow.js', 'debuggerActions.js')",
    "'fileUpload.v1'",
    "'cartPreparation.v1'",
    "'actions.cdp.v1'",
    "'fileUpload.js'",
    "'cartWorkflow.js'",
    "'page.uploadFile'",
    "'page.prepareCart'",
    "type: 'content.uploadFile'",
    "type: 'content.prepareCart'"
  ]);
  assertIncludesAll(contentScript, [
    "message.type === 'content.uploadFile'",
    'globalThis.CodexFileUpload.uploadFiles',
    "message.type === 'content.prepareCart'",
    'globalThis.CodexCartWorkflow.prepareCart'
  ]);
});
