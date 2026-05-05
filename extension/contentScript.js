'use strict';

function currentContentScriptVersion() {
  try {
    return chrome.runtime.getManifest().version || 'unknown';
  } catch {
    return 'unknown';
  }
}

var CODEX_CONTENT_SCRIPT_VERSION = currentContentScriptVersion();
globalThis.__codexContentScriptVersion = CODEX_CONTENT_SCRIPT_VERSION;

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    rect.width > 0 &&
    rect.height > 0;
}

function dataAttributes(element) {
  return Object.entries(element.dataset || {}).reduce((data, [key, value]) => {
    data[key] = value;
    return data;
  }, {});
}

function numericAttribute(element, name) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function uploadInputForElement(element) {
  if (element.matches('input[type="file"]')) {
    return element;
  }

  const referencedId = element.getAttribute('for') ||
    element.getAttribute('data-upload-input') ||
    (element.getAttribute('aria-controls') || '').split(/\s+/).find(Boolean);
  if (referencedId) {
    const referenced = document.getElementById(referencedId);
    if (referenced && referenced.matches('input[type="file"]')) {
      return referenced;
    }
  }

  const nested = element.querySelector && element.querySelector('input[type="file"]');
  return nested || null;
}

function uploadRoleForElement(element) {
  return element.getAttribute('data-upload-role') ||
    element.getAttribute('data-preview-role') ||
    element.getAttribute('data-validation-message') ||
    (uploadInputForElement(element) || {}).getAttribute?.('data-upload-role') ||
    null;
}

function isUploadTargetElement(element) {
  return Boolean(element.getAttribute('data-upload-role') || uploadInputForElement(element));
}

function visualRoleForElement(element) {
  const uploadRole = element.getAttribute('data-upload-role');
  if (uploadRole) {
    return `${uploadRole}-upload`;
  }
  const previewRole = element.getAttribute('data-preview-role');
  if (previewRole) {
    return `${previewRole}-preview`;
  }
  const validationRole = element.getAttribute('data-validation-message');
  if (validationRole) {
    return `${validationRole}-validation`;
  }
  if (element.getAttribute('data-visual-card') === 'product') {
    return 'product-card';
  }
  const analyzerField = element.getAttribute('data-analyzer-field');
  if (analyzerField === 'seller-rating') {
    return 'rating-stars';
  }
  if (analyzerField) {
    return analyzerField;
  }
  if (element.classList && element.classList.contains('price')) {
    return 'price';
  }
  return null;
}

function isSensitiveElement(element) {
  return Boolean(
    element.matches('input[type="password"], [autocomplete="one-time-code"]') ||
    element.getAttribute('data-sensitive-page') === 'true' ||
    element.getAttribute('data-visual-policy') === 'block' ||
    element.getAttribute('data-analysis-policy') === 'block'
  );
}

function compactElementSummary(summary) {
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => {
    if (value === null || value === undefined || value === false) {
      return false;
    }
    return !(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  }));
}

function layoutContext() {
  return {
    url: location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY
    },
    devicePixelRatio: window.devicePixelRatio
  };
}

function booleanOption(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

function sensitiveFormAttributeText(element) {
  return [
    element.getAttribute('type') || '',
    element.getAttribute('autocomplete') || '',
    element.getAttribute('name') || '',
    element.id || '',
    element.getAttribute('aria-label') || '',
    element.getAttribute('placeholder') || '',
    element.getAttribute('title') || ''
  ].join(' ').toLowerCase();
}

function isSensitiveFormValueElement(element) {
  if (isSensitiveElement(element)) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && ['hidden', 'password', 'email', 'tel'].includes(type)) {
    return true;
  }
  return /\b(pass(word)?|token|secret|api[-_ ]?key|otp|one[-_ ]?time|2fa|mfa|email|e-mail|mail|phone|tel|mobile|credit|card|cc-|cvv|cvc)\b/.test(sensitiveFormAttributeText(element));
}

