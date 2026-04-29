'use strict';

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    rect.width > 0 &&
    rect.height > 0;
}

function elementSummary(element, index) {
  const rect = element.getBoundingClientRect();
  const dataRisk = element.getAttribute('data-risk') || null;
  const label = element.getAttribute('aria-label') ||
    element.innerText ||
    element.value ||
    element.getAttribute('placeholder') ||
    element.getAttribute('name') ||
    '';

  return {
    handle: `el_${index}`,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || null,
    type: element.getAttribute('type') || null,
    name: element.getAttribute('name') || null,
    id: element.id || null,
    dataRisk,
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

function collectObservation() {
  const candidates = [...document.querySelectorAll(
    'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
  )].filter(isVisible).slice(0, 200);

  return {
    url: location.href,
    origin: location.origin,
    title: document.title,
    visibleTextSummary: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 2000),
    elements: candidates.map(elementSummary),
    focusedElement: document.activeElement ? elementSummary(document.activeElement, 'focused') : null,
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
  const observation = collectObservation();
  const item = observation.elements.find((element) => element.handle === handle);
  if (!item) {
    return null;
  }
  const candidates = [...document.querySelectorAll(
    'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
  )].filter(isVisible);
  const index = Number(String(handle).replace('el_', ''));
  return candidates[index] || null;
}

async function runAction(message) {
  const element = resolveHandle(message.handle);
  if (!element) {
    return { ok: false, error: { code: 'STALE_HANDLE' } };
  }

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

    if (message && message.type === 'content.action') {
      sendResponse(await runAction(message));
      return;
    }

    sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE' } });
  })();
  return true;
});
