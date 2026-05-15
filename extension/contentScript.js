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

function implicitRoleForElement(element) {
  const explicitRole = element.getAttribute('role');
  if (explicitRole) {
    return explicitRole;
  }
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute('type') || '').toLowerCase();
  if (tag === 'button') {
    return 'button';
  }
  if (tag === 'a' && element.getAttribute('href')) {
    return 'link';
  }
  if (tag === 'textarea') {
    return 'textbox';
  }
  if (tag === 'select') {
    return 'combobox';
  }
  if (tag === 'input') {
    if (['button', 'submit', 'reset', 'image'].includes(type)) {
      return 'button';
    }
    if (['checkbox', 'radio', 'range'].includes(type)) {
      return type;
    }
    return 'textbox';
  }
  return null;
}

function testIdFromData(data) {
  return data.testid || data.testId || data.testID || data.test || null;
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

function frameElementForDocument(rootNode) {
  try {
    return rootNode &&
      rootNode.defaultView &&
      rootNode.defaultView.frameElement
      ? rootNode.defaultView.frameElement
      : null;
  } catch {
    return null;
  }
}

function targetProvenanceForElement(element) {
  let shadowDepth = 0;
  let frameDepth = 0;
  let frameElement = null;
  let rootNode = element && typeof element.getRootNode === 'function'
    ? element.getRootNode()
    : element && element.ownerDocument;

  for (let guard = 0; rootNode && rootNode !== document && guard < 12; guard += 1) {
    if (rootNode.host) {
      shadowDepth += 1;
      rootNode = typeof rootNode.host.getRootNode === 'function'
        ? rootNode.host.getRootNode()
        : rootNode.host.ownerDocument;
      continue;
    }

    const ownerFrame = frameElementForDocument(rootNode);
    if (ownerFrame) {
      frameDepth += 1;
      frameElement = frameElement || ownerFrame;
      rootNode = typeof ownerFrame.getRootNode === 'function'
        ? ownerFrame.getRootNode()
        : ownerFrame.ownerDocument;
      continue;
    }

    break;
  }

  return compactElementSummary({
    shadowDepth: shadowDepth > 0 ? shadowDepth : null,
    frameDepth: frameDepth > 0 ? frameDepth : null,
    frameTitle: frameElement ? frameElement.getAttribute('title') || frameElement.getAttribute('aria-label') || null : null,
    frameName: frameElement ? frameElement.getAttribute('name') || null : null,
    frameSrc: frameElement ? frameElement.getAttribute('src') || frameElement.src || null : null
  });
}

function targetContractForElement(element, handle, summary) {
  const data = summary.data || {};
  return compactElementSummary({
    version: 1,
    handle,
    tag: summary.tag,
    role: implicitRoleForElement(element),
    type: summary.type || null,
    id: summary.id || null,
    name: summary.name || null,
    href: summary.href || null,
    placeholder: summary.placeholder || null,
    title: summary.title || null,
    label: summary.label || null,
    accessibleName: summary.label || null,
    testid: testIdFromData(data),
    data,
    productId: summary.productId || null,
    bbox: summary.bbox || null,
    context: summary.context || null,
    provenance: targetProvenanceForElement(element)
  });
}

function shouldIncludeTargetContract(options = {}) {
  return options.includeTargetContract === true ||
    options.type === 'content.resolveActionTarget' ||
    options.mode === 'medium' ||
    options.mode === 'full';
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

function isSensitiveFormFillElement(element) {
  if (isSensitiveElement(element)) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && ['hidden', 'password'].includes(type)) {
    return true;
  }
  return /\b(pass(word)?|token|secret|api[-_ ]?key|otp|one[-_ ]?time|2fa|mfa|credit|card|cc-|cvv|cvc)\b/.test(sensitiveFormAttributeText(element));
}

function formValueForElement(element, options = {}) {
  if (!booleanOption(options.includeFormValues)) {
    return null;
  }
  const tag = element.tagName.toLowerCase();
  const contentEditable = element.isContentEditable ||
    element.getAttribute('contenteditable') === 'true' ||
    element.getAttribute('contenteditable') === 'plaintext-only';
  if (!contentEditable && !['input', 'textarea', 'select'].includes(tag)) {
    return null;
  }
  if (isSensitiveFormValueElement(element)) {
    return null;
  }
  const type = (element.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && ['button', 'submit', 'reset', 'file', 'image'].includes(type)) {
    return null;
  }
  const rawValue = contentEditable
    ? (element.textContent || '')
    : tag === 'select'
    ? (element.value || element.getAttribute('value') || '')
    : element.value;
  const maxChars = Number.isFinite(Number(options.maxFieldValueChars))
    ? Math.max(0, Math.floor(Number(options.maxFieldValueChars)))
    : 4000;
  return String(rawValue || '').slice(0, maxChars);
}

function isOccludedElement(element, rect) {
  if (!document || typeof document.elementFromPoint !== 'function' || !rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = Number.isFinite(rect.x) ? rect.x : (Number.isFinite(rect.left) ? rect.left : 0);
  const y = Number.isFinite(rect.y) ? rect.y : (Number.isFinite(rect.top) ? rect.top : 0);
  const centerX = x + rect.width / 2;
  const centerY = y + rect.height / 2;
  const xInset = Math.min(12, Math.max(1, rect.width * 0.25));
  const yInset = Math.min(12, Math.max(1, rect.height * 0.25));
  const points = [
    { x: centerX, y: centerY },
    { x: x + xInset, y: centerY },
    { x: x + rect.width - xInset, y: centerY },
    { x: centerX, y: y + yInset },
    { x: centerX, y: y + rect.height - yInset }
  ];
  try {
    for (const point of points) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (
        !hit ||
        hit === element ||
        (element.contains && element.contains(hit)) ||
        (hit.contains && hit.contains(element))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return null;
  }
}

function stableActionIdentityForElement(element) {
  if (!element || !element.tagName || typeof element.getAttribute !== 'function') {
    return '';
  }
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute('type') || '').toLowerCase();
  const role = implicitRoleForElement(element) || '';
  const testid = element.getAttribute('data-testid') ||
    element.getAttribute('data-test-id') ||
    element.getAttribute('data-test') ||
    '';
  const id = element.id || '';
  const name = element.getAttribute('name') || '';
  const href = typeof element.href === 'string' && element.href
    ? element.href
    : element.getAttribute('href') || '';
  const productId = element.getAttribute('data-product-id') || '';
  const label = element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    '';
  if (![testid, id, name, href, productId, label].some(Boolean)) {
    return '';
  }
  return [
    tag,
    role,
    type,
    testid,
    id,
    name,
    href,
    productId,
    label
  ].join('|');
}

function preferReachableDuplicateElements(elements) {
  const entries = elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      element,
      identity: stableActionIdentityForElement(element),
      occluded: isOccludedElement(element, rect) === true
    };
  });
  const byIdentity = new Map();
  for (const entry of entries) {
    if (!entry.identity) {
      continue;
    }
    const group = byIdentity.get(entry.identity) || [];
    group.push(entry);
    byIdentity.set(entry.identity, group);
  }
  const dropped = new Set();
  for (const group of byIdentity.values()) {
    if (group.length <= 1 || !group.some((entry) => !entry.occluded)) {
      continue;
    }
    for (const entry of group) {
      if (entry.occluded) {
        dropped.add(entry.element);
      }
    }
  }
  return entries
    .filter((entry) => !dropped.has(entry.element))
    .map((entry) => entry.element);
}