function formValueForElement(element, options = {}) {
  if (!booleanOption(options.includeFormValues)) {
    return null;
  }
  const tag = element.tagName.toLowerCase();
  if (!['input', 'textarea', 'select'].includes(tag)) {
    return null;
  }
  if (isSensitiveFormValueElement(element)) {
    return null;
  }
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && ['button', 'submit', 'reset', 'file', 'image'].includes(type)) {
    return null;
  }
  const rawValue = tag === 'select'
    ? (element.value || element.getAttribute('value') || '')
    : element.value;
  const maxChars = Number.isFinite(Number(options.maxFieldValueChars))
    ? Math.max(0, Math.floor(Number(options.maxFieldValueChars)))
    : 4000;
  return String(rawValue || '').slice(0, maxChars);
}

function elementSummary(element, handle, options = {}) {
  const rect = element.getBoundingClientRect();
  const dataRisk = element.getAttribute('data-risk') || null;
  const uploadInput = uploadInputForElement(element);
  const uploadRole = uploadRoleForElement(element);
  const href = typeof element.href === 'string' && element.href
    ? element.href
    : element.getAttribute('href') || null;
  const placeholder = element.getAttribute('placeholder') || null;
  const title = element.getAttribute('title') || null;
  const label = element.getAttribute('aria-label') ||
    title ||
    element.innerText ||
    placeholder ||
    element.getAttribute('name') ||
    '';

  const visualRole = visualRoleForElement(element);
  const ratingValue = numericAttribute(element, 'data-rating');
  const formValue = formValueForElement(element, options);
  return compactElementSummary({
    handle,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || null,
    type: element.getAttribute('type') || null,
    name: element.getAttribute('name') || null,
    id: element.id || null,
    href,
    placeholder,
    title,
    dataRisk,
    data: dataAttributes(element),
    visualRole,
    uploadRole,
    uploadTarget: isUploadTargetElement(element),
    accepts: uploadInput ? uploadInput.getAttribute('accept') || null : element.getAttribute('accept') || null,
    multiple: uploadInput ? Boolean(uploadInput.multiple) : Boolean(element.multiple),
    productId: element.getAttribute('data-product-id') || null,
    analyzerField: element.getAttribute('data-analyzer-field') || null,
    ratingValue,
    sensitive: isSensitiveElement(element),
    label: String(label).trim().slice(0, 200),
    value: formValue,
    disabled: Boolean(element.disabled),
    context: layoutContext(),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  });
}

function collectInteractiveElements() {
  return [...document.querySelectorAll(
    'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
  )].filter(isVisible).slice(0, 200);
}

function hasVisibleUploadAssociation(input) {
  if (!input.matches('input[type="file"]')) {
    return false;
  }

  const visibleLabels = [...(input.labels || [])].some(isVisible);
  if (visibleLabels) {
    return true;
  }

  const id = input.id;
  if (!id) {
    return false;
  }

  return [...document.querySelectorAll('[data-upload-input], [aria-controls]')]
    .some((element) => {
      const matchesDataReference = element.getAttribute('data-upload-input') === id;
      const matchesAriaReference = (element.getAttribute('aria-controls') || '').split(/\s+/).includes(id);
      return (matchesDataReference || matchesAriaReference) && isVisible(element);
    });
}

function collectUploadElements() {
  const visibleUploadWidgets = [...document.querySelectorAll([
    '[data-upload-role]',
    '[data-preview-role]',
    '[data-validation-message]'
  ].join(','))].filter(isVisible);
  const associatedHiddenInputs = [...document.querySelectorAll('input[type="file"][data-upload-role]')]
    .filter((element) => !isVisible(element) && hasVisibleUploadAssociation(element));

  return [...visibleUploadWidgets, ...associatedHiddenInputs].slice(0, 200);
}

function collectVisualElements() {
  return [...document.querySelectorAll([
    '[data-visual-card]',
    '[data-analyzer-field]',
    '[data-sensitive-page]',
    '[data-visual-policy]',
    '[data-analysis-policy]',
    '[data-rating]',
    '[data-product-id]',
    '[data-preview-role]',
    '[data-validation-message]',
    '[role="dialog"]',
    '[role="status"]',
    '[role="alert"]'
  ].join(','))].filter(isVisible).slice(0, 200);
}

function collectObservedElements() {
  return [...new Set([...collectInteractiveElements(), ...collectVisualElements(), ...collectUploadElements()])].slice(0, 300);
}

