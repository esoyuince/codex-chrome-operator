const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADAPTER_PROTOCOL_VERSION,
  CodexChromeToolAdapter,
  listTools,
  toolDefinitionsHash,
  validateToolInput
} = require('../codex-adapter/toolAdapter');

const SAVE_TARGET_CONTRACT = Object.freeze({
  version: 1,
  handle: 'el_state_0',
  tag: 'button',
  role: 'button',
  label: 'Save settings',
  accessibleName: 'Save settings',
  testid: 'save-button',
  data: { testid: 'save-button' },
  bbox: { x: 10, y: 20, width: 120, height: 32 },
  context: {
    url: 'https://example.com/form',
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0 },
    devicePixelRatio: 1
  },
  provenance: {
    shadowDepth: 1,
    frameDepth: 1,
    frameTitle: 'Checkout frame'
  }
});

test('listTools exposes strict versioned Codex browser tool definitions', () => {
  const tools = listTools();
  const openObserve = tools.find((tool) => tool.name === 'codex_chrome_open_observe');
  const observe = tools.find((tool) => tool.name === 'codex_chrome_observe');
  const status = tools.find((tool) => tool.name === 'codex_chrome_status');
  const profileOnboard = tools.find((tool) => tool.name === 'codex_chrome_profile_onboard');
  const uploadFile = tools.find((tool) => tool.name === 'codex_chrome_upload_file');
  const cartPrepare = tools.find((tool) => tool.name === 'codex_chrome_cart_prepare');
  const extract = tools.find((tool) => tool.name === 'codex_chrome_extract');
  const readPage = tools.find((tool) => tool.name === 'codex_chrome_read_page');
  const batch = tools.find((tool) => tool.name === 'codex_chrome_batch');
  const visualObserve = tools.find((tool) => tool.name === 'codex_chrome_visual_observe');
  const visualInspectTarget = tools.find((tool) => tool.name === 'codex_chrome_visual_inspect_target');
  const mediaInspect = tools.find((tool) => tool.name === 'codex_chrome_media_inspect');
  const formExtract = tools.find((tool) => tool.name === 'codex_chrome_form_extract');
  const formFillPlan = tools.find((tool) => tool.name === 'codex_chrome_form_fill_plan');
  const formFillExecute = tools.find((tool) => tool.name === 'codex_chrome_form_fill_execute');
  const userTabs = tools.find((tool) => tool.name === 'codex_chrome_user_tabs');
  const claimTab = tools.find((tool) => tool.name === 'codex_chrome_claim_tab');
  const sessionTabs = tools.find((tool) => tool.name === 'codex_chrome_session_tabs');
  const newTab = tools.find((tool) => tool.name === 'codex_chrome_new_tab');
  const nameSession = tools.find((tool) => tool.name === 'codex_chrome_name_session');
  const finalizeTabs = tools.find((tool) => tool.name === 'codex_chrome_finalize_tabs');
  const tabScreenshot = tools.find((tool) => tool.name === 'codex_chrome_tab_screenshot');
  const tabGoto = tools.find((tool) => tool.name === 'codex_chrome_tab_goto');
  const tabObserve = tools.find((tool) => tool.name === 'codex_chrome_tab_observe');
  const tabReadPage = tools.find((tool) => tool.name === 'codex_chrome_tab_read_page');
  const tabLocator = tools.find((tool) => tool.name === 'codex_chrome_tab_locator');
  const recentTabs = tools.find((tool) => tool.name === 'codex_chrome_recent_tabs');
  const historySearch = tools.find((tool) => tool.name === 'codex_chrome_history_search');
  const bookmarkSearch = tools.find((tool) => tool.name === 'codex_chrome_bookmark_search');
  const reopenClosedTab = tools.find((tool) => tool.name === 'codex_chrome_reopen_closed_tab');
  const downloadWait = tools.find((tool) => tool.name === 'codex_chrome_download_wait');
  const downloadShow = tools.find((tool) => tool.name === 'codex_chrome_download_show');
  const tabFocus = tools.find((tool) => tool.name === 'codex_chrome_tab_focus');
  const tabPin = tools.find((tool) => tool.name === 'codex_chrome_tab_pin');
  const tabMove = tools.find((tool) => tool.name === 'codex_chrome_tab_move');
  const tabGroupRename = tools.find((tool) => tool.name === 'codex_chrome_tab_group_rename');
  const policyStatus = tools.find((tool) => tool.name === 'codex_chrome_policy_status');
  const policyUpdate = tools.find((tool) => tool.name === 'codex_chrome_policy_update');
  const tabHandleDialog = tools.find((tool) => tool.name === 'codex_chrome_tab_handle_dialog');
  const tabShowTarget = tools.find((tool) => tool.name === 'codex_chrome_tab_show_target');
  const tabOperatorIndicator = tools.find((tool) => tool.name === 'codex_chrome_tab_operator_indicator');

  assert.equal(ADAPTER_PROTOCOL_VERSION, '1.0');
  assert.ok(status);
  assert.equal(status.inputSchema.type, 'object');
  assert.equal(status.inputSchema.additionalProperties, false);
  assert.deepEqual(status.inputSchema.required, []);
  assert.deepEqual(status.inputSchema.properties.detail.enum, ['compact', 'full']);
  assert.ok(openObserve);
  assert.equal(openObserve.inputSchema.type, 'object');
  assert.equal(openObserve.inputSchema.additionalProperties, false);
  assert.deepEqual(openObserve.inputSchema.required, ['url']);
  assert.deepEqual(openObserve.inputSchema.properties.mode.enum, ['tiny', 'medium', 'full']);
  assert.equal(openObserve.inputSchema.properties.maxActionableHandles.minimum, 1);
  assert.equal(openObserve.inputSchema.properties.summaryMaxChars.minimum, 1);
  assert.equal(openObserve.inputSchema.properties.sincePageStateId.type, 'string');
  assert.equal(openObserve.outputContract.untrusted, true);
  assert.ok(observe);
  assert.deepEqual(observe.inputSchema.properties.mode.enum, ['tiny', 'medium', 'full']);
  assert.equal(observe.inputSchema.properties.maxActionableHandles.minimum, 1);
  assert.equal(observe.inputSchema.properties.summaryMaxChars.minimum, 1);
  assert.equal(observe.inputSchema.properties.sincePageStateId.type, 'string');
  assert.equal(observe.inputSchema.properties.includeFormValues.type, 'boolean');
  assert.equal(observe.inputSchema.properties.maxFieldValueChars.type, 'number');
  assert.equal(observe.inputSchema.properties.includeAx.type, 'boolean');
  assert.ok(profileOnboard);
  assert.equal(profileOnboard.inputSchema.type, 'object');
  assert.equal(profileOnboard.inputSchema.additionalProperties, false);
  assert.deepEqual(profileOnboard.inputSchema.required, []);
  assert.ok(uploadFile);
  assert.equal(uploadFile.inputSchema.type, 'object');
  assert.equal(uploadFile.inputSchema.additionalProperties, false);
  assert.deepEqual(uploadFile.inputSchema.required, ['origin', 'handle', 'files']);
  assert.equal(uploadFile.inputSchema.properties.files.type, 'array');
  assert.equal(uploadFile.inputSchema.properties.ruleset.type, 'string');
  assert.equal(uploadFile.inputSchema.properties.verifyPreview.type, 'boolean');
  assert.ok(cartPrepare);
  assert.equal(cartPrepare.inputSchema.type, 'object');
  assert.equal(cartPrepare.inputSchema.additionalProperties, false);
  assert.deepEqual(cartPrepare.inputSchema.required, ['origin', 'query', 'cartActionAllowed']);
  assert.equal(cartPrepare.inputSchema.properties.criteria.additionalProperties, false);
  assert.match(cartPrepare.description, /stop before checkout\/payment/i);
  assert.equal(cartPrepare.outputContract.untrusted, true);
  assert.equal(cartPrepare.outputContract.rawScreenshotBytes, false);
  assert.ok(extract);
  assert.equal(extract.inputSchema.type, 'object');
  assert.equal(extract.inputSchema.additionalProperties, false);
  assert.deepEqual(extract.inputSchema.required, ['origin', 'intent']);
  assert.equal(extract.inputSchema.properties.origin.type, 'string');
  assert.equal(extract.inputSchema.properties.intent.type, 'string');
  assert.equal(extract.inputSchema.properties.maxCandidates.type, 'number');
  assert.equal(extract.inputSchema.properties.maxCandidates.minimum, 1);
  assert.match(extract.description, /intent-scoped/i);
  assert.ok(readPage);
  assert.deepEqual(readPage.inputSchema.required, ['origin']);
  assert.equal(readPage.inputSchema.properties.maxChars.type, 'number');
  assert.equal(readPage.inputSchema.properties.refId.type, 'string');
  assert.equal(readPage.inputSchema.properties.includeFormValues.type, 'boolean');
  assert.equal(readPage.inputSchema.properties.maxFieldValueChars.type, 'number');
  assert.ok(batch);
  assert.deepEqual(batch.inputSchema.required, ['origin', 'actions']);
  assert.equal(batch.inputSchema.properties.actions.type, 'array');
  assert.equal(batch.inputSchema.properties.actions.items.additionalProperties, false);
  assert.ok(visualObserve);
  assert.deepEqual(visualObserve.inputSchema.required, ['origin']);
  assert.equal(visualObserve.inputSchema.properties.maxBytes.minimum, 1);
  assert.deepEqual(visualObserve.inputSchema.properties.mode.enum, ['tiny', 'medium', 'full']);
  assert.equal(visualObserve.inputSchema.properties.reason.type, 'string');
  assert.match(visualObserve.description, /visual verification/i);
  assert.ok(mediaInspect);
  assert.deepEqual(mediaInspect.inputSchema.required, ['origin']);
  assert.equal(mediaInspect.inputSchema.properties.maxItems.minimum, 1);
  assert.match(mediaInspect.description, /media/i);
  assert.ok(visualInspectTarget);
  assert.deepEqual(visualInspectTarget.inputSchema.required, ['origin', 'handle']);
  assert.equal(visualInspectTarget.inputSchema.properties.maxBytes.minimum, 1);
  assert.match(visualInspectTarget.description, /target/i);
  assert.ok(formExtract);
  assert.deepEqual(formExtract.inputSchema.required, ['origin']);
  assert.equal(formExtract.inputSchema.properties.includeValues.type, 'boolean');
  assert.ok(formFillPlan);
  assert.deepEqual(formFillPlan.inputSchema.required, ['origin', 'fields']);
  assert.equal(formFillPlan.inputSchema.properties.fields.type, 'array');
  assert.ok(formFillExecute);
  assert.deepEqual(formFillExecute.inputSchema.required, ['origin', 'steps']);
  assert.equal(formFillExecute.inputSchema.properties.steps.type, 'array');
  assert.ok(userTabs);
  assert.deepEqual(userTabs.inputSchema.required, []);
  assert.ok(claimTab);
  assert.deepEqual(claimTab.inputSchema.required, ['tabId']);
  assert.equal(claimTab.inputSchema.properties.tabId.minimum, 0);
  assert.ok(sessionTabs);
  assert.deepEqual(sessionTabs.inputSchema.required, []);
  assert.ok(newTab);
  assert.deepEqual(newTab.inputSchema.required, []);
  assert.ok(nameSession);
  assert.deepEqual(nameSession.inputSchema.required, ['name']);
  assert.ok(finalizeTabs);
  assert.deepEqual(finalizeTabs.inputSchema.required, ['keep']);
  assert.equal(finalizeTabs.inputSchema.properties.keep.items.additionalProperties, false);
  assert.deepEqual(finalizeTabs.inputSchema.properties.keep.items.properties.status.enum, ['handoff', 'deliverable']);
  assert.ok(tabScreenshot);
  assert.deepEqual(tabScreenshot.inputSchema.required, ['tabId']);
  assert.equal(tabScreenshot.inputSchema.properties.tabId.minimum, 0);
  assert.deepEqual(tabScreenshot.inputSchema.properties.format.enum, ['png', 'jpeg', 'webp']);
  assert.equal(tabScreenshot.inputSchema.properties.quality.minimum, 1);
  assert.equal(tabScreenshot.outputContract.rawScreenshotBytes, false);
  assert.ok(tabHandleDialog);
  assert.deepEqual(tabHandleDialog.inputSchema.required, ['tabId', 'accept']);
  assert.equal(tabHandleDialog.inputSchema.properties.tabId.minimum, 0);
  assert.equal(tabHandleDialog.inputSchema.properties.accept.type, 'boolean');
  assert.equal(tabHandleDialog.inputSchema.properties.promptText.type, 'string');
  assert.ok(tabGoto);
  assert.deepEqual(tabGoto.inputSchema.required, ['tabId', 'url']);
  assert.ok(tabObserve);
  assert.deepEqual(tabObserve.inputSchema.required, ['tabId']);
  assert.ok(tabReadPage);
  assert.deepEqual(tabReadPage.inputSchema.required, ['tabId']);
  assert.ok(tabLocator);
  assert.deepEqual(tabLocator.inputSchema.required, ['tabId']);
  assert.deepEqual(tabLocator.inputSchema.properties.action.enum, ['resolve', 'click', 'type', 'fill', 'focus', 'clear']);
  assert.ok(recentTabs);
  assert.deepEqual(recentTabs.inputSchema.required, []);
  assert.ok(historySearch);
  assert.deepEqual(historySearch.inputSchema.required, ['query']);
  assert.ok(bookmarkSearch);
  assert.deepEqual(bookmarkSearch.inputSchema.required, ['query']);
  assert.ok(reopenClosedTab);
  assert.deepEqual(reopenClosedTab.inputSchema.required, []);
  assert.ok(downloadWait);
  assert.deepEqual(downloadWait.inputSchema.required, []);
  assert.ok(downloadShow);
  assert.deepEqual(downloadShow.inputSchema.required, ['downloadId']);
  assert.ok(tabFocus);
  assert.deepEqual(tabFocus.inputSchema.required, ['tabId']);
  assert.ok(tabPin);
  assert.deepEqual(tabPin.inputSchema.required, ['tabId', 'pinned']);
  assert.ok(tabMove);
  assert.deepEqual(tabMove.inputSchema.required, ['tabId', 'index']);
  assert.ok(tabGroupRename);
  assert.deepEqual(tabGroupRename.inputSchema.required, ['groupId', 'title']);
  assert.ok(policyStatus);
  assert.deepEqual(policyStatus.inputSchema.required, []);
  assert.ok(policyUpdate);
  assert.deepEqual(policyUpdate.inputSchema.required, []);
  assert.ok(tabShowTarget);
  assert.deepEqual(tabShowTarget.inputSchema.required, ['tabId']);
  assert.equal(tabShowTarget.inputSchema.properties.durationMs.minimum, 100);
  assert.ok(tabOperatorIndicator);
  assert.deepEqual(tabOperatorIndicator.inputSchema.required, ['tabId']);
  assert.match(toolDefinitionsHash(), /^[a-f0-9]{64}$/);
  assert.equal(toolDefinitionsHash(), toolDefinitionsHash());
});

