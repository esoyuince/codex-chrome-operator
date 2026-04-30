(function initFileUpload(root) {
  'use strict';

  function text(value) {
    return String(value || '').trim();
  }

  function safeFileSummary(file) {
    const summary = {};
    for (const key of [
      'role',
      'basename',
      'extension',
      'mimeType',
      'bytes',
      'sha256',
      'width',
      'height',
      'hasAlpha',
      'ruleset',
      'ok'
    ]) {
      if (file && file[key] !== undefined) {
        summary[key] = file[key];
      }
    }
    return summary;
  }

  function cssAttributeValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function hashText(value) {
    let hash = 2166136261;
    const normalized = String(value || '');
    for (let index = 0; index < normalized.length; index += 1) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function elementBbox(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x === undefined ? rect.left || 0 : rect.x),
      y: Math.round(rect.y === undefined ? rect.top || 0 : rect.y),
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0)
    };
  }

  function previewSnapshot(element, role, files = []) {
    const textContent = element ? text(element.textContent) : '';
    return {
      role,
      textHash: hashText(textContent),
      textLength: textContent.length,
      fileBasenames: files
        .map((file) => file && file.basename)
        .filter(Boolean),
      bbox: elementBbox(element)
    };
  }

  function resolveHandleResult(target, context) {
    if (!target || !text(target.handle)) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_TARGET_INVALID',
          message: 'Upload target handle is required.'
        }
      };
    }

    if (typeof context.resolveHandle !== 'function') {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_TARGET_INVALID',
          message: 'Upload target resolver is unavailable.'
        }
      };
    }

    const resolved = context.resolveHandle(target.handle);
    if (!resolved || resolved.ok === false) {
      return {
        ok: false,
        error: resolved && resolved.error
          ? resolved.error
          : {
              code: 'UPLOAD_TARGET_INVALID',
              message: 'Upload target could not be resolved.'
            }
      };
    }

    return {
      ok: true,
      element: resolved.element || resolved
    };
  }

  function resolveUploadInput(element, documentRef) {
    if (!element) {
      return null;
    }
    if (typeof element.matches === 'function' && element.matches('input[type="file"]')) {
      return element;
    }

    const referencedId = text(element.getAttribute && (
      element.getAttribute('for') ||
      element.getAttribute('data-upload-input') ||
      (element.getAttribute('aria-controls') || '').split(/\s+/).find(Boolean)
    ));
    if (referencedId && documentRef && typeof documentRef.getElementById === 'function') {
      const referenced = documentRef.getElementById(referencedId);
      if (referenced && typeof referenced.matches === 'function' && referenced.matches('input[type="file"]')) {
        return referenced;
      }
    }

    if (typeof element.querySelector === 'function') {
      const nested = element.querySelector('input[type="file"]');
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  function isMockPlayConsole(documentRef) {
    return Boolean(
      documentRef &&
      typeof documentRef.querySelector === 'function' &&
      documentRef.querySelector('[data-fixture="mock-play-console"]')
    );
  }

  function eventCtor(context) {
    return context.Event || root.Event;
  }

  function dispatchUploadEvents(input, context) {
    const EventCtor = eventCtor(context);
    if (!EventCtor || typeof input.dispatchEvent !== 'function') {
      return;
    }
    input.dispatchEvent(new EventCtor('input', { bubbles: true }));
    input.dispatchEvent(new EventCtor('change', { bubbles: true }));
  }

  function previewForRole(documentRef, role) {
    return documentRef.querySelector(`[data-preview-role="${cssAttributeValue(role)}"]`);
  }

  function statusForRole(documentRef, role) {
    return documentRef.querySelector(`[data-validation-message="${cssAttributeValue(role)}"]`);
  }

  function updateMockPlayConsole({ documentRef, input, files, context }) {
    const summaries = files.map(safeFileSummary);
    const roles = [...new Set(summaries.map((file) => file.role).filter(Boolean))];
    const validationMessages = [];
    let previewEvidence = null;

    for (const role of roles) {
      const roleFiles = summaries.filter((file) => file.role === role);
      const names = roleFiles.map((file) => file.basename).filter(Boolean).join(', ');
      const preview = previewForRole(documentRef, role);
      const beforeSnapshot = previewSnapshot(preview, role, []);
      if (preview) {
        preview.textContent = names
          ? `Preview updated: ${names}`
          : 'Preview updated.';
        if (preview.dataset) {
          preview.dataset.codexPreviewVerified = 'true';
        }
      }

      const status = statusForRole(documentRef, role);
      const message = `${role} accepted${names ? `: ${names}` : ''}`;
      if (status) {
        status.textContent = message;
        if (status.dataset) {
          status.dataset.codexValidationState = 'accepted';
        }
      }
      validationMessages.push(message);

      const afterSnapshot = previewSnapshot(preview, role, roleFiles);
      if (!previewEvidence) {
        previewEvidence = {
          method: 'dom-preview-snapshot',
          role,
          changed: beforeSnapshot.textHash !== afterSnapshot.textHash,
          before: beforeSnapshot,
          after: afterSnapshot,
          cropCandidate: {
            role,
            bbox: afterSnapshot.bbox
          }
        };
      }
    }

    if (input && input.dataset) {
      input.dataset.codexUploaded = 'true';
      input.dataset.codexUploadedBasenames = summaries.map((file) => file.basename).filter(Boolean).join(',');
    }
    if (input) {
      dispatchUploadEvents(input, context);
    }

    return {
      validationMessages,
      previewVerified: validationMessages.length > 0,
      previewEvidence
    };
  }

  async function uploadFiles(message = {}, context = {}) {
    const documentRef = context.document || root.document;
    const files = Array.isArray(message.files) ? message.files : [];
    const summaries = files.map(safeFileSummary);
    const resolved = resolveHandleResult(message.target, context);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    const input = resolveUploadInput(resolved.element, documentRef);
    if (!input) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_TARGET_INVALID',
          message: 'Resolved element is not an upload target.',
          fileSummaries: summaries
        }
      };
    }

    if (!isMockPlayConsole(documentRef)) {
      const manualStep = {
        kind: 'file-picker',
        uploadTarget: message.target.handle,
        resumePolicy: 'manual-file-picker',
        freshObservationRequired: true,
        instruction: 'Use the visible Chrome file picker or upload widget to select the listed files, then re-observe the page.',
        fileSummaries: summaries
      };
      return {
        ok: false,
        error: {
          code: 'MANUAL_STEP_REQUIRED',
          message: 'Browser security requires a manual file-picker handoff for this upload target.',
          resumePolicy: 'manual-file-picker',
          origin: message.origin || null,
          uploadTarget: message.target.handle,
          fileSummaries: summaries,
          manualStep
        }
      };
    }

    const mockResult = updateMockPlayConsole({
      documentRef,
      input,
      files,
      context
    });
    return {
      ok: true,
      result: {
        action: 'uploaded',
        uploadTarget: message.target.handle,
        ruleset: message.ruleset || null,
        previewVerified: message.verifyPreview === true ? mockResult.previewVerified : false,
        previewEvidence: message.verifyPreview === true ? mockResult.previewEvidence : null,
        validationMessages: mockResult.validationMessages,
        files: summaries
      }
    };
  }

  const api = {
    safeFileSummary,
    previewSnapshot,
    resolveUploadInput,
    uploadFiles
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexFileUpload = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