var lastObservationSummaries = globalThis.__codexLastObservationSummaries || new Map();
globalThis.__codexLastObservationSummaries = lastObservationSummaries;
var MAX_OBSERVATION_SUMMARIES = 8;

function boundedText(value, maxChars = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function elementComparisonKey(summary) {
  return [
    summary.tag || '',
    summary.role || '',
    summary.id || '',
    summary.name || '',
    summary.href || '',
    summary.productId || '',
    summary.uploadRole || '',
    summary.visualRole || '',
    boundedText(summary.label)
  ].join('|');
}

function elementIdentityKey(summary) {
  return [
    summary.tag || '',
    summary.role || '',
    summary.id || '',
    summary.name || '',
    summary.href || '',
    summary.productId || '',
    summary.uploadRole || '',
    summary.visualRole || ''
  ].join('|');
}

function observationSummaryForDelta(observation) {
  return {
    pageStateId: observation.pageStateId,
    url: observation.url,
    origin: observation.origin,
    elements: (observation.elements || []).map((entry) => ({
      handle: entry.handle,
      key: elementComparisonKey(entry),
      identityKey: elementIdentityKey(entry),
      tag: entry.tag || null,
      role: entry.role || null,
      id: entry.id || null,
      name: entry.name || null,
      href: entry.href || null,
      productId: entry.productId || null,
      uploadRole: entry.uploadRole || null,
      visualRole: entry.visualRole || null,
      label: boundedText(entry.label)
    }))
  };
}

function rememberObservationSummary(summary) {
  if (!summary || !summary.pageStateId) {
    return;
  }
  if (lastObservationSummaries.has(summary.pageStateId)) {
    lastObservationSummaries.delete(summary.pageStateId);
  }
  lastObservationSummaries.set(summary.pageStateId, summary);
  while (lastObservationSummaries.size > MAX_OBSERVATION_SUMMARIES) {
    const oldest = lastObservationSummaries.keys().next();
    if (oldest.done) {
      break;
    }
    lastObservationSummaries.delete(oldest.value);
  }
}

function compactObservationMetadata(observation) {
  const {
    elements,
    ...metadata
  } = observation;
  return metadata;
}

function handleLimitForDelta(observation) {
  const value = observation && observation.limits && Number(observation.limits.maxActionableHandles);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30;
}

function buildObservationDelta(base, current, maxItems) {
  const previousByKey = new Map(base.elements.map((entry) => [entry.key, entry]));
  const currentByKey = new Map(current.elements.map((entry) => [entry.key, entry]));
  const previousByIdentity = new Map(base.elements.map((entry) => [entry.identityKey, entry]));
  const currentByIdentity = new Map(current.elements.map((entry) => [entry.identityKey, entry]));
  const newHandles = [];
  const removedHandles = [];
  const changedElements = [];

  for (const entry of current.elements) {
    if (!previousByKey.has(entry.key)) {
      newHandles.push(entry.handle);
    }
    if (
      previousByIdentity.has(entry.identityKey) &&
      previousByIdentity.get(entry.identityKey).key !== entry.key
    ) {
      changedElements.push({
        handle: entry.handle,
        previousHandle: previousByIdentity.get(entry.identityKey).handle,
        tag: entry.tag,
        role: entry.role,
        id: entry.id,
        name: entry.name,
        label: entry.label
      });
    }
  }

  for (const entry of base.elements) {
    if (!currentByKey.has(entry.key)) {
      removedHandles.push(entry.handle);
    }
  }

  return {
    unchanged: false,
    fromPageStateId: base.pageStateId,
    toPageStateId: current.pageStateId,
    newHandles: newHandles.slice(0, maxItems),
    removedHandles: removedHandles.slice(0, maxItems),
    changedElements: changedElements.slice(0, maxItems)
  };
}

function observationWithDelta(observation, sincePageStateId) {
  const currentSummary = observationSummaryForDelta(observation);
  const base = lastObservationSummaries.get(sincePageStateId);
  rememberObservationSummary(currentSummary);

  if (!base) {
    return {
      ...observation,
      delta: {
        invalidated: true,
        reason: 'BASE_SNAPSHOT_MISSING',
        fromPageStateId: sincePageStateId,
        toPageStateId: observation.pageStateId
      }
    };
  }

  if (base.origin !== observation.origin || base.url !== observation.url) {
    return {
      ...observation,
      delta: {
        invalidated: true,
        reason: 'NAVIGATION_CHANGED',
        fromPageStateId: sincePageStateId,
        toPageStateId: observation.pageStateId
      }
    };
  }

  if (base.pageStateId === observation.pageStateId) {
    return {
      ...compactObservationMetadata(observation),
      delta: {
        unchanged: true,
        fromPageStateId: sincePageStateId,
        toPageStateId: observation.pageStateId,
        newHandles: [],
        removedHandles: [],
        changedElements: []
      }
    };
  }

  return {
    ...observation,
    delta: buildObservationDelta(base, currentSummary, handleLimitForDelta(observation))
  };
}

function observationModeOptions(options = {}) {
  const mode = ['tiny', 'medium', 'full'].includes(options.mode) ? options.mode : 'tiny';
  const defaults = {
    tiny: {
      maxActionableHandles: 30,
      summaryMaxChars: 500
    },
    medium: {
      maxActionableHandles: 80,
      summaryMaxChars: 1200
    },
    full: {
      maxActionableHandles: 300,
      summaryMaxChars: 2000
    }
  };
  const selected = defaults[mode];
  const requestedHandles = Number(options.maxActionableHandles);
  const requestedSummaryMaxChars = Number(options.summaryMaxChars);
  return {
    mode,
    maxActionableHandles: Number.isFinite(requestedHandles) && requestedHandles >= 1
      ? Math.floor(requestedHandles)
      : selected.maxActionableHandles,
    summaryMaxChars: Number.isFinite(requestedSummaryMaxChars) && requestedSummaryMaxChars >= 1
      ? Math.floor(requestedSummaryMaxChars)
      : selected.summaryMaxChars,
    defaultMaxActionableHandles: selected.maxActionableHandles,
    defaultSummaryMaxChars: selected.summaryMaxChars,
    maxAvailableActionableHandles: 300
  };
}

function collectLandmarks() {
  return [...document.querySelectorAll([
    'main',
    'nav',
    'header',
    'footer',
    'aside',
    '[role="main"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]'
  ].join(','))].filter(isVisible).slice(0, 20).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || null,
      id: element.id || null,
      label: String(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.innerText ||
        ''
      ).replace(/\s+/g, ' ').trim().slice(0, 120),
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  });
}