test('validateToolInput rejects unknown tools, missing fields, and extra fields', () => {
  assert.deepEqual(validateToolInput('missing_tool', {}), {
    ok: false,
    error: {
      code: 'UNKNOWN_TOOL',
      message: 'Unknown Codex Chrome tool: missing_tool.'
    }
  });

  assert.equal(validateToolInput('codex_chrome_open_observe', {}).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(
    validateToolInput('codex_chrome_open_observe', {
      url: 'https://example.com',
      surprise: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_open_observe', {
      url: 'https://example.com',
      timeoutMs: 1000,
      pollIntervalMs: 25,
      mode: 'medium',
      maxActionableHandles: 35,
      summaryMaxChars: 900,
      sincePageStateId: 'state_1'
    }).ok,
    true
  );
  assert.equal(validateToolInput('codex_chrome_open_observe', {
    url: 'https://example.com',
    mode: 'wide'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_open_observe', {
    url: 'https://example.com',
    maxActionableHandles: 0
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_observe', {
    origin: 'https://example.com/path',
    mode: 'tiny',
    maxActionableHandles: 12,
    summaryMaxChars: 300,
    sincePageStateId: 'state_1'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_observe', {
    origin: 'https://example.com',
    summaryMaxChars: 0
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_status', {}).ok, true);
  assert.equal(validateToolInput('codex_chrome_status', { detail: 'compact' }).ok, true);
  assert.equal(validateToolInput('codex_chrome_status', { detail: 'full' }).ok, true);
  assert.equal(
    validateToolInput('codex_chrome_status', { detail: 'verbose' }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(validateToolInput('codex_chrome_user_tabs', {}).ok, true);
  assert.equal(validateToolInput('codex_chrome_session_tabs', {}).ok, true);
  assert.equal(validateToolInput('codex_chrome_new_tab', {}).ok, true);
  assert.equal(validateToolInput('codex_chrome_claim_tab', { tabId: 7 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_claim_tab', {}).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_name_session', { name: 'Firebase' }).ok, true);
  assert.equal(validateToolInput('codex_chrome_finalize_tabs', {
    keep: [{ tabId: 7, status: 'handoff' }]
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_finalize_tabs', {
    keep: [{ tabId: 7, status: 'pin' }]
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_tab_screenshot', { tabId: 7 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_screenshot', {
    tabId: 7,
    format: 'jpeg',
    quality: 80
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_screenshot', {
    tabId: 7,
    format: 'gif'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_tab_handle_dialog', {
    tabId: 7,
    accept: true
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_handle_dialog', {
    tabId: 7,
    accept: false,
    promptText: 'typed prompt answer'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_handle_dialog', {
    tabId: 7,
    accept: 'yes'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_tab_goto', {
    tabId: 7,
    url: 'https://example.com/app'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_observe', {
    tabId: 7,
    mode: 'tiny'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_read_page', {
    tabId: 7,
    filter: 'interactive'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_locator', {
    tabId: 7,
    selector: 'button[data-testid="save"]',
    action: 'click',
    postActionSnapshot: 'delta',
    actionTrace: true,
    actionTraceLabel: 'Save click'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_locator', {
    tabId: 7,
    action: 'hover'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_recent_tabs', { limit: 5 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_history_search', { query: 'play console', maxResults: 5 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_bookmark_search', { query: 'cloudflare', maxResults: 5 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_reopen_closed_tab', { claim: true }).ok, true);
  assert.equal(validateToolInput('codex_chrome_download_wait', {
    filenameContains: 'report',
    state: 'complete',
    timeoutMs: 5000,
    pollIntervalMs: 100
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_download_show', { downloadId: 4 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_focus', { tabId: 7 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_pin', { tabId: 7, pinned: true }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_move', { tabId: 7, index: 1, windowId: 2 }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_group_rename', { groupId: 3, title: 'Work' }).ok, true);
  assert.equal(validateToolInput('codex_chrome_policy_status', {}).ok, true);
  assert.equal(validateToolInput('codex_chrome_policy_update', {
    guardedActionsEnabled: false,
    purchaseApprovalsEnabled: true
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_show_target', {
    tabId: 7,
    selector: 'button.save',
    durationMs: 1000
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_operator_indicator', {
    tabId: 7,
    active: true,
    label: 'Codex is active'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_click', {
    origin: 'https://example.com',
    handle: 'el_state_0',
    targetContract: SAVE_TARGET_CONTRACT,
    actionTrace: true,
    actionTraceLabel: 'Clicked Save',
    actionTraceDurationMs: 1000
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_click', {
    origin: 'https://example.com',
    handle: 'el_state_0',
    targetContract: {
      version: 1,
      tag: 'button',
      unsupported: true
    }
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_click', {
    origin: 'https://x.com',
    handle: 'el_state_post',
    postActionSnapshot: 'delta',
    requireVerified: true,
    postActionVerifyDelayMs: 3000,
    verify: {
      oneOf: [{
        type: 'textAppearsInArticle',
        text: 'Live Codex Chrome Operator check'
      }]
    }
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_tab_show_target', {
    tabId: 7,
    durationMs: 50
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: 'not-an-array'
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: [],
      extra: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: [{
        role: 'playStoreAppIcon',
        path: 'C:/tmp/icon.png',
        unexpected: true
      }]
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: [{
        role: 'playStoreAppIcon',
        path: 'C:/tmp/icon.png',
        expectedSha256: 'abc123'
      }]
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger'
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger',
      cartActionAllowed: true,
      checkoutAllowed: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger',
      cartActionAllowed: true,
      criteria: {
        maxPrice: '50'
      }
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger',
      cartActionAllowed: true,
      criteria: {
        maxPrice: 50,
        checkout: true
      }
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example/path',
      query: 'portable charger',
      cartActionAllowed: true,
      criteria: {
        minSellerRating: 4.7,
        maxPrice: 50,
        currency: 'USD',
        sort: 'price-asc'
      }
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_read_page', {
      origin: 'https://example.com/path',
      filter: 'interactive',
      depth: 4,
      maxChars: 12000,
      refId: 'el_state_0',
      includeFormValues: true,
      maxFieldValueChars: 80
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_extract', {
      origin: 'https://shop.example/path',
      intent: 'shopping.productCandidates',
      maxCandidates: 3
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_extract', {
      origin: 'https://shop.example',
      intent: 'shopping.productCandidates',
      maxCandidates: 0
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_extract', {
      origin: 'https://shop.example',
      intent: 'shopping.productCandidates',
      includeDom: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_observe', {
      origin: 'https://example.com/path',
      mode: 'medium',
      maxBytes: 120000,
      reason: 'DOM confidence low around product tiles'
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_observe', {
      origin: 'https://example.com/path',
      maxBytes: 0
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: [{
        action: 'observe',
        sincePageStateId: 'state_previous',
        mode: 'tiny',
        maxActionableHandles: 10,
        summaryMaxChars: 300,
        includeFormValues: true,
        maxFieldValueChars: 80
      }, {
        action: 'fill',
        handle: 'el_state_0',
        text: 'Draft',
        targetContract: SAVE_TARGET_CONTRACT,
        postActionSnapshot: 'delta',
        sincePageStateId: 'state_previous'
      }, {
        action: 'pressKey',
        handle: 'el_state_0',
        key: 'Enter'
      }],
      stopOnError: true
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: []
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_fill', {
      origin: 'https://example.com',
      handle: 'el_state_0',
      text: 'Draft',
      verify: {
        oneOf: []
      }
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_form_fill_plan', {
      origin: 'https://example.com',
      fields: []
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_form_fill_execute', {
      origin: 'https://example.com',
      steps: []
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_click', {
      origin: 'https://example.com',
      handle: 'el_state_0',
      postActionSnapshot: 'delta',
      verify: {
        oneOf: [{
          type: 'unknownVerifyType',
          text: 'Saved'
        }]
      }
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: [{
        action: 'observe',
        sincePageStateId: 'state_previous'
      }]
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_fill', {
      origin: 'https://example.com',
      handle: 'el_state_0',
      text: 'Draft',
      postActionSnapshot: 'delta',
      sincePageStateId: 'state_previous',
      maxActionableHandles: 10,
      actionTrace: true
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_fill', {
      origin: 'https://example.com',
      handle: 'el_state_0',
      text: 'Draft',
      postActionSnapshot: 'full'
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: [{
        action: 'fill',
        handle: 'el_state_0',
        text: 'Draft',
        targetContract: {
          version: 1,
          tag: 'input',
          extra: true
        }
      }]
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
});

test('CodexChromeToolAdapter forwards explicit form value observe and read-page options', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return { ok: true, result: { method: request.method, params: request.params } };
    }
  });

  const observed = await adapter.executeTool({
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com/form',
      mode: 'full',
      includeFormValues: true,
      maxFieldValueChars: 64
    }
  });
  const read = await adapter.executeTool({
    toolName: 'codex_chrome_read_page',
    input: {
      origin: 'https://example.com/form',
      filter: 'all',
      includeFormValues: true,
      maxFieldValueChars: 32
    }
  });
  const visual = await adapter.executeTool({
    toolName: 'codex_chrome_visual_observe',
    input: {
      origin: 'https://example.com/form',
      mode: 'medium',
      includeFormValues: true,
      maxFieldValueChars: 16,
      reason: 'verify visible form'
    }
  });

  assert.equal(observed.ok, true);
  assert.equal(read.ok, true);
  assert.equal(visual.ok, true);
  assert.deepEqual(calls.map((call) => call.params), [{
    origin: 'https://example.com',
    mode: 'full',
    includeFormValues: true,
    maxFieldValueChars: 64
  }, {
    origin: 'https://example.com',
    filter: 'all',
    includeFormValues: true,
    maxFieldValueChars: 32
  }, {
    origin: 'https://example.com',
    mode: 'medium',
    includeFormValues: true,
    maxFieldValueChars: 16,
    reason: 'verify visible form'
  }]);
});

test('CodexChromeToolAdapter defaults status to compact, forwards detail, and attaches telemetry', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      if (request.params.detail === 'compact') {
        return {
          ok: true,
          result: {
            connectionState: 'EXTENSION_CONNECTED',
            pendingApprovalCount: 0,
            approvedOriginCount: 1,
            blockedOriginCount: 0,
            domainApprovalCount: 1,
            hostPermissionOriginCount: 1
          }
        };
      }
      return {
        ok: true,
        result: {
          connectionState: 'EXTENSION_CONNECTED',
          recentEvents: [{ type: 'unit' }],
          approvedOrigins: ['https://example.com']
        }
      };
    }
  });

  const compact = await adapter.executeTool({
    toolName: 'codex_chrome_status',
    input: {}
  });
  const full = await adapter.executeTool({
    toolName: 'codex_chrome_status',
    input: { detail: 'full' }
  });
  const invalid = await adapter.executeTool({
    toolName: 'codex_chrome_status',
    input: { detail: 'verbose' }
  });

  assert.deepEqual(calls.map((call) => call.params), [
    { detail: 'compact' },
    { detail: 'full' }
  ]);
  assert.equal(compact.ok, true);
  assert.equal(compact.telemetry.budgetName, 'codex_chrome_status.compact');
  assert.equal(compact.telemetry.resultChars, JSON.stringify(compact.result).length);
  assert.equal(compact.telemetry.approxResultTokens, Math.ceil(compact.telemetry.resultChars / 4));
  assert.equal(compact.telemetry.approxResponseTokens, Math.ceil(compact.telemetry.responseChars / 4));
  assert.equal(typeof compact.telemetry.responseChars, 'number');
  assert.equal(full.telemetry.budgetName, 'codex_chrome_status');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_TOOL_INPUT');
  assert.equal(invalid.telemetry.budgetName, 'codex_chrome_status');
  assert.equal(calls.length, 2);
});

test('CodexChromeToolAdapter routes session tab tools to operator tab RPC methods', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  await adapter.executeTool({ toolName: 'codex_chrome_user_tabs', input: {} });
  await adapter.executeTool({ toolName: 'codex_chrome_claim_tab', input: { tabId: 7 } });
  await adapter.executeTool({ toolName: 'codex_chrome_session_tabs', input: {} });
  await adapter.executeTool({ toolName: 'codex_chrome_new_tab', input: {} });
  await adapter.executeTool({ toolName: 'codex_chrome_name_session', input: { name: 'Firebase cleanup' } });
  await adapter.executeTool({
    toolName: 'codex_chrome_finalize_tabs',
    input: { keep: [{ tabId: 7, status: 'deliverable' }] }
  });

  assert.deepEqual(calls.map((call) => [call.method, call.params]), [
    ['operator.tabs.listUser', {}],
    ['operator.tabs.claim', { tabId: 7 }],
    ['operator.tabs.listSession', {}],
    ['operator.tabs.create', {}],
    ['operator.session.name', { name: 'Firebase cleanup' }],
    ['operator.tabs.finalize', { keep: [{ tabId: 7, status: 'deliverable' }] }]
  ]);
});

test('CodexChromeToolAdapter routes tab screenshot helper through guarded CDP', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          screenshot: {
            artifactId: 'shot_1',
            dataUrl: 'data:image/png;base64,rawbytes'
          }
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_tab_screenshot',
    input: { tabId: 7, format: 'jpeg', quality: 80 }
  });

  assert.deepEqual(calls.map((call) => ({
    method: call.method,
    params: call.params
  })), [{
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.captureScreenshot',
      params: {
        format: 'jpeg',
        quality: 80
      }
    }
  }]);
  assert.equal(response.ok, true);
  assert.equal(response.result.screenshot.artifactId, 'shot_1');
  assert.equal(response.result.screenshot.dataUrl, undefined);
  assert.equal(response.result.screenshot.rawDataRedacted, true);
});

test('CodexChromeToolAdapter routes native dialog handling through guarded CDP', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          handled: true
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_tab_handle_dialog',
    input: { tabId: 7, accept: false }
  });

  assert.deepEqual(calls.map((call) => ({
    method: call.method,
    params: call.params
  })), [{
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.handleJavaScriptDialog',
      params: {
        accept: false
      }
    }
  }]);
  assert.equal(response.ok, true);
  assert.equal(response.result.handled, true);
});

