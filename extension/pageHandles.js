(function initPageHandles(root) {
  'use strict';

  const MAX_HANDLE_DESCRIPTORS = 800;
  const existingDescriptors = root.CodexPageHandles &&
    root.CodexPageHandles.__handleDescriptors &&
    typeof root.CodexPageHandles.__handleDescriptors.get === 'function'
    ? root.CodexPageHandles.__handleDescriptors
    : null;
  const handleDescriptors = existingDescriptors || new Map();

  function attr(element, name) {
    return element && typeof element.getAttribute === 'function'
      ? element.getAttribute(name) || ''
      : '';
  }

  function contextUrl(context) {
    return context && context.location ? context.location.href || '' : '';
  }

  function normalizedHref(element) {
    return element && typeof element.href === 'string' && element.href
      ? element.href
      : attr(element, 'href');
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function elementLabel(element) {
    return normalizeText(
      attr(element, 'aria-label') ||
      attr(element, 'title') ||
      element.innerText ||
      element.value ||
      attr(element, 'placeholder') ||
      attr(element, 'name') ||
      ''
    ).slice(0, 200);
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function layoutBox(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      return null;
    }
    const x = Math.round(rect.x || 0);
    const y = Math.round(rect.y || 0);
    const width = Math.round(rect.width || 0);
    const height = Math.round(rect.height || 0);
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { x, y, width, height };
  }

  function layoutFingerprint(element) {
    const box = layoutBox(element);
    if (!box) {
      return '';
    }
    return [box.x, box.y, box.width, box.height].join(',');
  }

  function boxCenter(box) {
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    };
  }

  function elementNearLayout(element, previousBox) {
    const currentBox = layoutBox(element);
    if (!currentBox || !previousBox) {
      return false;
    }
    const currentCenter = boxCenter(currentBox);
    const previousCenter = boxCenter(previousBox);
    const xTolerance = Math.max(16, Math.min(80, Math.max(currentBox.width, previousBox.width) * 0.75));
    const yTolerance = Math.max(16, Math.min(80, Math.max(currentBox.height, previousBox.height) * 1.5));
    return Math.abs(currentCenter.x - previousCenter.x) <= xTolerance &&
      Math.abs(currentCenter.y - previousCenter.y) <= yTolerance;
  }

  function elementFingerprint(element) {
    return [
      element.tagName || '',
      element.id || '',
      attr(element, 'name'),
      attr(element, 'type'),
      attr(element, 'role'),
      attr(element, 'data-testid'),
      attr(element, 'data-test-id'),
      attr(element, 'data-risk'),
      attr(element, 'aria-label'),
      attr(element, 'placeholder'),
      attr(element, 'title'),
      normalizedHref(element),
      attr(element, 'data-product-id'),
      layoutFingerprint(element)
    ].join('|');
  }

  function elementIdentityFingerprint(element) {
    return [
      element.tagName || '',
      element.id || '',
      attr(element, 'name'),
      attr(element, 'type'),
      attr(element, 'role'),
      attr(element, 'data-testid'),
      attr(element, 'data-test-id'),
      attr(element, 'data-risk'),
      attr(element, 'aria-label'),
      attr(element, 'placeholder'),
      attr(element, 'title'),
      normalizedHref(element),
      attr(element, 'data-product-id'),
      elementLabel(element)
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

  function rememberDescriptor(descriptor) {
    handleDescriptors.set(descriptor.handle, descriptor);
    if (handleDescriptors.size <= MAX_HANDLE_DESCRIPTORS) {
      return;
    }
    const overflow = handleDescriptors.size - MAX_HANDLE_DESCRIPTORS;
    const keys = handleDescriptors.keys();
    for (let index = 0; index < overflow; index += 1) {
      const next = keys.next();
      if (next.done) {
        break;
      }
      handleDescriptors.delete(next.value);
    }
  }

  function fingerprintCounts(elements, fingerprintFn = elementFingerprint) {
    const counts = new Map();
    for (const element of elements) {
      const fingerprint = fingerprintFn(element);
      counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
    }
    return counts;
  }

  function describeElements(elements, context) {
    const pageStateId = buildPageStateId(elements, context);
    const counts = fingerprintCounts(elements);
    const identityCounts = fingerprintCounts(elements, elementIdentityFingerprint);
    return {
      pageStateId,
      items: elements.map((element, index) => {
        const handle = `el_${pageStateId}_${index}`;
        const fingerprint = elementFingerprint(element);
        const identityFingerprint = elementIdentityFingerprint(element);
        const previousLayout = layoutBox(element);
        rememberDescriptor({
          handle,
          index,
          pageStateId,
          url: contextUrl(context),
          fingerprint,
          identityFingerprint,
          previousLayout,
          originalMatchCount: counts.get(fingerprint) || 1,
          originalIdentityMatchCount: identityCounts.get(identityFingerprint) || 1
        });
        return {
          element,
          index,
          pageStateId,
          handle
        };
      })
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

  function recoverStaleHandle({ handle, elements, context, handlePageStateId, currentPageStateId }) {
    const descriptor = handleDescriptors.get(handle);
    if (!descriptor || descriptor.pageStateId !== handlePageStateId) {
      return null;
    }
    if (descriptor.url && descriptor.url !== contextUrl(context)) {
      return null;
    }

    const matches = [];
    for (let index = 0; index < elements.length; index += 1) {
      if (elementFingerprint(elements[index]) === descriptor.fingerprint) {
        matches.push({ element: elements[index], index });
      }
    }

    if (matches.length === 1) {
      return {
        ok: true,
        element: matches[0].element,
        pageStateId: currentPageStateId,
        previousPageStateId: handlePageStateId,
        index: matches[0].index,
        previousIndex: descriptor.index,
        recovered: true,
        recovery: {
          strategy: 'stable-fingerprint',
          reason: 'PAGE_STATE_CHANGED'
        }
      };
    }

    if (
      matches.length > 1 &&
      descriptor.originalMatchCount > 1 &&
      elements[descriptor.index] &&
      elementFingerprint(elements[descriptor.index]) === descriptor.fingerprint
    ) {
      return {
        ok: true,
        element: elements[descriptor.index],
        pageStateId: currentPageStateId,
        previousPageStateId: handlePageStateId,
        index: descriptor.index,
        previousIndex: descriptor.index,
        recovered: true,
        recovery: {
          strategy: 'stable-index',
          reason: 'PAGE_STATE_CHANGED',
          matchCount: matches.length
        }
      };
    }

    if (matches.length > 1) {
      return staleHandle('RECOVERY_NOT_UNIQUE', {
        handlePageStateId,
        currentPageStateId,
        matchCount: matches.length
      });
    }

    if (descriptor.identityFingerprint && descriptor.originalIdentityMatchCount === 1) {
      const identityMatches = [];
      for (let index = 0; index < elements.length; index += 1) {
        if (elementIdentityFingerprint(elements[index]) === descriptor.identityFingerprint) {
          identityMatches.push({ element: elements[index], index });
        }
      }

      if (identityMatches.length === 1) {
        return {
          ok: true,
          element: identityMatches[0].element,
          pageStateId: currentPageStateId,
          previousPageStateId: handlePageStateId,
          index: identityMatches[0].index,
          previousIndex: descriptor.index,
          recovered: true,
          recovery: {
            strategy: 'stable-identity',
            reason: 'PAGE_STATE_CHANGED'
          }
        };
      }

      if (identityMatches.length > 1 && descriptor.previousLayout) {
        const layoutMatches = identityMatches.filter((match) => (
          elementNearLayout(match.element, descriptor.previousLayout)
        ));
        if (layoutMatches.length === 1) {
          return {
            ok: true,
            element: layoutMatches[0].element,
            pageStateId: currentPageStateId,
            previousPageStateId: handlePageStateId,
            index: layoutMatches[0].index,
            previousIndex: descriptor.index,
            recovered: true,
            recovery: {
              strategy: 'stable-identity-layout',
              reason: 'PAGE_STATE_CHANGED',
              matchCount: identityMatches.length
            }
          };
        }
      }

      if (identityMatches.length > 1) {
        return staleHandle('RECOVERY_NOT_UNIQUE', {
          handlePageStateId,
          currentPageStateId,
          matchCount: identityMatches.length
        });
      }
    }

    return null;
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
      const recovered = recoverStaleHandle({
        handle,
        elements,
        context,
        handlePageStateId,
        currentPageStateId
      });
      if (recovered) {
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
    resolveVersionedHandle,
    __handleDescriptors: handleDescriptors
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexPageHandles = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