function collectSensitiveFields() {
  return [...document.querySelectorAll('input[type="password"], [autocomplete="one-time-code"], [data-sensitive-page="true"], [data-visual-policy="block"], [data-analysis-policy="block"]')]
    .filter(isVisible)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || null,
      id: element.id || null,
      name: element.getAttribute('name') || null,
      reason: element.getAttribute('data-visual-policy') === 'block' ||
        element.getAttribute('data-analysis-policy') === 'block'
        ? 'visual-policy-block'
        : 'sensitive-field'
    }));
}

function hasExplicitVisualPolicyBlock() {
  return Boolean(document.querySelector(
    '[data-sensitive-page="true"], [data-visual-policy="block"], [data-analysis-policy="block"]'
  ));
}

function collectObservation(options = {}) {
  const limits = observationModeOptions(options);
  const allCandidates = collectObservedElements();
  const candidates = allCandidates.slice(0, limits.maxActionableHandles);
  const described = globalThis.CodexPageHandles.describeElements(candidates, {
    location,
    document,
    window
  });
  const detectedGates = globalThis.CodexGateDetector
    ? globalThis.CodexGateDetector.detectGates(document)
    : [];
  const sensitiveFields = collectSensitiveFields();
  const sensitiveVisualContent = sensitiveFields.length > 0;
  const explicitVisualPolicyBlock = hasExplicitVisualPolicyBlock();

  let observation = {
    url: location.href,
    origin: location.origin,
    contentScriptVersion: CODEX_CONTENT_SCRIPT_VERSION,
    title: document.title,
    pageStateId: described.pageStateId,
    visibleTextSummary: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, limits.summaryMaxChars),
    landmarks: collectLandmarks(),
    detectedGates,
    sensitiveVisualContent,
    visualPolicy: {
      sensitive: sensitiveVisualContent,
      explicitBlock: explicitVisualPolicyBlock,
      screenshot: sensitiveVisualContent ? 'blocked' : 'allowed'
    },
    riskSummary: {
      detectedHighRiskControls: [],
      detectedSensitiveFields: sensitiveFields.map((field) => field.reason),
      detectedGates: detectedGates.map((gate) => gate.type)
    },
    elements: candidates.map((element, index) => elementSummary(element, described.items[index].handle, options)),
    focusedElement: document.activeElement ? elementSummary(document.activeElement, null, options) : null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio
    },
    observationMode: limits.mode,
    limits: {
      maxActionableHandles: limits.maxActionableHandles,
      summaryMaxChars: limits.summaryMaxChars,
      defaultMaxActionableHandles: limits.defaultMaxActionableHandles,
      defaultSummaryMaxChars: limits.defaultSummaryMaxChars,
      availableActionableHandles: allCandidates.length,
      maxAvailableActionableHandles: limits.maxAvailableActionableHandles
    }
  };

  if (options.includeAx === true && globalThis.CodexUiGraph) {
    observation = globalThis.CodexUiGraph.attachUiGraph(observation, {
      axSnapshot: {
        ok: false,
        error: {
          code: 'AX_TREE_UNAVAILABLE_IN_CONTENT',
          message: 'Accessibility tree capture is only available from the extension background.'
        }
      }
    });
  }

  if (typeof options.sincePageStateId === 'string' && options.sincePageStateId) {
    return observationWithDelta(observation, options.sincePageStateId);
  }

  rememberObservationSummary(observationSummaryForDelta(observation));
  return observation;
}