test('CodexChromeToolAdapter routes safe runtime tab helpers', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  await adapter.executeTool({
    toolName: 'codex_chrome_tab_goto',
    input: { tabId: 7, url: 'https://example.com/app' }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_tab_observe',
    input: { tabId: 7, mode: 'tiny' }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_tab_read_page',
    input: { tabId: 7, filter: 'interactive', maxChars: 500 }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_tab_locator',
    input: {
      tabId: 7,
      selector: 'button[data-testid="save"]',
      action: 'click',
      postActionSnapshot: 'delta',
      postActionVerifyDelayMs: 500,
      actionTrace: true,
      actionTraceLabel: 'Save click',
      targetContract: SAVE_TARGET_CONTRACT
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_tab_operator_indicator',
    input: {
      tabId: 7,
      active: true,
      label: 'Codex is active in this tab'
    }
  });

  assert.deepEqual(calls.map((call) => [call.method, call.params]), [
    ['operator.runtime.tab.goto', { tabId: 7, url: 'https://example.com/app' }],
    ['operator.runtime.tab.observe', { tabId: 7, mode: 'tiny' }],
    ['operator.runtime.tab.readPage', { tabId: 7, filter: 'interactive', maxChars: 500 }],
    ['operator.runtime.tab.locator', {
      tabId: 7,
      selector: 'button[data-testid="save"]',
      action: 'click',
      postActionSnapshot: 'delta',
      postActionVerifyDelayMs: 500,
      actionTrace: true,
      actionTraceLabel: 'Save click',
      targetContract: SAVE_TARGET_CONTRACT
    }],
    ['operator.runtime.tab.indicator', {
      tabId: 7,
      active: true,
      label: 'Codex is active in this tab'
    }]
  ]);
});

