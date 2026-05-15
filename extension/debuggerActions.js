(function initDebuggerActions(root) {
  'use strict';

  const DEBUGGER_PROTOCOL_VERSION = '1.3';
  const DEBUGGER_ACTION_PROVIDER = 'chrome.debugger.Runtime.evaluate';
  const DEBUGGER_POINTER_PROVIDER = 'chrome.debugger.Input.dispatchMouseEvent';
  const DEBUGGER_TEXT_PROVIDER = 'chrome.debugger.Input.insertText';
  const DEBUGGER_TIMEOUT_MS = 5000;
  const CDP_ALLOWED_METHODS = new Set([
    'DOM.scrollIntoViewIfNeeded',
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'Page.captureScreenshot',
    'Page.handleJavaScriptDialog',
    'Page.getLayoutMetrics',
    'Target.getTargets'
  ]);
  const managedCdpAttachments = new Set();
  const RUNTIME_TEXT_PREFERENCE_TTL_MS = 2 * 60 * 1000;
  const RUNTIME_TEXT_PREFERENCE_LIMIT = 64;
  const runtimeTextPreferences = new Map();
  let debuggerOperationLock = Promise.resolve();

  function withDebuggerOperationLock(operation) {
    const previous = debuggerOperationLock;
    const next = previous
      .catch(() => null)
      .then(operation);
    debuggerOperationLock = next.catch(() => null);
    return next;
  }

  function compactIdentityValue(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 120) : '';
  }

  function firstIdentityValue(...values) {
    for (const value of values) {
      const text = compactIdentityValue(value);
      if (text) {
        return text;
      }
    }
    return '';
  }

  function targetDataValue(target, field) {
    if (!target) {
      return '';
    }
    const contract = target.targetContract || target.contract || {};
    return firstIdentityValue(
      target.data && target.data[field],
      contract.data && contract.data[field]
    );
  }

  function targetIdentityPart(target) {
    if (!target) {
      return '';
    }
    const contract = target.targetContract || target.contract || {};
    const testid = firstIdentityValue(
      target.testid,
      target.dataTestId,
      targetDataValue(target, 'testid'),
      targetDataValue(target, 'testId'),
      targetDataValue(target, 'test-id'),
      contract.testid,
      contract.dataTestId
    );
    if (testid) {
      return `testid:${testid}`;
    }
    const id = firstIdentityValue(target.id, contract.id);
    if (id) {
      return `id:${id}`;
    }
    const name = firstIdentityValue(target.name, contract.name);
    if (name) {
      return `name:${name}`;
    }
    const placeholder = firstIdentityValue(target.placeholder, contract.placeholder);
    if (placeholder) {
      return `placeholder:${placeholder}`;
    }
    const label = firstIdentityValue(
      target.label,
      target.accessibleName,
      contract.label,
      contract.accessibleName
    );
    return label ? `label:${label}` : '';
  }

  function runtimeTextPreferenceKey(tab, params) {
    const identity = targetIdentityPart(params && params.target);
    if (!identity || !tab || !tab.id) {
      return '';
    }
    let origin = '';
    try {
      origin = new URL(tab.url).origin;
    } catch {
      origin = '';
    }
    const target = params.target || {};
    const contract = target.targetContract || target.contract || {};
    const tag = firstIdentityValue(target.tag, contract.tag);
    const role = firstIdentityValue(target.role, contract.role);
    const type = firstIdentityValue(target.type, contract.type);
    return [tab.id, origin, tag, role, type, identity].join('|');
  }

  function runtimeTextPreference(key) {
    if (!key) {
      return null;
    }
    const entry = runtimeTextPreferences.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      runtimeTextPreferences.delete(key);
      return null;
    }
    return entry;
  }

  function rememberRuntimeTextPreference(key, reason) {
    if (!key) {
      return;
    }
    runtimeTextPreferences.set(key, {
      reason,
      expiresAt: Date.now() + RUNTIME_TEXT_PREFERENCE_TTL_MS
    });
    while (runtimeTextPreferences.size > RUNTIME_TEXT_PREFERENCE_LIMIT) {
      const oldestKey = runtimeTextPreferences.keys().next().value;
      runtimeTextPreferences.delete(oldestKey);
    }
  }

  function forgetRuntimeTextPreference(key) {
    if (key) {
      runtimeTextPreferences.delete(key);
    }
  }

  function isDebuggerSupportedUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function unsupportedDebuggerPageError(tab) {
    return {
      code: 'DEBUGGER_UNSUPPORTED_PAGE',
      message: 'Chrome debugger actions require a regular http:// or https:// page.',
      url: tab && tab.url ? tab.url : null
    };
  }

  function chromeLastError(chromeApi) {
    return chromeApi && chromeApi.runtime && chromeApi.runtime.lastError
      ? chromeApi.runtime.lastError
      : null;
  }

  function callbackApi(chromeApi, label, register, timeoutMs = DEBUGGER_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      function finish(value) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const lastError = chromeLastError(chromeApi);
        if (lastError) {
          reject(new Error(lastError.message || String(lastError)));
          return;
        }
        resolve(value);
      }

      try {
        register(finish);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function attachDebugger(chromeApi, target, timeoutMs) {
    return callbackApi(
      chromeApi,
      'chrome.debugger.attach',
      (done) => chromeApi.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, done),
      timeoutMs
    );
  }

  function detachDebugger(chromeApi, target, timeoutMs) {
    return callbackApi(
      chromeApi,
      'chrome.debugger.detach',
      (done) => chromeApi.debugger.detach(target, done),
      timeoutMs
    );
  }

  function sendCommand(chromeApi, target, method, params = {}, timeoutMs) {
    return callbackApi(
      chromeApi,
      `chrome.debugger.sendCommand(${method})`,
      (done) => chromeApi.debugger.sendCommand(target, method, params, done),
      timeoutMs
    );
  }

  function actionUsesCdpInput(action) {
    return action === 'click' || action === 'type';
  }

  async function activateTabForCdpInput(chromeApi, tab, timeoutMs) {
    if (
      !chromeApi ||
      !chromeApi.tabs ||
      typeof chromeApi.tabs.update !== 'function' ||
      !tab ||
      !Number.isInteger(tab.id)
    ) {
      return null;
    }
    return callbackApi(
      chromeApi,
      'chrome.tabs.update(active)',
      (done) => chromeApi.tabs.update(tab.id, { active: true }, done),
      Math.min(timeoutMs || DEBUGGER_TIMEOUT_MS, 3000)
    );
  }

  function runtimeActionExecutor(payload) {
    const ACTIONABLE_SELECTOR = [
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

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function attr(element, name) {
      return element && typeof element.getAttribute === 'function'
        ? element.getAttribute(name) || ''
        : '';
    }

    function normalizedHref(element) {
      return element && typeof element.href === 'string' && element.href
        ? element.href
        : attr(element, 'href');
    }

    function elementTagName(element) {
      return String(element && element.tagName ? element.tagName : '').toLowerCase();
    }

    function normalizedControlType(element) {
      const tag = elementTagName(element);
      const rawType = attr(element, 'type') || (element && element.type ? element.type : '');
      if (tag === 'button') {
        return String(rawType || 'button').toLowerCase();
      }
      if (tag === 'input') {
        return String(rawType || 'text').toLowerCase();
      }
      return String(rawType || '').toLowerCase();
    }

    function implicitRole(element) {
      const explicitRole = attr(element, 'role');
      if (explicitRole) {
        return explicitRole;
      }
      const tag = elementTagName(element);
      const type = normalizedControlType(element);
      if (tag === 'button') {
        return 'button';
      }
      if (tag === 'a' && normalizedHref(element)) {
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
      return '';
    }

    function elementTestId(element) {
      return attr(element, 'data-testid') ||
        attr(element, 'data-test-id') ||
        attr(element, 'data-test') ||
        '';
    }

    function normalizeText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function hashText(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function elementFingerprint(element) {
      return [
        element.tagName || '',
        element.id || '',
        attr(element, 'name'),
        attr(element, 'type'),
        attr(element, 'role'),
        attr(element, 'data-risk'),
        attr(element, 'aria-label'),
        attr(element, 'placeholder'),
        attr(element, 'title'),
        normalizedHref(element),
        attr(element, 'data-product-id')
      ].join('|');
    }

    function elementLabel(element) {
      return normalizeText(
        attr(element, 'aria-label') ||
        attr(element, 'title') ||
        element.innerText ||
        attr(element, 'placeholder') ||
        attr(element, 'name') ||
        ''
      ).slice(0, 200);
    }

    function nestedDataValue(target, ...keys) {
      const data = target && target.data && typeof target.data === 'object' ? target.data : null;
      if (!data) {
        return '';
      }
      for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
          return data[key];
        }
      }
      return '';
    }

    function targetValue(target, key) {
      if (!target || typeof target !== 'object') {
        return '';
      }
      if (target[key] !== undefined && target[key] !== null && target[key] !== '') {
        return target[key];
      }
      if (key === 'testid') {
        return nestedDataValue(target, 'testid', 'testId', 'testID', 'data-testid', 'data-test-id');
      }
      return '';
    }

    function targetContract(target) {
      if (!target || typeof target !== 'object') {
        return null;
      }
      const contract = target.targetContract || target.contract || null;
      return contract && typeof contract === 'object' ? contract : null;
    }

    function hasTargetValue(value) {
      return value !== undefined && value !== null && String(value) !== '';
    }

    function elementBox(element) {
      if (!element || typeof element.getBoundingClientRect !== 'function') {
        return null;
      }
      const rect = element.getBoundingClientRect();
      if (!rect) {
        return null;
      }
      const left = Number.isFinite(rect.x) ? rect.x : rect.left;
      const top = Number.isFinite(rect.y) ? rect.y : rect.top;
      const width = Number.isFinite(rect.width) ? rect.width : (rect.right - rect.left);
      const height = Number.isFinite(rect.height) ? rect.height : (rect.bottom - rect.top);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        return null;
      }
      return { x: left, y: top, width, height };
    }

    function targetBox(target) {
      const source = target && typeof target === 'object'
        ? (target.bbox || target.rect)
        : null;
      if (!source || typeof source !== 'object') {
        return null;
      }
      const left = Number.isFinite(source.x) ? source.x : source.left;
      const top = Number.isFinite(source.y) ? source.y : source.top;
      const width = Number.isFinite(source.width) ? source.width : (source.right - source.left);
      const height = Number.isFinite(source.height) ? source.height : (source.bottom - source.top);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        return null;
      }
      return { x: left, y: top, width, height };
    }

    function boxCenter(box) {
      return {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2
      };
    }

    function viewportHitTestingAvailable() {
      const viewportWidth = Number(window.innerWidth);
      const viewportHeight = Number(window.innerHeight);
      return Number.isFinite(viewportWidth) &&
        Number.isFinite(viewportHeight) &&
        viewportWidth > 1 &&
        viewportHeight > 1;
    }

    function clampPointerPoint(point, box) {
      if (!viewportHitTestingAvailable()) {
        return point;
      }
      const viewportWidth = Number(window.innerWidth);
      const viewportHeight = Number(window.innerHeight);
      const maxX = Math.max(1, (Number.isFinite(viewportWidth) && viewportWidth > 0
        ? viewportWidth
        : box.x + box.width) - 1);
      const maxY = Math.max(1, (Number.isFinite(viewportHeight) && viewportHeight > 0
        ? viewportHeight
        : box.y + box.height) - 1);
      return {
        x: Math.max(1, Math.min(maxX, point.x)),
        y: Math.max(1, Math.min(maxY, point.y))
      };
    }

    function uniquePointerPoints(points, box) {
      const seen = new Set();
      const unique = [];
      for (const rawPoint of points) {
        const point = clampPointerPoint(rawPoint, box);
        const key = `${Math.round(point.x * 100) / 100}:${Math.round(point.y * 100) / 100}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(point);
        }
      }
      return unique;
    }

    function pointerPointCandidates(box) {
      const center = boxCenter(box);
      const xInset = Math.min(12, Math.max(1, box.width * 0.25));
      const yInset = Math.min(12, Math.max(1, box.height * 0.25));
      return uniquePointerPoints([
        center,
        { x: box.x + xInset, y: center.y },
        { x: box.x + box.width - xInset, y: center.y },
        { x: center.x, y: box.y + yInset },
        { x: center.x, y: box.y + box.height - yInset }
      ], box);
    }

    function isElementDisabled(element) {
      return Boolean(element && element.disabled) ||
        String(attr(element, 'aria-disabled')).toLowerCase() === 'true';
    }

    function elementReceivesPointerEvents(element, hit) {
      return hit === element ||
        Boolean(element && typeof element.contains === 'function' && element.contains(hit));
    }

    function elementDescriptor(element) {
      if (!element) {
        return null;
      }
      return {
        tag: elementTagName(element),
        id: element.id || '',
        role: implicitRole(element),
        label: elementLabel(element).slice(0, 80),
        testid: elementTestId(element)
      };
    }

    function targetSnapshotForElement(element, box) {
      return {
        ...(elementDescriptor(element) || {}),
        bbox: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height
        }
      };
    }

    function actionabilityFailure(reason, message, extra) {
      return {
        ok: false,
        error: {
          code: 'ACTIONABILITY_FAILED',
          message,
          reason,
          freshObservationRequired: reason === 'TARGET_OCCLUDED',
          ...(extra || {})
        }
      };
    }

    function targetReportsCurrentOcclusion(target, element) {
      return Boolean(
        target &&
        target.occluded === true &&
        layoutContextMatches(target) &&
        elementMatchesTargetBox(target, element)
      );
    }

    function resolvePointerActionability(element, box, target) {
      const candidates = pointerPointCandidates(box);
      const center = candidates[0] || boxCenter(box);
      if (targetReportsCurrentOcclusion(target, element)) {
        return actionabilityFailure(
          'TARGET_OCCLUDED',
          'The current observation marked the target as occluded.',
          {
            blocker: null,
            point: center,
            observedOccluded: true
          }
        );
      }
      if (typeof document.elementFromPoint !== 'function') {
        return {
          ok: true,
          point: center,
          actionability: {
            visible: true,
            enabled: true,
            receivesEvents: null,
            reason: 'ELEMENT_FROM_POINT_UNAVAILABLE'
          }
        };
      }
      if (!viewportHitTestingAvailable()) {
        return {
          ok: true,
          point: center,
          actionability: {
            visible: true,
            enabled: true,
            receivesEvents: null,
            reason: 'VIEWPORT_HIT_TEST_UNAVAILABLE'
          }
        };
      }

      let firstBlocked = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const point = candidates[index];
        const hit = document.elementFromPoint(point.x, point.y);
        if (elementReceivesPointerEvents(element, hit)) {
          return {
            ok: true,
            point,
            actionability: {
              visible: true,
              enabled: true,
              receivesEvents: true,
              pointStrategy: index === 0 ? 'center' : 'alternate'
            }
          };
        }
        if (!firstBlocked) {
          firstBlocked = { point, hit };
        }
      }

      return actionabilityFailure(
        'TARGET_OCCLUDED',
        'The target element is covered by another element at the pointer location.',
        {
          blocker: elementDescriptor(firstBlocked && firstBlocked.hit),
          point: firstBlocked ? firstBlocked.point : center
        }
      );
    }

    function actionRequiresReachableTarget(action) {
      return ['type', 'fill', 'clear', 'focus', 'pressKey'].includes(action);
    }

    function resolveInputActionability(element, box, target) {
      const candidates = pointerPointCandidates(box);
      const center = candidates[0] || boxCenter(box);
      if (targetReportsCurrentOcclusion(target, element)) {
        return actionabilityFailure(
          'TARGET_OCCLUDED',
          'The current observation marked the target as occluded.',
          {
            blocker: null,
            point: center,
            observedOccluded: true
          }
        );
      }
      if (typeof document.elementFromPoint !== 'function') {
        return {
          ok: true,
          actionability: {
            visible: true,
            enabled: true,
            receivesEvents: null,
            reason: 'ELEMENT_FROM_POINT_UNAVAILABLE'
          }
        };
      }
      if (!viewportHitTestingAvailable()) {
        return {
          ok: true,
          actionability: {
            visible: true,
            enabled: true,
            receivesEvents: null,
            reason: 'VIEWPORT_HIT_TEST_UNAVAILABLE'
          }
        };
      }

      let firstBlocked = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const point = candidates[index];
        const hit = document.elementFromPoint(point.x, point.y);
        if (
          hit === element ||
          (element && typeof element.contains === 'function' && element.contains(hit)) ||
          (hit && typeof hit.contains === 'function' && hit.contains(element))
        ) {
          return {
            ok: true,
            actionability: {
              visible: true,
              enabled: true,
              receivesEvents: true,
              pointStrategy: index === 0 ? 'center' : 'alternate'
            }
          };
        }
        if (!firstBlocked) {
          firstBlocked = { point, hit };
        }
      }

      return actionabilityFailure(
        'TARGET_OCCLUDED',
        'The target element is covered by another element at the input location.',
        {
          blocker: elementDescriptor(firstBlocked && firstBlocked.hit),
          point: firstBlocked ? firstBlocked.point : center
        }
      );
    }

    function elementMatchesTargetBox(target, element) {
      const expected = targetBox(target);
      if (!expected) {
        return false;
      }
      const current = elementBox(element);
      if (!current) {
        return false;
      }
      const expectedCenter = boxCenter(expected);
      const currentCenter = boxCenter(current);
      const xTolerance = Math.max(8, Math.min(48, Math.max(expected.width, current.width) * 0.5));
      const yTolerance = Math.max(8, Math.min(48, Math.max(expected.height, current.height) * 0.75));
      return Math.abs(expectedCenter.x - currentCenter.x) <= xTolerance &&
        Math.abs(expectedCenter.y - currentCenter.y) <= yTolerance;
    }

    function finiteNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function firstFiniteNumber(...values) {
      for (const value of values) {
        const number = finiteNumber(value);
        if (number !== null) {
          return number;
        }
      }
      return null;
    }

    function withoutHash(url) {
      return String(url || '').replace(/#.*$/, '');
    }

    function targetLayoutContext(target) {
      if (!target || typeof target !== 'object') {
        return null;
      }
      const source = target.context || target.layoutContext || null;
      const viewport = source && source.viewport && typeof source.viewport === 'object'
        ? source.viewport
        : (target.viewport && typeof target.viewport === 'object' ? target.viewport : source);
      const scroll = source && source.scroll && typeof source.scroll === 'object'
        ? source.scroll
        : source;
      if (!source && !target.viewport) {
        return null;
      }
      return {
        url: (source && (source.url || source.href)) || target.url || '',
        width: firstFiniteNumber(
          viewport && viewport.width,
          viewport && viewport.innerWidth,
          source && source.viewportWidth
        ),
        height: firstFiniteNumber(
          viewport && viewport.height,
          viewport && viewport.innerHeight,
          source && source.viewportHeight
        ),
        scrollX: firstFiniteNumber(
          scroll && scroll.x,
          scroll && scroll.scrollX,
          source && source.scrollX,
          target.viewport && target.viewport.scrollX
        ),
        scrollY: firstFiniteNumber(
          scroll && scroll.y,
          scroll && scroll.scrollY,
          source && source.scrollY,
          target.viewport && target.viewport.scrollY
        ),
        devicePixelRatio: firstFiniteNumber(
          source && source.devicePixelRatio,
          source && source.dpr,
          target.viewport && target.viewport.devicePixelRatio
        )
      };
    }

    function currentLayoutContext() {
      return {
        url: location.href,
        width: finiteNumber(window.innerWidth),
        height: finiteNumber(window.innerHeight),
        scrollX: finiteNumber(window.scrollX),
        scrollY: finiteNumber(window.scrollY),
        devicePixelRatio: finiteNumber(window.devicePixelRatio)
      };
    }

    function layoutContextMatches(target) {
      const expected = targetLayoutContext(target);
      if (!expected) {
        return false;
      }
      const current = currentLayoutContext();
      if (expected.url && withoutHash(expected.url) !== withoutHash(current.url)) {
        return false;
      }
      if (expected.width !== null && Math.abs(expected.width - current.width) > 2) {
        return false;
      }
      if (expected.height !== null && Math.abs(expected.height - current.height) > 2) {
        return false;
      }
      if (expected.scrollX !== null && Math.abs(expected.scrollX - current.scrollX) > 2) {
        return false;
      }
      if (expected.scrollY !== null && Math.abs(expected.scrollY - current.scrollY) > 2) {
        return false;
      }
      if (
        expected.devicePixelRatio !== null &&
        current.devicePixelRatio !== null &&
        Math.abs(expected.devicePixelRatio - current.devicePixelRatio) > 0.01
      ) {
        return false;
      }
      return [expected.url, expected.width, expected.height, expected.scrollX, expected.scrollY]
        .some((value) => value !== null && value !== '');
    }

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
      return [...document.querySelectorAll(ACTIONABLE_SELECTOR)].filter(isVisible).slice(0, 200);
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
      return [...new Set([
        ...collectFocusedElements(),
        ...collectInteractiveElements(),
        ...collectVisualElements()
      ])].slice(0, 300);
    }

    function buildPageStateId(elements) {
      const viewport = `${window.innerWidth || 0}x${window.innerHeight || 0}`;
      const fingerprints = elements.map(elementFingerprint).join('\n');
      return hashText([location.href, document.title || '', viewport, fingerprints].join('\n'));
    }

    function staleHandle(reason, extra) {
      return {
        ok: false,
        error: {
          code: 'STALE_HANDLE',
          message: 'Handle no longer matches the current page observation.',
          reason,
          ...(extra || {})
        }
      };
    }

    function targetMatchesElement(target, element) {
      if (!target || typeof target !== 'object' || !element) {
        return false;
      }

      const exactChecks = [
        ['tag', elementTagName(element)],
        ['id', element.id || ''],
        ['name', attr(element, 'name')],
        ['type', normalizedControlType(element)],
        ['role', implicitRole(element)],
        ['href', normalizedHref(element)],
        ['placeholder', attr(element, 'placeholder')],
        ['title', attr(element, 'title')],
        ['testid', elementTestId(element)],
        ['productId', attr(element, 'data-product-id')],
        ['dataRisk', attr(element, 'data-risk')]
      ].map(([key, value]) => [key, targetValue(target, key), value])
        .filter(([, expected]) => hasTargetValue(expected));

      for (const [key, expected, value] of exactChecks) {
        if (String(expected) !== String(value)) {
          return false;
        }
      }

      const hasStableKey = exactChecks.some(([key]) => key !== 'tag');
      if (hasStableKey) {
        return target.label
          ? String(target.label) === elementLabel(element)
          : true;
      }

      return Boolean(target.label) && String(target.label) === elementLabel(element);
    }

    function contractValue(contract, key) {
      if (!contract || typeof contract !== 'object') {
        return '';
      }
      if (contract[key] !== undefined && contract[key] !== null && contract[key] !== '') {
        return contract[key];
      }
      if (key === 'testid') {
        return nestedDataValue(contract, 'testid', 'testId', 'testID', 'data-testid', 'data-test-id');
      }
      return '';
    }

    function sameContractValue(expected, actual) {
      return hasTargetValue(expected) && String(expected) === String(actual || '');
    }

    function scoreTargetContractCandidate(element, contract) {
      if (!element || !contract) {
        return 0;
      }
      let score = 0;
      if (sameContractValue(contractValue(contract, 'testid'), elementTestId(element))) {
        score += 42;
      }
      if (sameContractValue(contractValue(contract, 'role'), implicitRole(element))) {
        score += 24;
      }
      const contractName = contractValue(contract, 'accessibleName') || contractValue(contract, 'label');
      if (sameContractValue(contractName, elementLabel(element))) {
        score += 24;
      }
      if (sameContractValue(contractValue(contract, 'id'), element.id || '')) {
        score += 18;
      }
      if (sameContractValue(contractValue(contract, 'name'), attr(element, 'name'))) {
        score += 14;
      }
      if (sameContractValue(contractValue(contract, 'type'), normalizedControlType(element))) {
        score += 8;
      }
      if (sameContractValue(contractValue(contract, 'placeholder'), attr(element, 'placeholder'))) {
        score += 14;
      }
      if (sameContractValue(contractValue(contract, 'href'), normalizedHref(element))) {
        score += 16;
      }
      if (sameContractValue(contractValue(contract, 'title'), attr(element, 'title'))) {
        score += 10;
      }
      if (sameContractValue(contractValue(contract, 'productId'), attr(element, 'data-product-id'))) {
        score += 12;
      }
      if (sameContractValue(contractValue(contract, 'tag'), elementTagName(element))) {
        score += 6;
      }
      if (targetBox(contract) && layoutContextMatches(contract) && elementMatchesTargetBox(contract, element)) {
        score += 8;
      }
      return score;
    }

    function recoverHandleFromTargetContract(elements, target) {
      const contract = targetContract(target);
      if (!contract) {
        return null;
      }
      const scored = [];
      for (let index = 0; index < elements.length; index += 1) {
        const score = scoreTargetContractCandidate(elements[index], contract);
        if (score >= 50) {
          scored.push({ element: elements[index], index, score });
        }
      }
      if (scored.length === 0) {
        return null;
      }
      scored.sort((left, right) => right.score - left.score);
      const bestScore = scored[0].score;
      const bestMatches = scored.filter((entry) => entry.score === bestScore);
      if (bestMatches.length === 1) {
        return {
          ok: true,
          element: bestMatches[0].element,
          index: bestMatches[0].index,
          recovered: true,
          recovery: {
            strategy: 'target-contract',
            reason: 'PAGE_STATE_CHANGED',
            score: bestMatches[0].score
          }
        };
      }
      return staleHandle('RECOVERY_NOT_UNIQUE', {
        matchCount: bestMatches.length,
        strategy: 'target-contract',
        topScores: scored.slice(0, 3).map((entry) => entry.score)
      });
    }

    function recoverHandleFromTarget(elements, target) {
      if (!target || typeof target !== 'object') {
        return null;
      }
      const contractRecovery = recoverHandleFromTargetContract(elements, target);
      const matches = [];
      for (let index = 0; index < elements.length; index += 1) {
        if (targetMatchesElement(target, elements[index])) {
          matches.push({ element: elements[index], index });
        }
      }
      const targetHasContextualBox = Boolean(targetBox(target)) && layoutContextMatches(target);
      const narrowedMatches = matches.length > 1 && targetHasContextualBox
        ? matches.filter((match) => elementMatchesTargetBox(target, match.element))
        : matches;
      const resolvedMatches = narrowedMatches.length > 0 ? narrowedMatches : matches;
      const narrowedByBox = resolvedMatches !== matches;
      if (resolvedMatches.length === 1) {
        return {
          ok: true,
          element: resolvedMatches[0].element,
          index: resolvedMatches[0].index,
          recovered: true,
          recovery: {
            strategy: narrowedByBox ? 'target-summary-bbox' : 'target-summary',
            reason: 'PAGE_STATE_CHANGED'
          }
        };
      }
      if (contractRecovery && contractRecovery.ok) {
        return contractRecovery;
      }
      if (resolvedMatches.length > 1) {
        return staleHandle('RECOVERY_NOT_UNIQUE', {
          matchCount: resolvedMatches.length
        });
      }
      return contractRecovery;
    }

    function resolveHandle(handle) {
      const legacy = /^el_\d+$/.test(String(handle || ''));
      if (legacy) {
        return staleHandle('UNVERSIONED_HANDLE');
      }

      const match = /^el_([a-z0-9]+)_(\d+)$/.exec(String(handle || ''));
      if (!match) {
        return staleHandle('MALFORMED_HANDLE');
      }

      const elements = collectObservedElements();
      const handlePageStateId = match[1];
      const index = Number(match[2]);
      const currentPageStateId = buildPageStateId(elements);
      if (handlePageStateId !== currentPageStateId) {
        const recovered = recoverHandleFromTarget(elements, payload.target);
        if (recovered) {
          if (recovered.ok) {
            return {
              ...recovered,
              pageStateId: currentPageStateId,
              previousPageStateId: handlePageStateId
            };
          }
          return recovered;
        }
        return staleHandle('PAGE_STATE_CHANGED', {
          handlePageStateId,
          currentPageStateId
        });
      }

      const element = elements[index];
      if (!element) {
        return staleHandle('ELEMENT_NOT_FOUND', {
          handlePageStateId,
          currentPageStateId
        });
      }

      return { ok: true, element, pageStateId: currentPageStateId };
    }

    function dispatchValueEvents(element, inputOptions) {
      if (inputOptions && typeof InputEvent === 'function') {
        element.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: inputOptions.inputType,
          data: inputOptions.data ?? null
        }));
      } else {
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      element.dispatchEvent(new Event('change', { bubbles: true }));
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

    function setFormControlText(element, value, action) {
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
      dispatchValueEvents(element, {
        inputType,
        data: text === '' ? null : text
      });
      return { ok: true };
    }

    function setContentEditableText(element, text, action) {
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
      const inputType = text === ''
        ? 'deleteContentBackward'
        : (action === 'type' ? 'insertText' : 'insertReplacementText');
      const commandValue = text === '' ? null : text;
      const commandSucceeded = ownerDocument.execCommand(command, false, commandValue);
      if (!commandSucceeded) {
        return {
          ok: false,
          error: {
            code: 'TARGET_EDIT_COMMAND_FAILED',
            message: `The contenteditable target rejected the ${command} edit command.`
          }
        };
      }
      dispatchValueEvents(element, { inputType, data: text === '' ? null : text });
      return { ok: true, command };
    }

    function clippedVerificationValue(value) {
      const text = String(value ?? '');
      return text.length > 160 ? `${text.slice(0, 160)}...` : text;
    }

    function actionVerificationFailure(action, reason, message, expected, actual, extra) {
      return {
        ok: false,
        error: {
          code: 'ACTION_VERIFICATION_FAILED',
          message,
          reason,
          action,
          expected: clippedVerificationValue(expected),
          actual: clippedVerificationValue(actual),
          ...(extra || {})
        }
      };
    }

    function elementTextValue(element) {
      if (isContentEditableElement(element)) {
        return String(element.textContent ?? '');
      }
      if ('value' in element) {
        return String(element.value ?? '');
      }
      return null;
    }

    function verifyElementText(element, expected, options) {
      const action = options && options.action ? options.action : 'input';
      const mode = options && options.mode ? options.mode : 'exact';
      const expectedText = String(expected ?? '');
      const actualText = elementTextValue(element);
      if (actualText === null) {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_EDITABLE',
            message: 'The target element cannot report typed text.'
          }
        };
      }
      const matched = mode === 'contains'
        ? actualText.includes(expectedText)
        : actualText === expectedText;
      if (!matched) {
        return actionVerificationFailure(
          action,
          mode === 'contains' ? 'TEXT_INSERTION_NOT_OBSERVED' : 'TARGET_VALUE_MISMATCH',
          mode === 'contains'
            ? 'Inserted text was not observed on the target element.'
            : 'The target value did not match after the action.',
          expectedText,
          actualText
        );
      }
      return {
        ok: true,
        verification: {
          type: mode === 'contains' ? 'text-inserted' : 'text-value',
          expected: clippedVerificationValue(expectedText),
          actual: clippedVerificationValue(actualText),
          expectedLength: expectedText.length,
          actualLength: actualText.length,
          expectedHash: hashText(expectedText),
          actualHash: hashText(actualText)
        }
      };
    }

    function checkableRole(element) {
      const role = String(implicitRole(element) || attr(element, 'role') || '').toLowerCase();
      return ['checkbox', 'radio', 'switch'].includes(role) ? role : '';
    }

    function isAriaCheckable(element) {
      return Boolean(checkableRole(element) || attr(element, 'aria-checked'));
    }

    function checkedState(element) {
      if ('checked' in element) {
        return Boolean(element.checked);
      }
      if (isAriaCheckable(element)) {
        return String(attr(element, 'aria-checked')).toLowerCase() === 'true';
      }
      return null;
    }

    function setElementChecked(element, checked) {
      const expected = checked !== false;
      if ('checked' in element) {
        element.checked = expected;
        dispatchValueEvents(element);
        return { ok: true, expected };
      }
      if (isAriaCheckable(element) && typeof element.setAttribute === 'function') {
        element.setAttribute('aria-checked', expected ? 'true' : 'false');
        dispatchValueEvents(element);
        return { ok: true, expected };
      }
      return {
        ok: false,
        error: {
          code: 'TARGET_NOT_CHECKABLE',
          message: 'The target element cannot be checked.'
        }
      };
    }

    function verifyElementChecked(element, expected) {
      const actual = checkedState(element);
      if (actual === null) {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_CHECKABLE',
            message: 'The target element cannot report checked state.'
          }
        };
      }
      if (actual !== expected) {
        return actionVerificationFailure(
          'check',
          'TARGET_CHECKED_MISMATCH',
          'The target checked state did not match after the action.',
          expected,
          actual
        );
      }
      return {
        ok: true,
        verification: {
          type: 'checked-state',
          expected,
          actual
        }
      };
    }

    function setElementText(element, value, action) {
      const text = String(value ?? '');
      element.focus();
      if (isContentEditableElement(element)) {
        const editResult = setContentEditableText(element, text, action);
        if (!editResult.ok) {
          return editResult;
        }
      } else if ('value' in element) {
        const valueResult = setFormControlText(element, text, action);
        if (!valueResult.ok) {
          return valueResult;
        }
      } else {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_EDITABLE',
            message: 'The target element cannot receive typed text.'
          }
        };
      }
      return verifyElementText(element, text, { action, mode: 'exact' });
    }

    function scrollWindow() {
      window.scrollBy(Number(payload.deltaX) || 0, Number(payload.deltaY) || 0);
      return {
        ok: true,
        result: {
          action: 'scrolled',
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      };
    }

    if (payload.action === 'scroll' && !payload.handle) {
      return scrollWindow();
    }

    const resolved = resolveHandle(payload.handle);
    if (!resolved.ok) {
      return resolved;
    }

    const element = resolved.element;
    if (isElementDisabled(element)) {
      return {
        ok: false,
        error: {
          code: 'TARGET_DISABLED',
          message: 'The target element is disabled.'
        }
      };
    }

    element.scrollIntoView({ block: 'center', inline: 'center' });

    if (actionRequiresReachableTarget(payload.action)) {
      const box = elementBox(element);
      if (!box) {
        return actionabilityFailure(
          'TARGET_NOT_VISIBLE',
          'The target element has no input box.'
        );
      }
      const inputActionability = resolveInputActionability(element, box, payload.target);
      if (!inputActionability.ok) {
        return inputActionability;
      }
    }

    if (payload.action === 'resolvePointerTarget') {
      const box = elementBox(element);
      if (!box) {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_VISIBLE',
            message: 'The target element has no clickable box.'
          }
        };
      }
      const pointerTarget = resolvePointerActionability(element, box, payload.target);
      if (!pointerTarget.ok) {
        return pointerTarget;
      }
      return {
        ok: true,
        result: {
          action: 'resolved-pointer-target',
          handle: payload.handle,
          x: pointerTarget.point.x,
          y: pointerTarget.point.y,
          actionability: pointerTarget.actionability,
          targetSnapshot: targetSnapshotForElement(element, box),
          recovered: resolved.recovered === true,
          recovery: resolved.recovery || null
        }
      };
    }

    if (payload.action === 'click') {
      element.click();
      return { ok: true, result: { action: 'clicked', handle: payload.handle } };
    }

    if (payload.action === 'verifyInsertedText') {
      const verification = verifyElementText(element, payload.text ?? payload.value, {
        action: 'type',
        mode: 'contains'
      });
      if (!verification.ok) {
        return verification;
      }
      return {
        ok: true,
        result: {
          action: 'verified-text-inserted',
          handle: payload.handle,
          verification: verification.verification
        }
      };
    }

    if (payload.action === 'fill' || payload.action === 'type') {
      const textResult = setElementText(element, payload.text ?? payload.value, payload.action);
      if (!textResult.ok) {
        return textResult;
      }
      return {
        ok: true,
        result: {
          action: payload.action === 'type' ? 'typed' : 'filled',
          handle: payload.handle,
          verification: textResult.verification
        }
      };
    }

    if (payload.action === 'clear') {
      const textResult = setElementText(element, '', 'clear');
      if (!textResult.ok) {
        return textResult;
      }
      return {
        ok: true,
        result: {
          action: 'cleared',
          handle: payload.handle,
          verification: textResult.verification
        }
      };
    }

    if (payload.action === 'focus') {
      element.focus();
      return { ok: true, result: { action: 'focused', handle: payload.handle } };
    }

    if (payload.action === 'select') {
      if (element.tagName !== 'SELECT') {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_SELECT',
            message: 'The target element is not a select control.'
          }
        };
      }
      const expectedValue = String(payload.value ?? '');
      const selected = setFormControlText(element, expectedValue, 'select');
      if (!selected.ok) {
        return selected;
      }
      const verification = verifyElementText(element, expectedValue, { action: 'select', mode: 'exact' });
      if (!verification.ok) {
        return verification;
      }
      return {
        ok: true,
        result: {
          action: 'selected',
          value: element.value,
          handle: payload.handle,
          verification: verification.verification
        }
      };
    }

    if (payload.action === 'check') {
      const checked = setElementChecked(element, payload.checked);
      if (!checked.ok) {
        return checked;
      }
      const verification = verifyElementChecked(element, checked.expected);
      if (!verification.ok) {
        return verification;
      }
      return {
        ok: true,
        result: {
          action: 'checked',
          checked: checked.expected,
          handle: payload.handle,
          verification: verification.verification
        }
      };
    }

    if (payload.action === 'scroll') {
      element.scrollBy(Number(payload.deltaX) || 0, Number(payload.deltaY) || 0);
      return {
        ok: true,
        result: {
          action: 'scrolled',
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop,
          handle: payload.handle
        }
      };
    }

    if (payload.action === 'pressKey') {
      element.focus();
      const key = payload.key || 'Enter';
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      return { ok: true, result: { action: 'key-pressed', key, handle: payload.handle } };
    }

    return {
      ok: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: `Unsupported debugger action: ${payload.action}`
      }
    };
  }

  function buildRuntimeActionExpression(payload) {
    return `(${runtimeActionExecutor.toString()})(${JSON.stringify(payload)})`;
  }

  function normalizeRuntimeActionValue(value) {
    if (!value || typeof value !== 'object') {
      return {
        ok: false,
        error: {
          code: 'DEBUGGER_ACTION_FAILED',
          message: 'Debugger runtime action returned an invalid response.'
        }
      };
    }
    return value;
  }

  async function attachCdpSession(options) {
    return withDebuggerOperationLock(() => attachCdpSessionLocked(options));
  }

  async function attachCdpSessionLocked({
    chromeApi,
    tab,
    timeoutMs = DEBUGGER_TIMEOUT_MS
  }) {
    if (!tab || !tab.id) {
      return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
    }
    if (!isDebuggerSupportedUrl(tab.url)) {
      return { ok: false, error: unsupportedDebuggerPageError(tab) };
    }
    if (managedCdpAttachments.has(tab.id)) {
      return {
        ok: true,
        result: {
          provider: 'chrome.debugger.attach',
          action: 'attached',
          tabId: tab.id,
          alreadyAttached: true
        }
      };
    }

    try {
      await attachDebugger(chromeApi, { tabId: tab.id }, timeoutMs);
      managedCdpAttachments.add(tab.id);
      return {
        ok: true,
        result: {
          provider: 'chrome.debugger.attach',
          action: 'attached',
          tabId: tab.id,
          alreadyAttached: false
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CDP_ATTACH_FAILED',
          message: error.message || String(error),
          tabId: tab.id
        }
      };
    }
  }

  async function detachCdpSession(options) {
    return withDebuggerOperationLock(() => detachCdpSessionLocked(options));
  }

  async function detachCdpSessionLocked({
    chromeApi,
    tab,
    timeoutMs = DEBUGGER_TIMEOUT_MS
  }) {
    if (!tab || !tab.id) {
      return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
    }
    if (!managedCdpAttachments.has(tab.id)) {
      return {
        ok: true,
        result: {
          provider: 'chrome.debugger.detach',
          action: 'detached',
          tabId: tab.id,
          alreadyDetached: true
        }
      };
    }

    try {
      await detachDebugger(chromeApi, { tabId: tab.id }, timeoutMs);
      managedCdpAttachments.delete(tab.id);
      return {
        ok: true,
        result: {
          provider: 'chrome.debugger.detach',
          action: 'detached',
          tabId: tab.id,
          alreadyDetached: false
        }
      };
    } catch (error) {
      managedCdpAttachments.delete(tab.id);
      return {
        ok: false,
        error: {
          code: 'CDP_DETACH_FAILED',
          message: error.message || String(error),
          tabId: tab.id
        }
      };
    }
  }

  async function detachAllCdpSessions(options) {
    return withDebuggerOperationLock(() => detachAllCdpSessionsLocked(options));
  }

  async function detachAllCdpSessionsLocked({
    chromeApi,
    timeoutMs = DEBUGGER_TIMEOUT_MS
  }) {
    const detached = [];
    for (const tabId of [...managedCdpAttachments]) {
      try {
        await detachDebugger(chromeApi, { tabId }, timeoutMs);
      } catch {
        // The tab may already be gone; either way it is no longer owned here.
      }
      managedCdpAttachments.delete(tabId);
      detached.push(tabId);
    }
    return {
      ok: true,
      result: {
        action: 'detached-all',
        detached
      }
    };
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function cdpParamError(message, extra = {}) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message,
        ...extra
      }
    };
  }

  function rejectUnknownCdpParams(params, allowedKeys) {
    for (const key of Object.keys(params)) {
      if (!allowedKeys.has(key)) {
        return cdpParamError(`CDP params do not accept field: ${key}.`, {
          field: `params.${key}`
        });
      }
    }
    return null;
  }

  function requireStringLength(params, key, maxLength) {
    if (params[key] === undefined) {
      return null;
    }
    if (typeof params[key] !== 'string') {
      return cdpParamError(`CDP ${key} must be a string.`, { field: `params.${key}` });
    }
    if (params[key].length > maxLength) {
      return cdpParamError(`CDP ${key} is too long.`, {
        field: `params.${key}`,
        maxLength
      });
    }
    return null;
  }

  function validateCdpScreenshotClip(clip) {
    if (clip === undefined) {
      return null;
    }
    if (!isPlainObject(clip)) {
      return cdpParamError('CDP screenshot clip must be an object.', { field: 'params.clip' });
    }
    const unknown = rejectUnknownCdpParams(clip, new Set(['x', 'y', 'width', 'height', 'scale']));
    if (unknown) {
      return unknown;
    }
    for (const key of ['x', 'y', 'width', 'height', 'scale']) {
      if (!Number.isFinite(clip[key])) {
        return cdpParamError(`CDP screenshot clip.${key} must be a finite number.`, {
          field: `params.clip.${key}`
        });
      }
    }
    if (clip.x < 0 || clip.y < 0) {
      return cdpParamError('CDP screenshot clip origin must be non-negative.', {
        field: 'params.clip'
      });
    }
    if (clip.width <= 0 || clip.height <= 0) {
      return cdpParamError('CDP screenshot clip dimensions must be positive.', {
        field: 'params.clip'
      });
    }
    if (clip.width > 10000 || clip.height > 10000) {
      return cdpParamError('CDP screenshot clip dimensions are too large.', {
        field: 'params.clip',
        maxDimension: 10000
      });
    }
    if (clip.scale <= 0 || clip.scale > 10) {
      return cdpParamError('CDP screenshot clip scale must be within 0-10.', {
        field: 'params.clip.scale'
      });
    }
    return null;
  }

  function validateCdpParamsForMethod(method, params) {
    if (!isPlainObject(params)) {
      return cdpParamError('CDP params must be an object.');
    }

    if (method === 'Input.insertText') {
      const unknown = rejectUnknownCdpParams(params, new Set(['text']));
      if (unknown) {
        return unknown;
      }
      if (typeof params.text !== 'string' || params.text.length === 0) {
        return cdpParamError('CDP Input.insertText requires non-empty text.', { field: 'params.text' });
      }
      if (params.text.length > 2000) {
        return cdpParamError('CDP Input.insertText text is too long.', {
          field: 'params.text',
          maxLength: 2000
        });
      }
      return { ok: true, params };
    }

    if (method === 'Input.dispatchMouseEvent') {
      const allowed = new Set(['type', 'x', 'y', 'button', 'buttons', 'clickCount', 'modifiers', 'deltaX', 'deltaY']);
      const unknown = rejectUnknownCdpParams(params, allowed);
      if (unknown) {
        return unknown;
      }
      if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(params.type)) {
        return cdpParamError('CDP mouse event type is not allowed.', { field: 'params.type' });
      }
      for (const key of ['x', 'y']) {
        if (!Number.isFinite(params[key])) {
          return cdpParamError(`CDP ${key} must be a finite number.`, { field: `params.${key}` });
        }
      }
      if (params.button !== undefined && !['none', 'left', 'middle', 'right', 'back', 'forward'].includes(params.button)) {
        return cdpParamError('CDP mouse button is not allowed.', { field: 'params.button' });
      }
      for (const key of ['buttons', 'clickCount', 'modifiers', 'deltaX', 'deltaY']) {
        if (params[key] !== undefined && !Number.isFinite(params[key])) {
          return cdpParamError(`CDP ${key} must be a finite number.`, { field: `params.${key}` });
        }
      }
      return { ok: true, params };
    }

    if (method === 'Input.dispatchKeyEvent') {
      const allowed = new Set([
        'type',
        'modifiers',
        'timestamp',
        'text',
        'unmodifiedText',
        'keyIdentifier',
        'code',
        'key',
        'windowsVirtualKeyCode',
        'nativeVirtualKeyCode',
        'autoRepeat',
        'isKeypad',
        'isSystemKey',
        'location',
        'commands'
      ]);
      const unknown = rejectUnknownCdpParams(params, allowed);
      if (unknown) {
        return unknown;
      }
      if (!['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(params.type)) {
        return cdpParamError('CDP key event type is not allowed.', { field: 'params.type' });
      }
      for (const key of ['text', 'unmodifiedText', 'keyIdentifier', 'code', 'key']) {
        const stringError = requireStringLength(params, key, 120);
        if (stringError) {
          return stringError;
        }
      }
      for (const key of ['modifiers', 'timestamp', 'windowsVirtualKeyCode', 'nativeVirtualKeyCode', 'location']) {
        if (params[key] !== undefined && !Number.isFinite(params[key])) {
          return cdpParamError(`CDP ${key} must be a finite number.`, { field: `params.${key}` });
        }
      }
      for (const key of ['autoRepeat', 'isKeypad', 'isSystemKey']) {
        if (params[key] !== undefined && typeof params[key] !== 'boolean') {
          return cdpParamError(`CDP ${key} must be boolean.`, { field: `params.${key}` });
        }
      }
      if (params.commands !== undefined) {
        if (!Array.isArray(params.commands) || params.commands.some((command) => typeof command !== 'string' || command.length > 80)) {
          return cdpParamError('CDP commands must be an array of short strings.', { field: 'params.commands' });
        }
      }
      return { ok: true, params };
    }

    if (method === 'DOM.scrollIntoViewIfNeeded') {
      const allowed = new Set(['nodeId', 'backendNodeId', 'objectId', 'rect']);
      const unknown = rejectUnknownCdpParams(params, allowed);
      if (unknown) {
        return unknown;
      }
      const hasNodeRef = Number.isInteger(params.nodeId) ||
        Number.isInteger(params.backendNodeId) ||
        (typeof params.objectId === 'string' && params.objectId.length > 0);
      if (!hasNodeRef) {
        return cdpParamError('CDP DOM.scrollIntoViewIfNeeded requires nodeId, backendNodeId, or objectId.', {
          field: 'params'
        });
      }
      if (params.rect !== undefined) {
        if (!isPlainObject(params.rect)) {
          return cdpParamError('CDP rect must be an object.', { field: 'params.rect' });
        }
        const rectUnknown = rejectUnknownCdpParams(params.rect, new Set(['x', 'y', 'width', 'height']));
        if (rectUnknown) {
          return rectUnknown;
        }
        for (const key of ['x', 'y', 'width', 'height']) {
          if (params.rect[key] !== undefined && !Number.isFinite(params.rect[key])) {
            return cdpParamError(`CDP rect.${key} must be a finite number.`, {
              field: `params.rect.${key}`
            });
          }
        }
      }
      return { ok: true, params };
    }

    if (method === 'Page.captureScreenshot') {
      const unknown = rejectUnknownCdpParams(params, new Set(['format', 'quality', 'clip', 'fromSurface']));
      if (unknown) {
        return unknown;
      }
      if (params.format !== undefined && !['png', 'jpeg', 'webp'].includes(params.format)) {
        return cdpParamError('CDP screenshot format is not allowed.', { field: 'params.format' });
      }
      if (
        params.quality !== undefined &&
        (!Number.isInteger(params.quality) || params.quality < 0 || params.quality > 100)
      ) {
        return cdpParamError('CDP screenshot quality must be an integer from 0 to 100.', {
          field: 'params.quality'
        });
      }
      if (params.fromSurface !== undefined && typeof params.fromSurface !== 'boolean') {
        return cdpParamError('CDP screenshot fromSurface must be boolean.', {
          field: 'params.fromSurface'
        });
      }
      const clipError = validateCdpScreenshotClip(params.clip);
      if (clipError) {
        return clipError;
      }
      return { ok: true, params };
    }

    if (method === 'Page.handleJavaScriptDialog') {
      const unknown = rejectUnknownCdpParams(params, new Set(['accept', 'promptText']));
      if (unknown) {
        return unknown;
      }
      if (typeof params.accept !== 'boolean') {
        return cdpParamError('CDP Page.handleJavaScriptDialog requires boolean accept.', {
          field: 'params.accept'
        });
      }
      const promptTextError = requireStringLength(params, 'promptText', 500);
      if (promptTextError) {
        return promptTextError;
      }
      return { ok: true, params };
    }

    if (method === 'Page.getLayoutMetrics') {
      const unknown = rejectUnknownCdpParams(params, new Set());
      if (unknown) {
        return unknown;
      }
      return { ok: true, params: {} };
    }

    if (method === 'Target.getTargets') {
      const unknown = rejectUnknownCdpParams(params, new Set());
      if (unknown) {
        return unknown;
      }
      return { ok: true, params: {} };
    }

    return cdpParamError('CDP method has no strict parameter validator.', { method });
  }

  function mimeTypeForCaptureFormat(format) {
    if (format === 'jpeg') {
      return 'image/jpeg';
    }
    if (format === 'webp') {
      return 'image/webp';
    }
    return 'image/png';
  }

  function estimateBase64Bytes(base64) {
    const clean = String(base64 || '').replace(/=+$/, '');
    return Math.ceil(clean.length * 3 / 4);
  }

  async function runCdpCommand(options) {
    return withDebuggerOperationLock(() => runCdpCommandLocked(options));
  }

  async function runCdpCommandLocked({
    chromeApi,
    tab,
    method,
    params = {},
    timeoutMs = DEBUGGER_TIMEOUT_MS
  }) {
    if (!CDP_ALLOWED_METHODS.has(method)) {
      return {
        ok: false,
        error: {
          code: 'CDP_METHOD_NOT_ALLOWED',
          message: 'CDP method is not allowlisted for guarded operator use.',
          method
        }
      };
    }
    if (!isPlainObject(params)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SCHEMA',
          message: 'CDP params must be an object.'
        }
      };
    }
    const cdpParams = validateCdpParamsForMethod(method, params);
    if (!cdpParams.ok) {
      return cdpParams;
    }
    if (!tab || !tab.id) {
      return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
    }
    if (!isDebuggerSupportedUrl(tab.url)) {
      return { ok: false, error: unsupportedDebuggerPageError(tab) };
    }

    const target = { tabId: tab.id };
    const managedAttachment = managedCdpAttachments.has(tab.id);
    let attached = false;
    try {
      if (!managedAttachment) {
        await attachDebugger(chromeApi, target, timeoutMs);
        attached = true;
      }
      const response = await sendCommand(chromeApi, target, method, cdpParams.params, timeoutMs);
      if (method === 'Page.captureScreenshot') {
        const data = response && typeof response.data === 'string' ? response.data : '';
        if (!data) {
          return {
            ok: false,
            error: {
              code: 'CDP_COMMAND_FAILED',
              message: 'Page.captureScreenshot returned no image data.',
              method
            }
          };
        }
        const mimeType = mimeTypeForCaptureFormat(cdpParams.params.format);
        return {
          ok: true,
          result: {
            provider: `chrome.debugger.${method}`,
            method,
            managedSession: managedAttachment,
            response: {},
            screenshot: {
              mimeType,
              dataUrl: `data:${mimeType};base64,${data}`,
              bytesApprox: estimateBase64Bytes(data)
            }
          }
        };
      }
      return {
        ok: true,
        result: {
          provider: `chrome.debugger.${method}`,
          method,
          managedSession: managedAttachment,
          response: response || {}
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CDP_COMMAND_FAILED',
          message: error.message || String(error),
          method
        }
      };
    } finally {
      if (attached && !managedAttachment) {
        try {
          await detachDebugger(chromeApi, target, timeoutMs);
        } catch {
          // Detach failures should not hide the command result.
        }
      }
    }
  }

  async function runDebuggerAction(options) {
    return withDebuggerOperationLock(() => runDebuggerActionLocked(options));
  }

  async function runDebuggerActionLocked({
    chromeApi,
    tab,
    action,
    params = {},
    timeoutMs = DEBUGGER_TIMEOUT_MS
  }) {
    if (!tab || !tab.id) {
      return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
    }
    if (!isDebuggerSupportedUrl(tab.url)) {
      return { ok: false, error: unsupportedDebuggerPageError(tab) };
    }

    const target = { tabId: tab.id };
    let attached = false;
    try {
      if (actionUsesCdpInput(action)) {
        await activateTabForCdpInput(chromeApi, tab, timeoutMs);
      }
      await attachDebugger(chromeApi, target, timeoutMs);
      attached = true;
      await sendCommand(chromeApi, target, 'Runtime.enable', {}, timeoutMs);
      if (action === 'click') {
        const response = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
          expression: buildRuntimeActionExpression({ action: 'resolvePointerTarget', ...params }),
          awaitPromise: true,
          returnByValue: true
        }, timeoutMs);
        const value = normalizeRuntimeActionValue(response && response.result && response.result.value);
        if (!value.ok) {
          return value;
        }
        if (
          value.result &&
          value.result.actionability &&
          value.result.actionability.reason === 'VIEWPORT_HIT_TEST_UNAVAILABLE'
        ) {
          const runtimeClickResponse = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
            expression: buildRuntimeActionExpression({ action: 'click', ...params }),
            awaitPromise: true,
            returnByValue: true
          }, timeoutMs);
          const runtimeClickValue = normalizeRuntimeActionValue(
            runtimeClickResponse &&
            runtimeClickResponse.result &&
            runtimeClickResponse.result.value
          );
          if (!runtimeClickValue.ok) {
            return runtimeClickValue;
          }
          return {
            ok: true,
            result: {
              provider: DEBUGGER_ACTION_PROVIDER,
              ...runtimeClickValue.result,
              actionability: value.result.actionability,
              pointer: false
            }
          };
        }
        const x = Number(value.result && value.result.x);
        const y = Number(value.result && value.result.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return {
            ok: false,
            error: {
              code: 'DEBUGGER_ACTION_FAILED',
              message: 'Debugger runtime did not return a pointer target.'
            }
          };
        }
        await sendCommand(chromeApi, target, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y
        }, timeoutMs);
        await sendCommand(chromeApi, target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1
        }, timeoutMs);
        await sendCommand(chromeApi, target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1
        }, timeoutMs);
        return {
          ok: true,
          result: {
            provider: DEBUGGER_POINTER_PROVIDER,
            ...value.result,
            action: 'clicked',
            pointer: true
          }
        };
      }
      if (action === 'type') {
        const text = String(params.text ?? params.value ?? '');
        const preferenceKey = runtimeTextPreferenceKey(tab, params);
        const preferredRuntime = runtimeTextPreference(preferenceKey);
        const response = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
          expression: buildRuntimeActionExpression({ action: 'focus', ...params }),
          awaitPromise: true,
          returnByValue: true
        }, timeoutMs);
        const value = normalizeRuntimeActionValue(response && response.result && response.result.value);
        if (!value.ok) {
          return value;
        }
        if (preferredRuntime) {
          const runtimeResponse = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
            expression: buildRuntimeActionExpression({ action: 'type', ...params, text }),
            awaitPromise: true,
            returnByValue: true
          }, timeoutMs);
          const runtimeValue = normalizeRuntimeActionValue(
            runtimeResponse && runtimeResponse.result && runtimeResponse.result.value
          );
          if (!runtimeValue.ok) {
            forgetRuntimeTextPreference(preferenceKey);
            return {
              ok: false,
              error: {
                ...(runtimeValue.error || {
                  code: 'DEBUGGER_ACTION_FAILED',
                  message: 'Adaptive runtime typing failed.'
                }),
                adaptive: {
                  provider: DEBUGGER_ACTION_PROVIDER,
                  reason: `previous ${preferredRuntime.reason}`
                }
              }
            };
          }
          const runtimeResult = runtimeValue.result || {};
          return {
            ok: true,
            result: {
              provider: DEBUGGER_ACTION_PROVIDER,
              ...runtimeResult,
              action: 'typed',
              handle: runtimeResult.handle || params.handle,
              input: true,
              focus: value.result || null,
              adaptive: {
                provider: DEBUGGER_ACTION_PROVIDER,
                reason: `previous ${preferredRuntime.reason}`
              },
              verification: runtimeResult.verification || null
            }
          };
        }
        await sendCommand(chromeApi, target, 'Input.insertText', {
          text
        }, timeoutMs);
        const verifyResponse = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
          expression: buildRuntimeActionExpression({ action: 'verifyInsertedText', ...params, text }),
          awaitPromise: true,
          returnByValue: true
        }, timeoutMs);
        const verified = normalizeRuntimeActionValue(
          verifyResponse && verifyResponse.result && verifyResponse.result.value
        );
        if (!verified.ok) {
          if (
            verified.error &&
            verified.error.code === 'ACTION_VERIFICATION_FAILED' &&
            verified.error.reason === 'TEXT_INSERTION_NOT_OBSERVED'
          ) {
            const fallbackResponse = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
              expression: buildRuntimeActionExpression({ action: 'type', ...params, text }),
              awaitPromise: true,
              returnByValue: true
            }, timeoutMs);
            const fallback = normalizeRuntimeActionValue(
              fallbackResponse && fallbackResponse.result && fallbackResponse.result.value
            );
            if (!fallback.ok) {
              return {
                ok: false,
                error: {
                  ...(fallback.error || {
                    code: 'DEBUGGER_ACTION_FAILED',
                    message: 'Runtime typing fallback failed.'
                  }),
                  cdpReason: verified.error.reason,
                  cdpExpected: verified.error.expected ?? null,
                  cdpActual: verified.error.actual ?? null
                }
              };
            }
            rememberRuntimeTextPreference(preferenceKey, verified.error.reason);
            const fallbackResult = fallback.result || {};
            return {
              ok: true,
              result: {
                provider: `${DEBUGGER_TEXT_PROVIDER}+Runtime.evaluate`,
                ...fallbackResult,
                action: 'typed',
                handle: fallbackResult.handle || params.handle,
                input: true,
                focus: value.result || null,
                fallback: {
                  provider: DEBUGGER_ACTION_PROVIDER,
                  reason: verified.error.reason
                },
                verification: fallbackResult.verification || null
              }
            };
          }
          return verified;
        }
        forgetRuntimeTextPreference(preferenceKey);
        return {
          ok: true,
          result: {
            provider: DEBUGGER_TEXT_PROVIDER,
            action: 'typed',
            handle: params.handle,
            input: true,
            focus: value.result || null,
            verification: verified.result && verified.result.verification
              ? verified.result.verification
              : null
          }
        };
      }
      const response = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
        expression: buildRuntimeActionExpression({ action, ...params }),
        awaitPromise: true,
        returnByValue: true
      }, timeoutMs);
      const value = normalizeRuntimeActionValue(response && response.result && response.result.value);
      if (!value.ok) {
        return value;
      }
      return {
        ok: true,
        result: {
          provider: DEBUGGER_ACTION_PROVIDER,
          ...value.result
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'DEBUGGER_ACTION_FAILED',
          message: error.message || String(error)
        }
      };
    } finally {
      if (attached) {
        try {
          await detachDebugger(chromeApi, target, timeoutMs);
        } catch {
          // Detach failures should not hide the action result.
        }
      }
    }
  }

  const api = {
    CDP_ALLOWED_METHODS,
    DEBUGGER_ACTION_PROVIDER,
    attachCdpSession,
    buildRuntimeActionExpression,
    detachAllCdpSessions,
    detachCdpSession,
    isDebuggerSupportedUrl,
    runCdpCommand,
    runDebuggerAction
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexDebuggerActions = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