var lastReadableElements = globalThis.__codexLastReadableElements || [];
globalThis.__codexLastReadableElements = lastReadableElements;

function pageReaderContext() {
  return {
    rootElement: document.body,
    document,
    window,
    location,
    describeElements: (elements) => globalThis.CodexPageHandles.describeElements(elements, {
      location,
      document,
      window
    }),
    resolveHandle: (handle, options = {}) => resolvePageReaderHandle(handle, options)
  };
}

function pageReaderOptions(message = {}) {
  return {
    filter: message.filter,
    depth: message.depth,
    maxChars: message.maxChars,
    refId: message.refId,
    includeFormValues: message.includeFormValues,
    maxFieldValueChars: message.maxFieldValueChars
  };
}

function resolveVersionedHandleFromElements(handle, elements) {
  return globalThis.CodexPageHandles.resolveVersionedHandle({
    handle,
    elements,
    context: {
      location,
      document,
      window
    }
  });
}

function resolveLastReadableHandle(handle) {
  if (!lastReadableElements.length) {
    return null;
  }
  return resolveVersionedHandleFromElements(handle, lastReadableElements);
}

function collectReadableElements(options = {}) {
  if (
    !globalThis.CodexPageReader ||
    typeof globalThis.CodexPageReader.collectElements !== 'function'
  ) {
    return [];
  }

  let context = pageReaderContext();
  if (options.refId) {
    const resolved = resolvePageReaderHandle(options.refId, options);
    if (!resolved || !resolved.ok || !resolved.element) {
      return [];
    }
    context = {
      ...context,
      rootElement: resolved.element
    };
  }

  return globalThis.CodexPageReader.collectElements(context, {
    filter: options.filter || 'all',
    depth: options.depth
  }).map((entry) => entry.element);
}

function rememberReadableElements(options = {}) {
  const elements = collectReadableElements(options);
  if (elements.length > 0) {
    lastReadableElements = elements;
  }
}

function resolvePageReaderHandle(handle, options = {}) {
  const remembered = resolveLastReadableHandle(handle);
  if (remembered && remembered.ok) {
    return remembered;
  }

  if (
    globalThis.CodexPageReader &&
    typeof globalThis.CodexPageReader.collectElements === 'function'
  ) {
    const entries = globalThis.CodexPageReader.collectElements(pageReaderContext(), {
      filter: options.filter || 'all',
      depth: options.depth
    });
    return resolveVersionedHandleFromElements(handle, entries.map((entry) => entry.element));
  }
  return resolveHandle(handle);
}