test('CodexChromeToolAdapter routes compact read page and batch actions with normalized origins', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const readPage = await adapter.executeTool({
    toolName: 'codex_chrome_read_page',
    input: {
      origin: 'https://example.com/path?x=1',
      filter: 'interactive',
      depth: 3,
      maxChars: 12000,
      refId: 'el_state_0'
    }
  });
  const batch = await adapter.executeTool({
    toolName: 'codex_chrome_batch',
    input: {
      origin: 'https://example.com/form',
      stopOnError: true,
      actions: [{
        action: 'fill',
        handle: 'el_state_0',
        text: 'Draft',
        targetContract: SAVE_TARGET_CONTRACT
      }, {
        action: 'pressKey',
        handle: 'el_state_0',
        key: 'Enter'
      }]
    }
  });

  assert.equal(readPage.ok, true);
  assert.equal(batch.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['page.readPage', 'page.batch']);
  assert.deepEqual(calls[0].params, {
    origin: 'https://example.com',
    filter: 'interactive',
    depth: 3,
    maxChars: 12000,
    refId: 'el_state_0'
  });
  assert.deepEqual(calls[1].params, {
    origin: 'https://example.com',
    stopOnError: true,
    actions: [{
      action: 'fill',
      handle: 'el_state_0',
      text: 'Draft',
      targetContract: SAVE_TARGET_CONTRACT
    }, {
      action: 'pressKey',
      handle: 'el_state_0',
      key: 'Enter'
    }]
  });
});

