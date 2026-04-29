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
    element.click();
    return { ok: true, result: { action: 'clicked' } };
  }

  if (message.action === 'fill') {
    element.focus();
    element.value = message.text || '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: { action: 'filled' } };
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