function readPage(message = {}) {
  if (!globalThis.CodexPageReader || typeof globalThis.CodexPageReader.generatePageSnapshot !== 'function') {
    return {
      ok: false,
      error: {
        code: 'PAGE_READER_UNAVAILABLE',
        message: 'Compact page reader is not loaded in this tab.'
      }
    };
  }
  const options = pageReaderOptions(message);
  const response = globalThis.CodexPageReader.generatePageSnapshot(pageReaderContext(), options);
  if (response && response.ok) {
    rememberReadableElements(options);
    return {
      ...response,
      result: {
        ...(response.result || {}),
        contentScriptVersion: CODEX_CONTENT_SCRIPT_VERSION
      }
    };
  }
  return response;
}

function extractIntent(message = {}) {
  if (!globalThis.CodexIntentExtractors || typeof globalThis.CodexIntentExtractors.extractIntent !== 'function') {
    return {
      intent: message.intent,
      status: 'unsupported-intent',
      supportedIntents: []
    };
  }
  return globalThis.CodexIntentExtractors.extractIntent({
    document,
    window,
    location
  }, {
    intent: message.intent,
    maxCandidates: message.maxCandidates
  });
}

function resolveHandle(handle) {
  const remembered = resolveLastReadableHandle(handle);
  if (remembered && remembered.ok) {
    return remembered;
  }

  const candidates = collectObservedElements();
  return resolveVersionedHandleFromElements(handle, candidates);
}

function actionDispatchForMessage(message = {}) {
  return {
    ok: true,
    method: 'dom',
    action: message.action || null
  };
}

function expectedActionValue(message = {}) {
  if (message.action === 'clear') {
    return '';
  }
  if (message.action === 'check') {
    return message.checked !== false;
  }
  return message.text !== undefined ? message.text : message.value;
}

function currentActionValue(element, message = {}) {
  if (!element) {
    return undefined;
  }
  if (message.action === 'check') {
    return Boolean(element.checked);
  }
  if ('value' in element) {
    return element.value;
  }
  if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
    return element.textContent || '';
  }
  return undefined;
}

function snapshotHasObservableChange(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }
  if (snapshot.delta && typeof snapshot.delta === 'object') {
    return snapshot.delta.unchanged === false;
  }
  return false;
}

function verifyActionResult(message = {}, snapshot, context = {}) {
  const action = message.action;
  const expectedValue = expectedActionValue(message);
  const currentValue = currentActionValue(context.targetElement, message);
  if (['fill', 'type', 'clear', 'select', 'check'].includes(action) && expectedValue !== undefined) {
    if (String(currentValue) === String(expectedValue)) {
      return {
        status: 'succeeded',
        expected: ['target value matches requested input'],
        observed: ['target value matched'],
        evidence: ['target value matched requested text']
      };
    }
    return {
      status: 'failed',
      expected: ['target value matches requested input'],
      observed: ['target value did not match'],
      evidence: ['target value did not match requested text']
    };
  }

  if (snapshotHasObservableChange(snapshot)) {
    return {
      status: 'succeeded',
      expected: ['observable page state change'],
      observed: ['post-action snapshot changed'],
      evidence: ['post-action snapshot changed']
    };
  }

  return {
    status: 'inconclusive',
    expected: ['observable page state change'],
    observed: ['post-action snapshot unchanged'],
    evidence: ['action dispatched but no observable post-condition changed']
  };
}

function withPostActionSnapshot(response, message = {}, context = {}) {
  if (!response || response.ok !== true || message.postActionSnapshot !== 'delta') {
    return response;
  }
  try {
    const postActionSnapshot = collectObservation({
      mode: message.mode || 'tiny',
      maxActionableHandles: message.maxActionableHandles,
      summaryMaxChars: message.summaryMaxChars,
      sincePageStateId: message.sincePageStateId
    });
    return {
      ...response,
      result: {
        ...(response.result || {}),
        dispatch: actionDispatchForMessage(message),
        verification: verifyActionResult(message, postActionSnapshot, context),
        postActionSnapshot
      }
    };
  } catch (error) {
    return {
      ...response,
      result: {
        ...(response.result || {}),
        postActionSnapshotError: {
          code: 'POST_ACTION_SNAPSHOT_FAILED',
          message: error.message || String(error)
        }
      }
    };
  }
}