test('CodexChromeToolAdapter routes cart preparation with normalized origin and safe defaults', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params,
          screenshot: {
            dataUrl: 'data:image/png;base64,rawbytes'
          }
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_cart_prepare',
    input: {
      origin: 'https://shop.example/products?ref=codex',
      profileId: 'profile_1',
      query: 'portable charger',
      cartActionAllowed: true
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.untrusted, true);
  assert.equal(response.result.method, 'page.prepareCart');
  assert.deepEqual(response.result.params, {
    origin: 'https://shop.example',
    profileId: 'profile_1',
    query: 'portable charger',
    criteria: {},
    cartActionAllowed: true
  });
  assert.equal(response.result.screenshot.dataUrl, undefined);
  assert.equal(response.result.screenshot.rawDataRedacted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.prepareCart');
  assert.deepEqual(calls[0].params, {
    origin: 'https://shop.example',
    profileId: 'profile_1',
    query: 'portable charger',
    criteria: {},
    cartActionAllowed: true
  });
});

test('CodexChromeToolAdapter forwards intent-scoped extraction with normalized origin', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_extract',
    input: {
      origin: 'https://shop.example/products?q=perfume',
      intent: 'shopping.productCandidates',
      maxCandidates: 4
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.extract');
  assert.deepEqual(response.result.params, {
    origin: 'https://shop.example',
    intent: 'shopping.productCandidates',
    maxCandidates: 4
  });
  assert.deepEqual(calls.map((request) => request.method), ['page.extract']);
});

