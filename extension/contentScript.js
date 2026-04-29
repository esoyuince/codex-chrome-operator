'use strict';

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

function visualRoleForElement(element) {
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

function elementSummary(element, handle) {
  const rect = element.getBoundingClientRect();
  const dataRisk = element.getAttribute('data-risk') || null;
  const label = element.getAttribute('aria-label') ||
    element.innerText ||
    element.value ||
    element.getAttribute('placeholder') ||
    element.getAttribute('name') ||
    '';

  const visualRole = visualRoleForElement(element);
  const ratingValue = numericAttribute(element, 'data-rating');
  return {
    handle,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || null,
    type: element.getAttribute('type') || null,
    name: element.getAttribute('name') || null,
    id: element.id || null,
    dataRisk,
    data: dataAttributes(element),
    visualRole,
    productId: element.getAttribute('data-product-id') || null,
    analyzerField: element.getAttribute('data-analyzer-field') || null,
    ratingValue,
    sensitive: isSensitiveElement(element),
    label: String(label).trim().slice(0, 200),
    disabled: Boolean(element.disabled),
    bbox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function collectInteractiveElements() {
  return [...document.querySelectorAll(
    'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
  )].filter(isVisible).slice(0, 200);
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
    '[role="dialog"]',
    '[role="status"]',
    '[role="alert"]'
  ].join(','))].filter(isVisible).slice(0, 200);
}

function collectObservedElements() {
  return [...new Set([...collectInteractiveElements(), ...collectVisualElements()])].slice(0, 300);
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

function collectObservation() {
  const candidates = collectObservedElements();
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

  return {
    url: location.href,
    origin: location.origin,
    title: document.title,
    pageStateId: described.pageStateId,
    visibleTextSummary: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 2000),
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
    elements: candidates.map((element, index) => elementSummary(element, described.items[index].handle)),
    focusedElement: document.activeElement ? elementSummary(document.activeElement, null) : null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio
    }
  };
}

function resolveHandle(handle) {
  const candidates = collectObservedElements();
  return globalThis.CodexPageHandles.resolveVersionedHandle({
    handle,
    elements: candidates,
    context: {
      location,
      document,
      window
    }
  });
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
    return { ok: true, result: { action: 'clicked' } };
  }

  if (message.action === 'fill' || message.action === 'type') {
    element.focus();
    element.value = message.text || message.value || '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: { action: message.action === 'type' ? 'typed' : 'filled' } };
  }

  if (message.action === 'clear') {
    element.focus();
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: { action: 'cleared' } };
  }

  if (message.action === 'focus') {
    element.focus();
    return { ok: true, result: { action: 'focused' } };
  }

  if (message.action === 'select') {
    element.value = message.value || '';
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: { action: 'selected' } };
  }

  if (message.action === 'check') {
    element.checked = message.checked !== false;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: { action: 'checked', checked: element.checked } };
  }

  if (message.action === 'scroll') {
    window.scrollBy(message.deltaX || 0, message.deltaY || 0);
    return { ok: true, result: { action: 'scrolled', scrollX: window.scrollX, scrollY: window.scrollY } };
  }

  if (message.action === 'pressKey') {
    element.focus();
    const event = new KeyboardEvent('keydown', { key: message.key || 'Enter', bubbles: true });
    element.dispatchEvent(event);
    return { ok: true, result: { action: 'key-pressed', key: event.key } };
  }

  return { ok: false, error: { code: 'UNKNOWN_ACTION' } };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message && message.type === 'content.observe') {
      sendResponse(collectObservation());
      return;
    }

    if (message && message.type === 'content.waitFor') {
      sendResponse(await globalThis.CodexPageWait.waitForCondition({
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
      }));
      return;
    }

    if (message && message.type === 'content.action') {
      sendResponse(await runAction(message));
      return;
    }

    sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE' } });
  })();
  return true;
});