async function runAction(message) {
  const detectedGates = globalThis.CodexGateDetector
    ? globalThis.CodexGateDetector.detectGates(document)
    : [];
  const gateError = globalThis.CodexGateDetector
    ? globalThis.CodexGateDetector.firstGateError(detectedGates)
    : null;
  if (gateError) {
    return { ok: false, error: gateError };
  }

  if (message.action === 'scroll' && !message.handle) {
    window.scrollBy(message.deltaX || 0, message.deltaY || 0);
    return withPostActionSnapshot({
      ok: true,
      result: { action: 'scrolled', scrollX: window.scrollX, scrollY: window.scrollY }
    }, message);
  }

  const resolved = resolveHandle(message.handle);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const element = resolved.element;

  if (message.action === 'click') {
    const risk = globalThis.CodexActionPolicy.classifyActionRisk({
      action: 'click',
      target: elementSummary(element, message.handle)
    });
    const approvedHighRisk = message.approval &&
      message.approval.allowHighRisk === true &&
      message.approval.approvalKind === (risk && risk.approvalKind);
    if (risk && !approvedHighRisk) {
      return { ok: false, error: risk };
    }
    element.click();
    return withPostActionSnapshot({ ok: true, result: { action: 'clicked' } }, message, {
      targetElement: element
    });
  }

  if (message.action === 'fill' || message.action === 'type') {
    element.focus();
    element.value = message.text || message.value || '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return withPostActionSnapshot({
      ok: true,
      result: { action: message.action === 'type' ? 'typed' : 'filled' }
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'clear') {
    element.focus();
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return withPostActionSnapshot({ ok: true, result: { action: 'cleared' } }, message, {
      targetElement: element
    });
  }

  if (message.action === 'focus') {
    element.focus();
    return withPostActionSnapshot({ ok: true, result: { action: 'focused' } }, message, {
      targetElement: element
    });
  }

  if (message.action === 'select') {
    element.value = message.value || '';
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return withPostActionSnapshot({ ok: true, result: { action: 'selected' } }, message, {
      targetElement: element
    });
  }

  if (message.action === 'check') {
    element.checked = message.checked !== false;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return withPostActionSnapshot({
      ok: true,
      result: { action: 'checked', checked: element.checked }
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'scroll') {
    window.scrollBy(message.deltaX || 0, message.deltaY || 0);
    return withPostActionSnapshot({
      ok: true,
      result: { action: 'scrolled', scrollX: window.scrollX, scrollY: window.scrollY }
    }, message);
  }

  if (message.action === 'pressKey') {
    element.focus();
    const event = new KeyboardEvent('keydown', { key: message.key || 'Enter', bubbles: true });
    element.dispatchEvent(event);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: event.key, bubbles: true }));
    return withPostActionSnapshot({
      ok: true,
      result: { action: 'key-pressed', key: event.key }
    }, message);
  }

  return { ok: false, error: { code: 'UNKNOWN_ACTION' } };
}

async function waitForPageCondition(message) {
  return globalThis.CodexPageWait.waitForCondition({
    condition: message.condition,
    timeoutMs: message.timeoutMs,
    pollIntervalMs: message.pollIntervalMs,
    context: {
      window,
      document,
      location,
      resolveHandle: (handle) => {
        const resolved = resolveHandle(handle);
        return resolved.ok ? resolved.element : null;
      }
    }
  });
}

function batchActionName(action) {
  const requested = action.action || action.type || action.method;
  const methodMap = {
    'page.readPage': 'readPage',
    'content.readPage': 'readPage',
    'page.observe': 'observe',
    'content.observe': 'observe',
    'page.waitFor': 'waitFor',
    'content.waitFor': 'waitFor',
    'page.click': 'click',
    'page.type': 'type',
    'page.fill': 'fill',
    'page.clear': 'clear',
    'page.focus': 'focus',
    'page.select': 'select',
    'page.check': 'check',
    'page.scroll': 'scroll',
    'page.pressKey': 'pressKey'
  };
  return methodMap[requested] || requested;
}