test('CodexChromeToolAdapter routes upload file with normalized origin and optional controls', async () => {
  const calls = [];
  const files = [{
    role: 'playStoreAppIcon',
    path: 'C:/tmp/icon.png',
    expectedSha256: 'abc123'
  }];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_upload_file',
    input: {
      origin: 'https://example.com/path?x=1',
      handle: 'el_file',
      ruleset: 'play-store-draft',
      verifyPreview: true,
      files
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.uploadFile');
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    target: { handle: 'el_file' },
    ruleset: 'play-store-draft',
    verifyPreview: true,
    files: [{
      role: 'playStoreAppIcon',
      path: '[REDACTED_PATH]',
      expectedSha256: 'abc123'
    }]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.uploadFile');
  assert.deepEqual(calls[0].params.files, files);
});

test('CodexChromeToolAdapter exposes strict visual analyze schema and validation', () => {
  const visualAnalyze = listTools().find((tool) => tool.name === 'codex_chrome_visual_analyze');

  assert.ok(visualAnalyze);
  assert.equal(visualAnalyze.inputSchema.type, 'object');
  assert.equal(visualAnalyze.inputSchema.additionalProperties, false);
  assert.deepEqual(visualAnalyze.inputSchema.required, ['origin']);
  assert.deepEqual(visualAnalyze.inputSchema.properties, {
    origin: { type: 'string' },
    provider: { type: 'string' },
    maxBytes: { type: 'number' },
    allowSensitive: { type: 'boolean' }
  });
  assert.equal(
    validateToolInput('codex_chrome_visual_analyze', {}).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_analyze', {
      origin: 'https://example.com',
      extra: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_analyze', {
      origin: 'https://example.com/path',
      provider: 'local',
      maxBytes: 120000,
      allowSensitive: false
    }).ok,
    true
  );
});

test('CodexChromeToolAdapter routes visual analyze with normalized origin and options', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_visual_analyze',
    input: {
      origin: 'https://example.com/deep/path?x=1#section',
      provider: 'local',
      maxBytes: 120000,
      allowSensitive: false
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.visualAnalyze');
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    provider: 'local',
    maxBytes: 120000,
    allowSensitive: false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.visualAnalyze');
});

test('CodexChromeToolAdapter routes media inspect with normalized origin', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return { ok: true, result: { media: [] } };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_media_inspect',
    input: {
      origin: 'https://example.com/watch?v=1',
      maxItems: 3
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.mediaInspect');
  assert.deepEqual(calls[0].params, {
    origin: 'https://example.com',
    maxItems: 3
  });
});

test('CodexChromeToolAdapter routes target visual inspect and form tools', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return { ok: true, result: { method: request.method, params: request.params } };
    }
  });

  await adapter.executeTool({
    toolName: 'codex_chrome_visual_inspect_target',
    input: {
      origin: 'https://example.com/form?x=1',
      handle: 'el_state_0',
      maxBytes: 100000,
      reason: 'target verification'
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_form_extract',
    input: {
      origin: 'https://example.com/form?x=1',
      includeValues: true
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_form_fill_plan',
    input: {
      origin: 'https://example.com/form?x=1',
      fields: [{ handle: 'el_state_0', text: 'draft' }]
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_form_fill_execute',
    input: {
      origin: 'https://example.com/form?x=1',
      steps: [{ action: 'fill', handle: 'el_state_0', text: 'draft' }]
    }
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'page.visualInspectTarget',
    'page.formExtract',
    'page.formFillPlan',
    'page.formFillExecute'
  ]);
  assert.deepEqual(calls[0].params, {
    origin: 'https://example.com',
    handle: 'el_state_0',
    maxBytes: 100000,
    reason: 'target verification'
  });
  assert.deepEqual(calls[1].params, {
    origin: 'https://example.com',
    includeValues: true
  });
  assert.equal(calls[2].params.fields[0].text, 'draft');
  assert.equal(calls[3].params.steps[0].handle, 'el_state_0');
});

test('CodexChromeToolAdapter routes visual observe with normalized origin and screenshot budget options', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_visual_observe',
    input: {
      origin: 'https://example.com/deep/path?x=1#section',
      mode: 'medium',
      maxActionableHandles: 12,
      summaryMaxChars: 400,
      sincePageStateId: 'state_visual_1',
      maxBytes: 120000,
      reason: 'visual verification after DOM uncertainty'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.visualObserve');
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    mode: 'medium',
    maxActionableHandles: 12,
    summaryMaxChars: 400,
    sincePageStateId: 'state_visual_1',
    maxBytes: 120000,
    reason: 'visual verification after DOM uncertainty'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.visualObserve');
});

test('CodexChromeToolAdapter routes browser context, download, recovery, and target cue tools', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return { ok: true, result: { method: request.method, params: request.params } };
    }
  });

  await adapter.executeTool({ toolName: 'codex_chrome_recent_tabs', input: { limit: 4 } });
  await adapter.executeTool({ toolName: 'codex_chrome_history_search', input: { query: 'play', maxResults: 2 } });
  await adapter.executeTool({ toolName: 'codex_chrome_bookmark_search', input: { query: 'docs', maxResults: 2 } });
  await adapter.executeTool({ toolName: 'codex_chrome_reopen_closed_tab', input: { claim: true } });
  await adapter.executeTool({ toolName: 'codex_chrome_download_wait', input: { filenameContains: 'report', timeoutMs: 500 } });
  await adapter.executeTool({ toolName: 'codex_chrome_download_show', input: { downloadId: 4 } });
  await adapter.executeTool({ toolName: 'codex_chrome_tab_focus', input: { tabId: 7 } });
  await adapter.executeTool({ toolName: 'codex_chrome_tab_pin', input: { tabId: 7, pinned: true } });
  await adapter.executeTool({ toolName: 'codex_chrome_tab_move', input: { tabId: 7, index: 1, windowId: 2 } });
  await adapter.executeTool({ toolName: 'codex_chrome_tab_group_rename', input: { groupId: 3, title: 'Work' } });
  await adapter.executeTool({ toolName: 'codex_chrome_policy_status', input: {} });
  await adapter.executeTool({ toolName: 'codex_chrome_policy_update', input: { guardedActionsEnabled: false } });
  await adapter.executeTool({ toolName: 'codex_chrome_tab_show_target', input: { tabId: 7, text: 'Save', durationMs: 1000 } });

  assert.deepEqual(calls.map((call) => call.method), [
    'operator.context.recentTabs',
    'operator.context.historySearch',
    'operator.context.bookmarkSearch',
    'operator.sessions.reopenClosedTab',
    'operator.downloads.wait',
    'operator.downloads.show',
    'operator.tabs.focus',
    'operator.tabs.pin',
    'operator.tabs.move',
    'operator.tabs.groupRename',
    'operator.policy.status',
    'operator.policy.update',
    'operator.runtime.tab.showTarget'
  ]);
  assert.deepEqual(calls[12].params, {
    tabId: 7,
    text: 'Save',
    durationMs: 1000
  });
});