function actionabilityErrorForElement(element, action) {
  const rect = element && typeof element.getBoundingClientRect === 'function'
    ? element.getBoundingClientRect()
    : null;
  if (!rect || rect.width <= 0 || rect.height <= 0 || !isVisible(element)) {
    return {
      code: 'ACTIONABILITY_FAILED',
      message: 'The target element is not visible enough for this action.',
      reason: 'TARGET_NOT_VISIBLE',
      action
    };
  }
  if (isOccludedElement(element, rect) === true) {
    return {
      code: 'ACTIONABILITY_FAILED',
      message: 'The target element is covered by another element at the input location.',
      reason: 'TARGET_OCCLUDED',
      action,
      freshObservationRequired: true
    };
  }
  return null;
}

function actionRequiresReachableTarget(action) {
  return ['type', 'fill', 'clear', 'focus', 'pressKey'].includes(action);
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
  const summary = compactElementSummary({
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
    occluded: isOccludedElement(element, rect),
    context: layoutContext(),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  });
  return compactElementSummary({
    ...summary,
    ...(shouldIncludeTargetContract(options)
      ? { targetContract: targetContractForElement(element, handle, summary) }
      : {})
  });
}

var ACTIONABLE_SELECTOR = globalThis.__codexActionableSelector || [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[aria-checked]',
  '[aria-selected]',
  '[aria-expanded]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');
globalThis.__codexActionableSelector = ACTIONABLE_SELECTOR;

function elementMatchesSelectorList(element, selectorList) {
  if (!element || typeof element.matches !== 'function') {
    return false;
  }
  try {
    if (element.matches(selectorList)) {
      return true;
    }
  } catch {
    // Try individual selectors below.
  }
  return String(selectorList || '')
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean)
    .some((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    });
}

function collectFocusedElements() {
  const active = document.activeElement;
  if (
    !active ||
    !active.tagName ||
    active === document.body ||
    active === document.documentElement ||
    !isVisible(active) ||
    typeof active.matches !== 'function'
  ) {
    return [];
  }

  return elementMatchesSelectorList(active, ACTIONABLE_SELECTOR) ? [active] : [];
}

function collectInteractiveElements() {
  return querySelectorAllDeep(ACTIONABLE_SELECTOR).filter(isVisible).slice(0, 200);
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
  const visibleUploadWidgets = querySelectorAllDeep([
    '[data-upload-role]',
    '[data-preview-role]',
    '[data-validation-message]'
  ].join(',')).filter(isVisible);
  const associatedHiddenInputs = querySelectorAllDeep('input[type="file"][data-upload-role]')
    .filter((element) => !isVisible(element) && hasVisibleUploadAssociation(element));

  return [...visibleUploadWidgets, ...associatedHiddenInputs].slice(0, 200);
}

function collectVisualElements() {
  return querySelectorAllDeep([
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
  ].join(',')).filter(isVisible).slice(0, 200);
}

function querySelectorAllSafe(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return [];
  }
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

function sameOriginFrameDocument(element) {
  if (!element || element.tagName !== 'IFRAME') {
    return null;
  }
  try {
    return element.contentDocument || (element.contentWindow && element.contentWindow.document) || null;
  } catch {
    return null;
  }
}

function frameAccessState(element) {
  if (!element || element.tagName !== 'IFRAME') {
    return { accessible: false, document: null };
  }
  try {
    const frameDocument = element.contentDocument || (element.contentWindow && element.contentWindow.document) || null;
    return {
      accessible: Boolean(frameDocument),
      document: frameDocument
    };
  } catch (error) {
    return {
      accessible: false,
      document: null,
      errorCode: 'CROSS_ORIGIN_FRAME_INACCESSIBLE',
      errorMessage: error && error.message ? error.message : String(error)
    };
  }
}

function querySelectorAllDeep(selector, root = document, seen = new Set()) {
  if (!root || seen.has(root)) {
    return [];
  }
  seen.add(root);
  const results = querySelectorAllSafe(root, selector);
  for (const element of querySelectorAllSafe(root, '*')) {
    if (element.shadowRoot) {
      results.push(...querySelectorAllDeep(selector, element.shadowRoot, seen));
    }
    const frameAccess = frameAccessState(element);
    if (frameAccess.document) {
      results.push(...querySelectorAllDeep(selector, frameAccess.document, seen));
    }
  }
  return [...new Set(results)];
}

