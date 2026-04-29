(function initPageHandles(root) {
  'use strict';

  function attr(element, name) {
    return element && typeof element.getAttribute === 'function'
      ? element.getAttribute(name) || ''
      : '';
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
      attr(element, 'placeholder')
    ].join('|');
  }

  function buildPageStateId(elements, context) {
    const location = context && context.location ? context.location.href : '';
    const title = context && context.document ? context.document.title || '' : '';
    const viewport = context && context.window
      ? `${context.window.innerWidth || 0}x${context.window.innerHeight || 0}`
      : '0x0';
    const fingerprints = elements.map(elementFingerprint).join('\n');
    return hashText([location, title, viewport, fingerprints].join('\n'));
  }

  function describeElements(elements, context) {
    const pageStateId = buildPageStateId(elements, context);
    return {
      pageStateId,
      items: elements.map((element, index) => ({
        element,
        index,
        pageStateId,
        handle: `el_${pageStateId}_${index}`
      }))
    };
  }

  function staleHandle(reason, extra = {}) {
    return {
      ok: false,
      error: {
        code: 'STALE_HANDLE',
        message: 'Handle no longer matches the current page observation.',
        reason,
        ...extra
      }
    };
  }

  function resolveVersionedHandle({ handle, elements, context }) {
    const legacy = /^el_\d+$/.test(String(handle || ''));
    if (legacy) {
      return staleHandle('UNVERSIONED_HANDLE');
    }

    const match = /^el_([a-z0-9]+)_(\d+)$/.exec(String(handle || ''));
    if (!match) {
      return staleHandle('MALFORMED_HANDLE');
    }

    const handlePageStateId = match[1];
    const index = Number(match[2]);
    const currentPageStateId = buildPageStateId(elements, context);
    if (handlePageStateId !== currentPageStateId) {
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

    return {
      ok: true,
      element,
      pageStateId: currentPageStateId,
      index
    };
  }

  const api = {
    buildPageStateId,
    describeElements,
    resolveVersionedHandle
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexPageHandles = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