test('CodexChromeToolAdapter forwards observe options with normalized origins', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com/path?x=1',
      mode: 'medium',
      maxActionableHandles: 15,
      summaryMaxChars: 600,
      sincePageStateId: 'state_previous',
      includeAx: true
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    mode: 'medium',
    maxActionableHandles: 15,
    summaryMaxChars: 600,
    sincePageStateId: 'state_previous',
    includeAx: true
  });
  assert.equal(calls[0].method, 'page.observe');
});

test('CodexChromeToolAdapter telemetry gates compact observe result size', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        origin: 'https://example.com',
        url: 'https://example.com/list',
        title: 'Compact List',
        observationMode: 'tiny',
        visibleTextSummary: 'Search results with a bounded visible summary.',
        elements: Array.from({ length: 30 }, (_, index) => ({
          handle: `el_state_${index}`,
          tag: 'button',
          role: 'button',
          label: `Action ${index}`
        })),
        landmarks: [{ tag: 'main', role: 'main', label: 'Results' }]
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com',
      mode: 'tiny'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.telemetry.budgetName, 'codex_chrome_observe');
  assert.ok(response.telemetry.resultChars < 8000, 'tiny observe should stay under the compact result budget');
  assert.ok(response.telemetry.approxResultTokens < 2000, 'tiny observe should stay under the compact token budget');
});

test('CodexChromeToolAdapter adds interaction hints from observed page structure', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        origin: 'https://example.com',
        url: 'https://example.com/react-form',
        title: 'React Form',
        elements: [
          {
            handle: 'el_state_link',
            tag: 'a',
            href: 'https://example.com/docs',
            label: 'Docs'
          },
          {
            handle: 'el_state_0',
            tag: 'input',
            type: 'text',
            placeholder: 'Email'
          },
          {
            handle: 'el_state_1',
            tag: 'input',
            type: 'checkbox',
            label: 'Accept'
          },
          {
            handle: 'el_state_2',
            tag: 'button',
            label: 'Save'
          },
          {
            handle: 'el_state_3',
            tag: 'input',
            type: 'text',
            role: 'combobox',
            placeholder: 'Search products, pages, and features...'
          },
          {
            handle: 'el_state_4',
            tag: 'button',
            type: 'button',
            role: 'combobox',
            label: 'Filter'
          }
        ]
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com'
    }
  });

  assert.equal(response.ok, true);
  const hints = response.result.interactionHints;
  assert.equal(hints.version, 1);
  assert.equal(hints.suggestedTargets[0].handle, 'el_state_0');
  assert.equal(
    hints.suggestedTargets.find((target) => target.handle === 'el_state_0').preferredTool,
    'codex_chrome_type'
  );
  const checkboxHint = hints.suggestedTargets.find((target) => target.handle === 'el_state_1');
  assert.equal(checkboxHint.preferredTool, 'codex_chrome_check');
  assert.deepEqual(checkboxHint.avoidTools, ['codex_chrome_click']);
  assert.equal(
    hints.suggestedTargets.find((target) => target.handle === 'el_state_2').verification,
    'explicit-post-condition-or-delta'
  );
  const searchComboboxHint = hints.suggestedTargets.find((target) => target.handle === 'el_state_3');
  assert.equal(searchComboboxHint.preferredTool, 'codex_chrome_type');
  assert.equal(searchComboboxHint.alternateTool, 'codex_chrome_fill');
  const filterComboboxHint = hints.suggestedTargets.find((target) => target.handle === 'el_state_4');
  assert.equal(filterComboboxHint.role, 'button');
  assert.equal(filterComboboxHint.preferredTool, 'codex_chrome_click');
  assert.equal(filterComboboxHint.verification, 'explicit-post-condition-or-delta');
});

test('CodexChromeToolAdapter executes open observe through the orchestration path', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    openObserveFn: async ({ settings, request }) => {
      calls.push({
        settings,
        request
      });
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          url: 'https://example.com/path',
          observation: {
            title: 'Example',
            elements: []
          }
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_open_observe',
    input: {
      url: 'https://example.com/path',
      timeoutMs: 1500,
      pollIntervalMs: 25,
      mode: 'full',
      maxActionableHandles: 80,
      summaryMaxChars: 1800,
      sincePageStateId: 'state_open'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.toolName, 'codex_chrome_open_observe');
  assert.equal(response.protocolVersion, '1.0');
  assert.equal(response.untrusted, true);
  assert.equal(response.result.observation.title, 'Example');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.token, 'adapter-token');
  assert.equal(calls[0].request.method, 'page.observe');
  assert.deepEqual(calls[0].request.params, {
    url: 'https://example.com/path',
    origin: 'https://example.com',
    timeoutMs: 1500,
    pollIntervalMs: 25,
    mode: 'full',
    maxActionableHandles: 80,
    summaryMaxChars: 1800,
    sincePageStateId: 'state_open'
  });
});