async function runBatchAction(action) {
  const normalizedAction = batchActionName(action || {});

  if (normalizedAction === 'readPage') {
    const response = readPage(action);
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: {
        action: 'readPage',
        ...response.result
      }
    };
  }

  if (normalizedAction === 'observe') {
    return {
      ok: true,
      result: {
        action: 'observe',
        ...collectObservation(action)
      }
    };
  }

  if (normalizedAction === 'waitFor') {
    return waitForPageCondition(action);
  }

  if ([
    'click',
    'type',
    'fill',
    'clear',
    'focus',
    'select',
    'check',
    'scroll',
    'pressKey'
  ].includes(normalizedAction)) {
    return runAction({
      ...action,
      action: normalizedAction
    });
  }

  return {
    ok: false,
    error: {
      code: 'UNKNOWN_BATCH_ACTION',
      message: `Unsupported batch action: ${normalizedAction || 'unknown'}`
    }
  };
}

async function runBatch(message = {}) {
  const actions = Array.isArray(message.actions) ? message.actions : [];
  if (!Array.isArray(message.actions)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message: 'content.batch requires an actions array.'
      }
    };
  }

  const stopOnError = message.stopOnError !== false;
  const results = [];
  let stoppedOnError = false;

  for (const action of actions) {
    let response;
    try {
      response = await runBatchAction(action || {});
    } catch (error) {
      response = {
        ok: false,
        error: {
          code: 'BATCH_ACTION_FAILED',
          message: error.message || String(error)
        }
      };
    }
    results.push(response);
    if (stopOnError && (!response || response.ok === false)) {
      stoppedOnError = true;
      break;
    }
  }

  return {
    ok: true,
    result: {
      origin: location.origin,
      results,
      stoppedOnError
    }
  };
}

async function resolveActionTarget(message) {
  const detectedGates = globalThis.CodexGateDetector
    ? globalThis.CodexGateDetector.detectGates(document)
    : [];
  const gateError = globalThis.CodexGateDetector
    ? globalThis.CodexGateDetector.firstGateError(detectedGates)
    : null;
  if (gateError) {
    return { ok: false, error: gateError };
  }

  const resolved = resolveHandle(message.handle);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const target = elementSummary(resolved.element, message.handle);
  const risk = globalThis.CodexActionPolicy.classifyActionRisk({
    action: message.action,
    target
  });

  return {
    ok: true,
    result: {
      target,
      risk
    }
  };
}

function handleContentMessage(message, sender, sendResponse) {
  (async () => {
    if (message && message.type === 'content.readPage') {
      sendResponse(readPage(message));
      return;
    }

    if (message && message.type === 'content.extract') {
      sendResponse(extractIntent(message));
      return;
    }

    if (message && message.type === 'content.batch') {
      sendResponse(await runBatch(message));
      return;
    }

    if (message && message.type === 'content.observe') {
      sendResponse(collectObservation(message));
      return;
    }

    if (message && message.type === 'content.waitFor') {
      sendResponse(await waitForPageCondition(message));
      return;
    }

    if (message && message.type === 'content.uploadFile') {
      sendResponse(await globalThis.CodexFileUpload.uploadFiles(message, {
        document,
        location,
        window,
        Event,
        resolveHandle
      }));
      return;
    }

    if (message && message.type === 'content.prepareCart') {
      sendResponse(await globalThis.CodexCartWorkflow.prepareCart(message, {
        document,
        location,
        window,
        Event
      }));
      return;
    }

    if (message && message.type === 'content.action') {
      sendResponse(await runAction(message));
      return;
    }

    if (message && message.type === 'content.resolveActionTarget') {
      sendResponse(await resolveActionTarget(message));
      return;
    }

    sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE' } });
  })();
  return true;
}

function installContentScriptListener() {
  if (
    globalThis.__codexContentScriptListener &&
    chrome.runtime.onMessage &&
    typeof chrome.runtime.onMessage.removeListener === 'function'
  ) {
    chrome.runtime.onMessage.removeListener(globalThis.__codexContentScriptListener);
  }
  chrome.runtime.onMessage.addListener(handleContentMessage);
  globalThis.__codexContentScriptListener = handleContentMessage;
  globalThis.__codexContentScriptListenerInstalled = true;
  globalThis.__codexContentScriptVersion = CODEX_CONTENT_SCRIPT_VERSION;
}

installContentScriptListener();