function collectFrameSummaries() {
  return querySelectorAllSafe(document, 'iframe').map((frame) => {
    const rect = frame.getBoundingClientRect();
    const access = frameAccessState(frame);
    return {
      kind: 'iframe',
      src: frame.getAttribute('src') || frame.src || null,
      title: frame.getAttribute('title') || frame.getAttribute('aria-label') || null,
      accessible: access.accessible,
      ...(access.accessible ? {} : { errorCode: access.errorCode || 'FRAME_DOCUMENT_UNAVAILABLE' }),
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  });
}

function collectObservedElements() {
  return preferReachableDuplicateElements([...new Set([
    ...collectFocusedElements(),
    ...collectInteractiveElements(),
    ...collectVisualElements(),
    ...collectUploadElements()
  ])]).slice(0, 300);
}

var lastObservationSummaries = globalThis.__codexLastObservationSummaries || new Map();
globalThis.__codexLastObservationSummaries = lastObservationSummaries;
var MAX_OBSERVATION_SUMMARIES = 8;
var mutationCounter = Number(globalThis.__codexMutationCounter || 0);
globalThis.__codexMutationCounter = mutationCounter;

if (!globalThis.__codexMutationObserverInstalled && typeof MutationObserver !== 'undefined') {
  try {
    const observer = new MutationObserver((mutations) => {
      globalThis.__codexMutationCounter = Number(globalThis.__codexMutationCounter || 0) + mutations.length;
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
    globalThis.__codexMutationObserverInstalled = true;
  } catch {
    globalThis.__codexMutationObserverInstalled = false;
  }
}

function pageVolatility(pageStateId) {
  const viewport = `${window.innerWidth || 0}x${window.innerHeight || 0}`;
  return {
    mutationCounter: Number(globalThis.__codexMutationCounter || 0),
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    viewport,
    visibilityState: document.visibilityState || null,
    documentId: pageStateId ? `doc_${pageStateId}` : null,
    confidence: 0.88
  };
}

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
  const focusedCandidateIndex = document.activeElement
    ? candidates.indexOf(document.activeElement)
    : -1;
  const focusedHandle = focusedCandidateIndex >= 0
    ? described.items[focusedCandidateIndex].handle
    : null;
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
    frames: collectFrameSummaries(),
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
    focusedElement: document.activeElement ? elementSummary(document.activeElement, focusedHandle, options) : null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio
    },
    volatility: pageVolatility(described.pageStateId),
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

function mediaElementSummary(element, handle) {
  const rect = element.getBoundingClientRect();
  const kind = element.tagName.toLowerCase();
  const src = element.currentSrc || element.src || element.getAttribute('src') || null;
  const label = String(
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('alt') ||
    element.id ||
    ''
  ).replace(/\s+/g, ' ').trim().slice(0, 120);
  return compactElementSummary({
    handle,
    kind,
    id: element.id || null,
    label,
    src,
    poster: element.getAttribute('poster') || null,
    controls: Boolean(element.controls),
    autoplay: Boolean(element.autoplay),
    loop: Boolean(element.loop),
    muted: Boolean(element.muted),
    paused: Boolean(element.paused),
    ended: Boolean(element.ended),
    currentTime: Number.isFinite(Number(element.currentTime)) ? Number(element.currentTime) : null,
    duration: Number.isFinite(Number(element.duration)) ? Number(element.duration) : null,
    volume: Number.isFinite(Number(element.volume)) ? Number(element.volume) : null,
    readyState: Number.isFinite(Number(element.readyState)) ? Number(element.readyState) : null,
    networkState: Number.isFinite(Number(element.networkState)) ? Number(element.networkState) : null,
    videoWidth: kind === 'video' && Number.isFinite(Number(element.videoWidth)) ? Number(element.videoWidth) : null,
    videoHeight: kind === 'video' && Number.isFinite(Number(element.videoHeight)) ? Number(element.videoHeight) : null,
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  });
}

function mediaInspect(message = {}) {
  const allMedia = querySelectorAllDeep('video,audio').filter(isVisible).slice(0, 100);
  const limit = Number.isFinite(Number(message.maxItems))
    ? Math.max(1, Math.min(100, Math.floor(Number(message.maxItems))))
    : 20;
  const described = globalThis.CodexPageHandles.describeElements(allMedia, {
    location,
    document,
    window
  });
  return {
    ok: true,
    result: {
      url: location.href,
      origin: location.origin,
      contentScriptVersion: CODEX_CONTENT_SCRIPT_VERSION,
      media: allMedia.slice(0, limit).map((element, index) => (
        mediaElementSummary(element, described.items[index].handle)
      )),
      limits: {
        maxItems: limit,
        defaultMaxItems: 20,
        availableMedia: allMedia.length
      }
    }
  };
}

function formLabelForControl(element) {
  const explicit = element.getAttribute('aria-label') || element.getAttribute('title');
  if (explicit) {
    return String(explicit).replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  if (element.labels && element.labels.length) {
    return [...element.labels].map((label) => label.innerText || label.textContent || '').join(' ')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((label) => label.innerText || label.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    return String(placeholder).replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return String(element.getAttribute('name') || element.id || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function fieldValidationState(element) {
  const validity = element.validity || {};
  const valid = typeof element.checkValidity === 'function'
    ? Boolean(element.checkValidity())
    : (validity.valid === undefined ? null : Boolean(validity.valid));
  return {
    valid,
    message: element.validationMessage || null,
    pattern: element.getAttribute('pattern') || null,
    min: element.getAttribute('min') || null,
    max: element.getAttribute('max') || null,
    maxLength: Number.isFinite(Number(element.getAttribute('maxlength')))
      ? Number(element.getAttribute('maxlength'))
      : null
  };
}

function formFieldSummary(element, handle, options = {}) {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || tag).toLowerCase();
  const sensitive = isSensitiveFormValueElement(element);
  const rawValue = tag === 'select'
    ? (element.value || element.getAttribute('value') || '')
    : (element.value || '');
  const includeValues = options.includeValues === true;
  return compactElementSummary({
    fieldId: element.id || element.getAttribute('name') || handle,
    handle,
    tag,
    type,
    name: element.getAttribute('name') || null,
    label: formLabelForControl(element),
    autocomplete: element.getAttribute('autocomplete') || null,
    placeholder: element.getAttribute('placeholder') || null,
    required: Boolean(element.required || element.getAttribute('required') !== null),
    disabled: Boolean(element.disabled),
    sensitive,
    value: includeValues
      ? (sensitive && rawValue ? '[REDACTED]' : String(rawValue).slice(0, 4000))
      : null,
    validation: fieldValidationState(element)
  });
}

function collectFormFields() {
  return querySelectorAllDeep('input,textarea,select')
    .filter((element) => {
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute('type') || '').toLowerCase();
      return tag !== 'input' || !['button', 'submit', 'reset', 'file', 'image', 'hidden'].includes(type);
    })
    .filter(isVisible)
    .slice(0, 200);
}

function resolveFormFieldHandle(handle) {
  return resolveVersionedHandleFromElements(handle, collectFormFields());
}

function formExtract(message = {}) {
  const fields = collectFormFields();
  const submitTargets = querySelectorAllDeep('button,input[type="submit"],[role="button"]')
    .filter(isVisible)
    .slice(0, 50);
  const describedFields = globalThis.CodexPageHandles.describeElements(fields, { location, document, window });
  const describedSubmits = globalThis.CodexPageHandles.describeElements(submitTargets, { location, document, window });
  const fieldsByForm = new Map();
  fields.forEach((field, index) => {
    const form = typeof field.closest === 'function' ? field.closest('form') : null;
    const formId = form && (form.id || form.getAttribute('name')) ? (form.id || form.getAttribute('name')) : 'form_default';
    if (!fieldsByForm.has(formId)) {
      fieldsByForm.set(formId, { form, fields: [] });
    }
    fieldsByForm.get(formId).fields.push(formFieldSummary(field, describedFields.items[index].handle, {
      includeValues: message.includeValues === true
    }));
  });

  const forms = [...fieldsByForm.entries()].map(([formId, entry]) => {
    const relatedSubmits = submitTargets
      .map((target, index) => ({ target, item: describedSubmits.items[index] }))
      .filter(({ target }) => {
        const targetForm = typeof target.closest === 'function' ? target.closest('form') : null;
        return (targetForm && entry.form && targetForm === entry.form) || (!entry.form && !targetForm);
      })
      .map(({ target, item }) => elementSummary(target, item.handle));
    const highRisk = relatedSubmits.some((target) => {
      const risk = globalThis.CodexActionPolicy.classifyActionRisk({ action: 'click', target });
      return Boolean(risk);
    });
    return {
      formId,
      fields: entry.fields,
      submitTargets: relatedSubmits,
      risk: {
        level: highRisk ? 'high' : 'low',
        reasons: highRisk ? ['high-risk-submit-target'] : []
      }
    };
  });

  return {
    ok: true,
    result: {
      url: location.href,
      origin: location.origin,
      forms,
      limits: {
        availableFields: fields.length,
        availableSubmitTargets: submitTargets.length
      }
    }
  };
}

function formFillPlan(message = {}) {
  const fields = Array.isArray(message.fields) ? message.fields : [];
  const steps = [];
  for (const field of fields) {
    const resolved = resolveFormFieldHandle(field.handle);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const summary = formFieldSummary(resolved.element, field.handle, { includeValues: false });
    const sensitiveFill = isSensitiveFormFillElement(resolved.element);
    steps.push({
      action: 'fill',
      handle: field.handle,
      text: String(field.text || field.value || ''),
      fieldId: summary.fieldId,
      label: summary.label,
      sensitive: sensitiveFill,
      risk: sensitiveFill ? 'sensitive' : 'low'
    });
  }
  const requiresUserApproval = steps.some((step) => step.sensitive === true);
  return {
    ok: true,
    result: {
      steps,
      submit: null,
      requiresUserApproval
    }
  };
}

async function formFillExecute(message = {}) {
  const steps = Array.isArray(message.steps) ? message.steps : [];
  const sensitiveFormFillPolicyDisabled = message.policy &&
    message.policy.sensitiveFormFillEnabled === false;
  const approvedSensitiveFill = sensitiveFormFillPolicyDisabled || (
    message.approval &&
    message.approval.allowSensitiveFormFill === true &&
    (
      message.approval.approvalKind === 'sensitive-form-fill' ||
      message.approval.approvalKind === 'policy-disabled'
    )
  );
  const executed = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || step.action !== 'fill') {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_FORM_STEP',
          message: 'Only fill steps are supported by formFillExecute v1.'
        }
      };
    }
    const resolved = resolveFormFieldHandle(step.handle);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const element = resolved.element;
    const summary = formFieldSummary(element, step.handle, { includeValues: false });
    if ((step.sensitive === true || isSensitiveFormFillElement(element)) && !approvedSensitiveFill) {
      return {
        ok: false,
        error: {
          code: 'SENSITIVE_FORM_FILL_BLOCKED',
          message: 'Sensitive form fields require explicit user approval before filling.',
          approvalKind: 'sensitive-form-fill',
          actionIndex: index,
          targetSummary: summary.label || summary.fieldId || step.handle || 'sensitive field'
        }
      };
    }
    element.focus();
    const fillResult = setEditableText(element, step.text || step.value || '', 'fill');
    if (!fillResult.ok) {
      return fillResult;
    }
    executed.push({ handle: step.handle, action: 'fill' });
  }
  const invalidFields = collectFormFields()
    .map((field) => formFieldSummary(field, null, { includeValues: false }))
    .filter((field) => field.validation && field.validation.valid === false);
  return {
    ok: true,
    result: {
      executed,
      invalidFields
    }
  };
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

function isContentEditableElement(element) {
  if (!element) {
    return false;
  }
  const attrValue = typeof element.getAttribute === 'function'
    ? String(element.getAttribute('contenteditable') || '').toLowerCase()
    : '';
  return element.isContentEditable === true || attrValue === 'true' || attrValue === 'plaintext-only';
}

function prototypeValueDescriptorForElement(element) {
  if (!element) {
    return null;
  }
  const ownerDocument = element.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const tag = String(element.tagName || '').toLowerCase();
  const prototypes = [];
  if (tag === 'input' && ownerWindow.HTMLInputElement) {
    prototypes.push(ownerWindow.HTMLInputElement.prototype);
  } else if (tag === 'textarea' && ownerWindow.HTMLTextAreaElement) {
    prototypes.push(ownerWindow.HTMLTextAreaElement.prototype);
  } else if (tag === 'select' && ownerWindow.HTMLSelectElement) {
    prototypes.push(ownerWindow.HTMLSelectElement.prototype);
  }
  let prototype = Object.getPrototypeOf(element);
  while (prototype) {
    prototypes.push(prototype);
    prototype = Object.getPrototypeOf(prototype);
  }
  for (const candidate of prototypes) {
    const descriptor = candidate && Object.getOwnPropertyDescriptor(candidate, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      return descriptor;
    }
  }
  return null;
}

function dispatchEditableInputEvents(element, options = {}) {
  const inputType = options.inputType || 'insertReplacementText';
  const data = options.data ?? null;
  try {
    if (typeof InputEvent === 'function') {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType,
        data
      }));
    } else {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (_error) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function setFormControlText(element, value, action = 'fill') {
  const text = String(value ?? '');
  const descriptor = prototypeValueDescriptorForElement(element);
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(element, text);
  } else {
    element.value = text;
  }
  const inputType = text === ''
    ? 'deleteContentBackward'
    : (action === 'type' ? 'insertText' : 'insertReplacementText');
  dispatchEditableInputEvents(element, {
    inputType,
    data: text === '' ? null : text
  });
  return { ok: true };
}

function setContentEditableText(element, value, action = 'fill') {
  const text = String(value ?? '');
  const ownerDocument = element.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const getSelection = typeof ownerWindow.getSelection === 'function'
    ? () => ownerWindow.getSelection()
    : (typeof ownerDocument.getSelection === 'function' ? () => ownerDocument.getSelection() : null);
  if (
    typeof ownerDocument.createRange !== 'function' ||
    typeof ownerDocument.execCommand !== 'function' ||
    typeof getSelection !== 'function'
  ) {
    return {
      ok: false,
      error: {
        code: 'TARGET_EDIT_COMMAND_UNAVAILABLE',
        message: 'The contenteditable target cannot be edited through browser editing commands.'
      }
    };
  }
  const selection = getSelection();
  if (!selection || typeof selection.removeAllRanges !== 'function' || typeof selection.addRange !== 'function') {
    return {
      ok: false,
      error: {
        code: 'TARGET_SELECTION_UNAVAILABLE',
        message: 'The contenteditable target cannot be selected for editing.'
      }
    };
  }
  const range = ownerDocument.createRange();
  if (!range || typeof range.selectNodeContents !== 'function') {
    return {
      ok: false,
      error: {
        code: 'TARGET_SELECTION_UNAVAILABLE',
        message: 'The contenteditable target cannot be selected for editing.'
      }
    };
  }
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  const command = text === '' ? 'delete' : 'insertText';
  const commandValue = text === '' ? null : text;
  if (!ownerDocument.execCommand(command, false, commandValue)) {
    return {
      ok: false,
      error: {
        code: 'TARGET_EDIT_COMMAND_FAILED',
        message: `The contenteditable target rejected the ${command} edit command.`
      }
    };
  }
  const inputType = text === ''
    ? 'deleteContentBackward'
    : (action === 'type' ? 'insertText' : 'insertReplacementText');
  dispatchEditableInputEvents(element, {
    inputType,
    data: text === '' ? null : text
  });
  return { ok: true, command };
}

function setEditableText(element, value, action = 'fill') {
  if (isContentEditableElement(element)) {
    return setContentEditableText(element, value, action);
  }
  if ('value' in element) {
    return setFormControlText(element, value, action);
  }
  return {
    ok: false,
    error: {
      code: 'TARGET_NOT_EDITABLE',
      message: 'The target element cannot receive text input.'
    }
  };
}

function currentActionValue(element, message = {}) {
  if (!element) {
    return undefined;
  }
  if (message.action === 'check') {
    return Boolean(element.checked);
  }
  if (isContentEditableElement(element)) {
    return element.textContent || '';
  }
  if ('value' in element) {
    return element.value;
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

function pageTextNow() {
  const pieces = [];
  const seen = new Set();
  function visit(node) {
    if (!node || seen.has(node)) {
      return;
    }
    seen.add(node);
    const ownText = node.innerText || node.textContent || '';
    if (ownText) {
      pieces.push(ownText);
    }
    for (const child of node.children || []) {
      visit(child);
    }
  }
  visit(document.body);
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

function articleTextAppearsNow(text) {
  const expected = String(text || '').trim();
  if (!expected) {
    return false;
  }
  const articles = [];
  const seen = new Set();
  function visit(node) {
    if (!node || seen.has(node)) {
      return;
    }
    seen.add(node);
    const tag = String(node.tagName || '').toLowerCase();
    const role = typeof node.getAttribute === 'function' ? String(node.getAttribute('role') || '').toLowerCase() : '';
    if (tag === 'article' || role === 'article') {
      articles.push(node);
    }
    for (const child of node.children || []) {
      visit(child);
    }
  }
  visit(document.body);
  return articles.some((article) => {
    const value = String(article.innerText || article.textContent || '').replace(/\s+/g, ' ').trim();
    return value.includes(expected);
  });
}

function elementEnabledByHandle(handle) {
  const resolved = handle ? resolveHandle(handle) : null;
  if (!resolved || !resolved.ok) {
    return false;
  }
  return !resolved.element.disabled;
}

function verifyExplicitConditions(message = {}, snapshot, context = {}) {
  const conditions = message.verify && Array.isArray(message.verify.oneOf)
    ? message.verify.oneOf
    : [];
  if (conditions.length === 0) {
    return null;
  }

  const evidence = [];
  const observed = [];
  for (const condition of conditions) {
    if (!condition || typeof condition.type !== 'string') {
      continue;
    }
    if (condition.type === 'textAppears') {
      const text = String(condition.text || '').trim();
      if (text && pageTextNow().includes(text)) {
        evidence.push(`text appeared: ${text}`);
        observed.push(`text appeared: ${text}`);
      }
    } else if (condition.type === 'textAppearsInArticle') {
      const text = String(condition.text || '').trim();
      if (articleTextAppearsNow(text)) {
        evidence.push(`article text appeared: ${text}`);
        observed.push(`article text appeared: ${text}`);
      }
    } else if (condition.type === 'elementGone') {
      const handle = condition.handle || (context.targetHandle || message.handle);
      const present = (snapshot && Array.isArray(snapshot.elements) ? snapshot.elements : [])
        .some((element) => element.handle === handle);
      if (handle && !present) {
        evidence.push(`element gone: ${handle}`);
        observed.push(`element gone: ${handle}`);
      }
    } else if (condition.type === 'elementEnabled') {
      const handle = condition.handle || (context.targetHandle || message.handle);
      if (handle && elementEnabledByHandle(handle)) {
        evidence.push(`element enabled: ${handle}`);
        observed.push(`element enabled: ${handle}`);
      }
    } else if (condition.type === 'valueEquals') {
      const handle = condition.handle || (context.targetHandle || message.handle);
      const resolved = handle ? resolveHandle(handle) : null;
      const value = resolved && resolved.ok ? currentActionValue(resolved.element, { action: 'fill' }) : undefined;
      if (String(value) === String(condition.value || '')) {
        evidence.push(`value matched: ${handle}`);
        observed.push(`value matched: ${handle}`);
      }
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'succeeded',
      expected: conditions.map((condition) => condition.type),
      observed,
      evidence
    };
  }

  return {
    status: 'failed',
    expected: conditions.map((condition) => condition.type),
    observed: ['no explicit post-condition matched'],
    evidence: ['explicit post-condition did not match']
  };
}

function verifyActionResult(message = {}, snapshot, context = {}) {
  const explicit = verifyExplicitConditions(message, snapshot, context);
  if (explicit) {
    return explicit;
  }

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

  const navigationHref = navigationHrefForElement(context.targetElement);
  if (action === 'click' && navigationHref) {
    return {
      status: 'succeeded',
      expected: ['navigation handoff'],
      observed: ['click target had a navigable href'],
      evidence: ['navigation target changed']
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

function navigationHrefForElement(element) {
  if (!element || String(element.tagName || '').toLowerCase() !== 'a') {
    return null;
  }
  const rawHref = typeof element.getAttribute === 'function'
    ? element.getAttribute('href')
    : element.href;
  const href = String(rawHref || '').trim();
  if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
    return null;
  }
  if (typeof URL !== 'function') {
    return /^https?:\/\//i.test(href) ? href : null;
  }
  try {
    const resolved = new URL(href, location.href);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : null;
  } catch (_error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = typeof setTimeout === 'function'
      ? setTimeout
      : (window && typeof window.setTimeout === 'function' ? window.setTimeout.bind(window) : null);
    if (!timer) {
      resolve();
      return;
    }
    timer(resolve, ms);
  });
}

function postActionVerifyDelayMs(message = {}) {
  const delay = Number(message.postActionVerifyDelayMs);
  if (!Number.isFinite(delay) || delay <= 0) {
    return 0;
  }
  return Math.min(10000, Math.floor(delay));
}

async function withPostActionSnapshot(response, message = {}, context = {}) {
  if (!response || response.ok !== true || message.postActionSnapshot !== 'delta') {
    return response;
  }
  try {
    const verifyDelayMs = postActionVerifyDelayMs(message);
    if (verifyDelayMs > 0) {
      await sleep(verifyDelayMs);
    }
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
        verification: verifyActionResult(message, postActionSnapshot, {
          ...context,
          targetHandle: message.handle
        }),
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

  if (actionRequiresReachableTarget(message.action)) {
    const actionabilityError = actionabilityErrorForElement(element, message.action);
    if (actionabilityError) {
      return { ok: false, error: actionabilityError };
    }
  }

  if (message.action === 'click') {
    if (!(message.policy && message.policy.highRiskEnabled === false)) {
      const risk = globalThis.CodexActionPolicy.classifyActionRisk({
        action: 'click',
        target: elementSummary(element, message.handle)
      });
      const approvedHighRisk = message.approval &&
        message.approval.allowHighRisk === true &&
        (message.approval.approvalKind === (risk && risk.approvalKind) ||
          message.approval.approvalKind === 'policy-disabled');
      if (risk && !approvedHighRisk) {
        return { ok: false, error: risk };
      }
    }
    element.click();
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace({ action: 'clicked' }, 'click', element, message.handle, message)
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'fill' || message.action === 'type') {
    element.focus();
    const textResult = setEditableText(element, message.text || message.value || '', message.action);
    if (!textResult.ok) {
      return textResult;
    }
    const traceAction = message.action === 'type' ? 'type' : 'fill';
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace(
        { action: message.action === 'type' ? 'typed' : 'filled' },
        traceAction,
        element,
        message.handle,
        message
      )
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'clear') {
    element.focus();
    const textResult = setEditableText(element, '', 'clear');
    if (!textResult.ok) {
      return textResult;
    }
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace({ action: 'cleared' }, 'clear', element, message.handle, message)
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'focus') {
    element.focus();
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace({ action: 'focused' }, 'focus', element, message.handle, message)
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'select') {
    const selectResult = setFormControlText(element, message.value || '', 'select');
    if (!selectResult.ok) {
      return selectResult;
    }
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace({ action: 'selected' }, 'select', element, message.handle, message)
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'check') {
    element.checked = message.checked !== false;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace(
        { action: 'checked', checked: element.checked },
        'check',
        element,
        message.handle,
        message
      )
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'scroll') {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.scrollBy(message.deltaX || 0, message.deltaY || 0);
    return withPostActionSnapshot({
      ok: true,
      result: {
        action: 'scrolled',
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        handle: message.handle
      }
    }, message, {
      targetElement: element
    });
  }

  if (message.action === 'pressKey') {
    element.focus();
    const event = new KeyboardEvent('keydown', { key: message.key || 'Enter', bubbles: true });
    element.dispatchEvent(event);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: event.key, bubbles: true }));
    return withPostActionSnapshot({
      ok: true,
      result: resultWithActionTrace({ action: 'key-pressed', key: event.key }, 'pressKey', element, message.handle, message)
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
      },
      mutationCounter: () => Number(globalThis.__codexMutationCounter || 0)
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
    const actionWithPolicy = action && typeof action === 'object'
      ? {
        ...action,
        ...(action.approval === undefined && message.approval !== undefined
          ? { approval: message.approval }
          : {}),
        policy: {
          ...(message.policy && typeof message.policy === 'object' ? message.policy : {}),
          ...(action.policy && typeof action.policy === 'object' ? action.policy : {})
        }
      }
      : action;
    if (actionWithPolicy && actionWithPolicy.policy && Object.keys(actionWithPolicy.policy).length === 0) {
      delete actionWithPolicy.policy;
    }
    let response;
    try {
      response = await runBatchAction(actionWithPolicy || {});
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

  const firstFailureIndex = results.findIndex((response) => !response || response.ok === false);
  if (firstFailureIndex !== -1) {
    const failed = results[firstFailureIndex] || {};
    return {
      ok: false,
      error: {
        ...(failed.error || {
          code: 'BATCH_ACTION_FAILED',
          message: 'A batch child action failed.'
        }),
        actionIndex: firstFailureIndex
      },
      result: {
        origin: location.origin,
        results,
        stoppedOnError
      }
    };
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

function normalizeLocatorText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function elementLocatorText(element) {
  return normalizeLocatorText([
    element.getAttribute('aria-label') || '',
    element.getAttribute('title') || '',
    element.innerText || '',
    element.getAttribute('placeholder') || '',
    element.getAttribute('name') || ''
  ].join(' '));
}

function resolveLocator(message = {}) {
  const selector = typeof message.selector === 'string' ? message.selector.trim() : '';
  const text = normalizeLocatorText(message.text);
  if (!selector && !text) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message: 'Locator requires selector or text.'
      }
    };
  }
  if (selector.length > 300) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message: 'Locator selector is too long.'
      }
    };
  }

  let selectorMatches = null;
  if (selector) {
    try {
      document.querySelectorAll(selector);
      selectorMatches = new Set(querySelectorAllDeep(selector));
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SCHEMA',
          message: `Invalid locator selector: ${error.message || String(error)}`
        }
      };
    }
  }

  const candidates = collectObservedElements();
  const described = globalThis.CodexPageHandles.describeElements(candidates, {
    location,
    document,
    window
  });
  const matches = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index];
    if (selectorMatches && !selectorMatches.has(element)) {
      continue;
    }
    if (text && !elementLocatorText(element).includes(text)) {
      continue;
    }
    matches.push({
      element,
      handle: described.items[index].handle
    });
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: 'LOCATOR_NOT_FOUND',
        message: 'Locator matched no visible actionable element.',
        selector: selector || null,
        text: message.text || null
      }
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: 'LOCATOR_NOT_UNIQUE',
        message: 'Locator matched more than one visible actionable element.',
        matchCount: matches.length,
        matches: matches.slice(0, 10).map((match) => elementSummary(match.element, match.handle, message))
      }
    };
  }

  return {
    ok: true,
    result: {
      action: 'resolved',
      selector: selector || null,
      text: message.text || null,
      target: elementSummary(matches[0].element, matches[0].handle, message),
      pageStateId: described.pageStateId
    }
  };
}