test('CodexChromeToolAdapter exposes profile readiness and onboarding setup tools', async () => {
  const tools = listTools().map((tool) => tool.name);
  for (const toolName of [
    'codex_chrome_prepare_origin',
    'codex_chrome_readiness',
    'codex_chrome_profile_doctor',
    'codex_chrome_profile_onboard'
  ]) {
    assert.ok(tools.includes(toolName), `${toolName} should be exposed`);
  }

  assert.equal(validateToolInput('codex_chrome_readiness', {}).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_profile_onboard', {
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console',
    openBootstrap: false
  }).ok, true);

  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push({
        kind: 'rpc',
        request
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    },
    prepareOriginFn: async ({ settings, request, openBootstrap }) => {
      calls.push({
        kind: 'prepareOrigin',
        settings,
        request,
        openBootstrap
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params, openBootstrap }
      };
    },
    profileDoctorFn: async ({ settings, request }) => {
      calls.push({
        kind: 'profileDoctor',
        settings,
        request
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    },
    profileOnboardFn: async ({ settings, request, openBootstrap }) => {
      calls.push({
        kind: 'profileOnboard',
        settings,
        request,
        openBootstrap
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params, openBootstrap }
      };
    }
  });

  await adapter.executeTool({
    toolName: 'codex_chrome_prepare_origin',
    input: {
      origin: 'https://example.com/path',
      openBootstrap: false
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_readiness',
    input: {
      origin: 'https://example.com/path'
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_profile_doctor',
    input: {
      origin: 'https://example.com/path'
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_profile_onboard',
    input: {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console',
      openBootstrap: false
    }
  });

  assert.deepEqual(calls.map((call) => call.kind), [
    'prepareOrigin',
    'rpc',
    'profileDoctor',
    'profileOnboard'
  ]);
  assert.equal(calls[0].settings.token, 'adapter-token');
  assert.equal(calls[0].request.method, 'operator.ensureStarted');
  assert.deepEqual(calls[0].request.params, { origin: 'https://example.com' });
  assert.equal(calls[0].openBootstrap, false);
  assert.equal(calls[1].request.method, 'operator.verifyReadiness');
  assert.deepEqual(calls[1].request.params, { origin: 'https://example.com' });
  assert.equal(calls[2].request.method, 'operator.status');
  assert.deepEqual(calls[2].request.params, { origin: 'https://example.com' });
  assert.equal(calls[3].request.method, 'operator.profiles.discover');
  assert.deepEqual(calls[3].request.params, {
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console'
  });
  assert.equal(calls[3].openBootstrap, false);
});

test('CodexChromeToolAdapter exposes and routes basic DOM action tools', async () => {
  const tools = listTools().map((tool) => tool.name);
  for (const toolName of [
    'codex_chrome_type',
    'codex_chrome_clear',
    'codex_chrome_focus',
    'codex_chrome_select',
    'codex_chrome_check',
    'codex_chrome_scroll',
    'codex_chrome_press_key'
  ]) {
    assert.ok(tools.includes(toolName), `${toolName} should be exposed`);
  }

  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    }
  });

  const checks = [
    ['codex_chrome_type', 'page.type', {
      origin: 'https://example.com/form?draft=1',
      handle: 'el_0',
      text: 'hello',
      postActionSnapshot: 'delta',
      sincePageStateId: 'state_previous',
      maxActionableHandles: 8,
      postActionVerifyDelayMs: 250,
      actionTrace: true,
      actionTraceLabel: 'Typing hello',
      targetContract: SAVE_TARGET_CONTRACT
    }],
    ['codex_chrome_clear', 'page.clear', { origin: 'https://example.com/form?draft=1', handle: 'el_0' }],
    ['codex_chrome_focus', 'page.focus', { origin: 'https://example.com/form?draft=1', handle: 'el_0' }],
    ['codex_chrome_select', 'page.select', { origin: 'https://example.com/form?draft=1', handle: 'el_1', value: 'tr' }],
    ['codex_chrome_check', 'page.check', { origin: 'https://example.com/form?draft=1', handle: 'el_2', checked: false }],
    ['codex_chrome_scroll', 'page.scroll', { origin: 'https://example.com/form?draft=1', handle: 'el_4', deltaX: 0, deltaY: 240 }],
    ['codex_chrome_press_key', 'page.pressKey', { origin: 'https://example.com/form?draft=1', handle: 'el_0', key: 'Enter' }]
  ];

  for (const [toolName, method, input] of checks) {
    const response = await adapter.executeTool({ toolName, input });
    assert.equal(response.ok, true);
    assert.equal(response.result.method, method);
    assert.deepEqual(response.result.params, {
      ...input,
      origin: 'https://example.com'
    });
  }
  assert.deepEqual(calls.map((request) => request.method), checks.map(([, method]) => method));
});

test('CodexChromeToolAdapter exposes approval lifecycle tools with explicit user decisions', async () => {
  const tools = listTools().map((tool) => tool.name);
  for (const toolName of [
    'codex_chrome_approvals_list',
    'codex_chrome_approval_approve',
    'codex_chrome_approval_reject',
    'codex_chrome_approval_run'
  ]) {
    assert.ok(tools.includes(toolName), `${toolName} should be exposed`);
  }

  assert.equal(validateToolInput('codex_chrome_approval_approve', {
    approvalId: 'approval_1'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_approval_approve', {
    approvalId: 'approval_1',
    userDecision: 'approve'
  }).ok, true);

  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    }
  });

  const checks = [
    ['codex_chrome_approvals_list', 'operator.approvals.list', { status: 'pending' }, { status: 'pending' }],
    [
      'codex_chrome_approval_approve',
      'operator.approvals.approve',
      { approvalId: 'approval_1', userDecision: 'approve' },
      { approvalId: 'approval_1' }
    ],
    [
      'codex_chrome_approval_reject',
      'operator.approvals.reject',
      { approvalId: 'approval_1', userDecision: 'reject' },
      { approvalId: 'approval_1' }
    ],
    ['codex_chrome_approval_run', 'operator.approvals.run', { approvalId: 'approval_1' }, { approvalId: 'approval_1' }]
  ];

  for (const [toolName, method, input, params] of checks) {
    const response = await adapter.executeTool({ toolName, input });
    assert.equal(response.ok, true);
    assert.equal(response.result.method, method);
    assert.deepEqual(response.result.params, params);
  }
  assert.deepEqual(calls.map((request) => request.method), checks.map(([, method]) => method));
});

test('CodexChromeToolAdapter refuses approval decision tools with mismatched decision text', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => {
      throw new Error('approval decision should not reach daemon');
    }
  });

  const approve = await adapter.executeTool({
    toolName: 'codex_chrome_approval_approve',
    input: {
      approvalId: 'approval_1',
      userDecision: 'reject'
    }
  });
  assert.equal(approve.ok, false);
  assert.equal(approve.error.code, 'INVALID_TOOL_INPUT');

  const reject = await adapter.executeTool({
    toolName: 'codex_chrome_approval_reject',
    input: {
      approvalId: 'approval_1',
      userDecision: 'approve'
    }
  });
  assert.equal(reject.ok, false);
  assert.equal(reject.error.code, 'INVALID_TOOL_INPUT');
});

test('validateToolInput enforces typed basic action parameters', () => {
  assert.equal(validateToolInput('codex_chrome_check', {
    origin: 'https://example.com',
    handle: 'el_2',
    checked: 'false'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_scroll', {
    origin: 'https://example.com',
    handle: 'el_4',
    deltaX: 0,
    deltaY: '240'
  }).error.code, 'INVALID_TOOL_INPUT');
});

test('CodexChromeToolAdapter redacts raw visual data URLs from tool responses', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        title: 'Visual Page',
        screenshot: {
          artifactId: 'shot_1',
          dataUrl: 'data:image/png;base64,rawbytes'
        }
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_visual_observe',
    input: {
      origin: 'https://example.com'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.screenshot.artifactId, 'shot_1');
  assert.equal(response.result.screenshot.dataUrl, undefined);
  assert.equal(response.result.screenshot.rawDataRedacted, true);
});

test('CodexChromeToolAdapter redacts path fields without redacting basename or hash', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        file: {
          basename: 'icon.png',
          expectedSha256: 'abc123',
          path: 'C:/tmp/icon.png'
        }
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_upload_file',
    input: {
      origin: 'https://example.com',
      handle: 'el_file',
      files: []
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.file.basename, 'icon.png');
  assert.equal(response.result.file.expectedSha256, 'abc123');
  assert.equal(response.result.file.path, '[REDACTED_PATH]');
});