globalThis.__codexTargetCueId = globalThis.__codexTargetCueId || 'codex-operator-target-cue';
globalThis.__codexActionTraceCueId = globalThis.__codexActionTraceCueId || 'codex-operator-action-trace';
globalThis.__codexOperatorIndicatorId = globalThis.__codexOperatorIndicatorId || 'codex-operator-active-indicator';

function removeTargetCue() {
  const existing = document.getElementById(globalThis.__codexTargetCueId);
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

function removeElementById(id) {
  const existing = document.getElementById(id);
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

function roundedBbox(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function showActionTraceCue(message = {}) {
  const target = message.element || null;
  const rect = target && typeof target.getBoundingClientRect === 'function'
    ? target.getBoundingClientRect()
    : message.bbox;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return {
      ok: false,
      error: {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Action trace target is not visible enough to mark.'
      }
    };
  }

  removeElementById(globalThis.__codexActionTraceCueId);
  const cue = document.createElement('div');
  cue.id = globalThis.__codexActionTraceCueId;
  cue.setAttribute('aria-hidden', 'true');
  Object.assign(cue.style, {
    position: 'fixed',
    left: `${Math.max(0, rect.x + rect.width / 2 - 14)}px`,
    top: `${Math.max(0, rect.y + rect.height / 2 - 14)}px`,
    width: '28px',
    height: '28px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    border: '3px solid #d93025',
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: 'rgba(217, 48, 37, 0.12)',
    boxShadow: '0 0 0 8px rgba(217, 48, 37, 0.16)'
  });
  const label = document.createElement('div');
  label.textContent = message.label || message.action || 'Codex action';
  Object.assign(label.style, {
    position: 'absolute',
    left: '34px',
    top: '-2px',
    maxWidth: '220px',
    padding: '3px 7px',
    borderRadius: '4px',
    background: '#d93025',
    color: '#fff',
    font: '12px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  });
  cue.appendChild(label);
  document.documentElement.appendChild(cue);
  const durationMs = Number.isFinite(Number(message.durationMs))
    ? Math.max(100, Math.min(10000, Math.trunc(Number(message.durationMs))))
    : 1800;
  window.setTimeout(() => removeElementById(globalThis.__codexActionTraceCueId), durationMs);
  return {
    ok: true,
    result: {
      visible: true,
      action: message.action || null,
      label: message.label || null,
      durationMs,
      bbox: roundedBbox(rect)
    }
  };
}

function actionTraceForElement(action, element, handle, message = {}) {
  if (message.actionTrace !== true || !element) {
    return null;
  }
  const summary = elementSummary(element, handle, message);
  const label = typeof message.actionTraceLabel === 'string' && message.actionTraceLabel.trim()
    ? message.actionTraceLabel.trim().slice(0, 120)
    : `${action} ${summary.label || summary.tag || 'target'}`.slice(0, 120);
  showActionTraceCue({
    element,
    action,
    label,
    durationMs: message.actionTraceDurationMs
  });
  return {
    action,
    label,
    target: {
      handle,
      tag: summary.tag || null,
      label: summary.label || null,
      bbox: summary.bbox || null
    }
  };
}

function resultWithActionTrace(result, action, element, handle, message = {}) {
  const actionTrace = actionTraceForElement(action, element, handle, message);
  return actionTrace ? { ...result, actionTrace } : result;
}

function showOperatorIndicator(message = {}) {
  if (message.active === false) {
    removeElementById(globalThis.__codexOperatorIndicatorId);
    return { ok: true, result: { visible: false } };
  }

  removeElementById(globalThis.__codexOperatorIndicatorId);
  const indicator = document.createElement('div');
  indicator.id = globalThis.__codexOperatorIndicatorId;
  indicator.setAttribute('role', 'status');
  indicator.textContent = message.label || 'Codex Operator active';
  Object.assign(indicator.style, {
    position: 'fixed',
    left: '50%',
    bottom: '16px',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    maxWidth: 'min(520px, calc(100vw - 32px))',
    padding: '8px 10px',
    borderRadius: '6px',
    background: '#202124',
    color: '#fff',
    boxShadow: '0 8px 24px rgba(60, 64, 67, 0.28)',
    font: '12px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  });
  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.textContent = 'Stop';
  Object.assign(stopButton.style, {
    border: '0',
    borderRadius: '4px',
    padding: '4px 8px',
    background: '#fce8e6',
    color: '#a50e0e',
    font: '12px/16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    cursor: 'pointer'
  });
  stopButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'operator.emergencyStop',
      reason: message.stopReason || 'Stopped from page indicator.',
      source: 'page-indicator'
    }).catch(() => {});
  });
  indicator.appendChild(stopButton);
  document.documentElement.appendChild(indicator);
  return {
    ok: true,
    result: {
      visible: true,
      label: message.label || 'Codex Operator active'
    }
  };
}

function resolveTargetCueElement(message = {}) {
  const handle = typeof message.handle === 'string' ? message.handle.trim() : '';
  if (handle) {
    const resolved = resolveHandle(handle);
    if (!resolved || !resolved.ok || !resolved.element) {
      return {
        ok: false,
        error: resolved && resolved.error ? resolved.error : {
          code: 'HANDLE_NOT_FOUND',
          message: 'Target handle could not be resolved.'
        }
      };
    }
    return { ok: true, element: resolved.element, handle };
  }

  const locator = resolveLocator(message);
  if (!locator || !locator.ok) {
    return locator;
  }
  const targetHandle = locator.result && locator.result.target && locator.result.target.handle;
  const resolved = targetHandle ? resolveHandle(targetHandle) : null;
  if (!resolved || !resolved.ok || !resolved.element) {
    return {
      ok: false,
      error: {
        code: 'LOCATOR_TARGET_STALE',
        message: 'Locator resolved, but the target element was not available for highlighting.'
      }
    };
  }
  return { ok: true, element: resolved.element, handle: targetHandle, pageStateId: locator.result.pageStateId };
}

function showTargetCue(message = {}) {
  const resolved = resolveTargetCueElement(message);
  if (!resolved || !resolved.ok) {
    return resolved;
  }
  const rect = resolved.element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return {
      ok: false,
      error: {
        code: 'TARGET_NOT_VISIBLE',
        message: 'Target element is not visible enough to highlight.'
      }
    };
  }

  removeTargetCue();
  const cue = document.createElement('div');
  cue.id = globalThis.__codexTargetCueId;
  cue.setAttribute('aria-hidden', 'true');
  Object.assign(cue.style, {
    position: 'fixed',
    left: `${Math.max(0, rect.left - 3)}px`,
    top: `${Math.max(0, rect.top - 3)}px`,
    width: `${Math.max(1, rect.width + 6)}px`,
    height: `${Math.max(1, rect.height + 6)}px`,
    zIndex: '2147483647',
    pointerEvents: 'none',
    border: '3px solid #1a73e8',
    borderRadius: '6px',
    boxSizing: 'border-box',
    boxShadow: '0 0 0 4px rgba(26, 115, 232, 0.22), 0 0 0 9999px rgba(26, 115, 232, 0.08)',
    background: 'rgba(26, 115, 232, 0.06)'
  });
  const label = document.createElement('div');
  label.textContent = 'Codex target';
  Object.assign(label.style, {
    position: 'absolute',
    left: '0',
    top: '-28px',
    maxWidth: '220px',
    padding: '3px 7px',
    borderRadius: '4px',
    background: '#1a73e8',
    color: '#fff',
    font: '12px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  });
  cue.appendChild(label);
  document.documentElement.appendChild(cue);

  const durationMs = Number.isFinite(Number(message.durationMs))
    ? Math.max(100, Math.min(10000, Math.trunc(Number(message.durationMs))))
    : 1500;
  window.setTimeout(removeTargetCue, durationMs);
  return {
    ok: true,
    result: {
      highlighted: true,
      durationMs,
      pageStateId: resolved.pageStateId || null,
      target: elementSummary(resolved.element, resolved.handle, message)
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

    if (message && message.type === 'content.mediaInspect') {
      sendResponse(mediaInspect(message));
      return;
    }

    if (message && message.type === 'content.formExtract') {
      sendResponse(formExtract(message));
      return;
    }

    if (message && message.type === 'content.formFillPlan') {
      sendResponse(formFillPlan(message));
      return;
    }

    if (message && message.type === 'content.formFillExecute') {
      sendResponse(await formFillExecute(message));
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

    if (message && message.type === 'content.prepareFileUpload') {
      sendResponse(globalThis.CodexFileUpload.prepareNativeFileUpload(message, {
        document,
        location,
        window,
        Event,
        resolveHandle
      }));
      return;
    }

    if (message && message.type === 'content.completeFileUpload') {
      sendResponse(globalThis.CodexFileUpload.completeNativeFileUpload(message, {
        document,
        location,
        window,
        Event
      }));
      return;
    }

    if (message && message.type === 'content.clearFileUploadMarker') {
      sendResponse(globalThis.CodexFileUpload.clearNativeFileUploadMarker(message, {
        document,
        location,
        window,
        Event
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

    if (message && message.type === 'content.resolveLocator') {
      sendResponse(resolveLocator(message));
      return;
    }

    if (message && message.type === 'content.showTarget') {
      sendResponse(showTargetCue(message));
      return;
    }

    if (message && message.type === 'content.operatorIndicator') {
      sendResponse(showOperatorIndicator(message));
      return;
    }

    if (message && message.type === 'content.actionTrace') {
      sendResponse(showActionTraceCue(message));
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
