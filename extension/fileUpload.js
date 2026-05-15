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

  function uploadInputSummary(input) {
    if (!input) {
      return null;
    }
    return {
      id: input.id || null,
      name: text(input.getAttribute && input.getAttribute('name')) || null,
      accept: text(input.getAttribute && input.getAttribute('accept')) || null,
      multiple: Boolean(input.multiple || (input.hasAttribute && input.hasAttribute('multiple')))
    };
  }

  function uploadToken() {
    return `codex_upload_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  }

  function filesFromInput(input) {
    return Array.from(input && input.files ? input.files : []).map((file) => ({
      name: file && file.name ? String(file.name) : '',
      size: Number.isFinite(Number(file && file.size)) ? Number(file.size) : null,
      type: file && file.type ? String(file.type) : ''
    }));
  }

  function prepareNativeFileUpload(message = {}, context = {}) {
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

    const inputSummary = uploadInputSummary(input);
    if (files.length > 1 && inputSummary && inputSummary.multiple !== true) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_TARGET_INVALID',
          message: 'Upload target does not accept multiple files.',
          uploadTarget: message.target.handle,
          fileSummaries: summaries
        }
      };
    }

    const token = uploadToken();
    input.setAttribute('data-codex-upload-token', token);
    return {
      ok: true,
      result: {
        action: 'prepared',
        uploadTarget: message.target.handle,
        uploadToken: token,
        selector: `[data-codex-upload-token="${cssAttributeValue(token)}"]`,
        ruleset: message.ruleset || null,
        input: inputSummary,
        files: summaries
      }
    };
  }

  function completeNativeFileUpload(message = {}, context = {}) {
    const documentRef = context.document || root.document;
    const token = text(message.uploadToken);
    const files = Array.isArray(message.files) ? message.files : [];
    const summaries = files.map(safeFileSummary);
    if (!token) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_TARGET_INVALID',
          message: 'Upload token is required.'
        }
      };
    }

    const selector = `[data-codex-upload-token="${cssAttributeValue(token)}"]`;
    const input = documentRef && typeof documentRef.querySelector === 'function'
      ? documentRef.querySelector(selector)
      : null;
    if (!input || !(typeof input.matches === 'function' && input.matches('input[type="file"]'))) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_TARGET_INVALID',
          message: 'Prepared upload target is no longer available.',
          uploadTarget: message.target && message.target.handle ? message.target.handle : null,
          fileSummaries: summaries
        }
      };
    }

    const selectedFiles = filesFromInput(input);
    const selectedNames = selectedFiles.map((file) => file.name).filter(Boolean);
    const expectedNames = summaries.map((file) => file.basename).filter(Boolean);
    const missingNames = expectedNames.filter((name) => !selectedNames.includes(name));
    dispatchUploadEvents(input, context);
    if (typeof input.removeAttribute === 'function') {
      input.removeAttribute('data-codex-upload-token');
    }

    if (missingNames.length > 0) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_VERIFICATION_FAILED',
          message: 'File input did not contain the expected selected files.',
          uploadTarget: message.target && message.target.handle ? message.target.handle : null,
          expectedBasenames: expectedNames,
          actualBasenames: selectedNames,
          fileSummaries: summaries
        }
      };
    }

    const previewEvidence = {
      method: 'file-input-files-snapshot',
      uploadTarget: message.target && message.target.handle ? message.target.handle : null,
      expectedBasenames: expectedNames,
      actualBasenames: selectedNames,
      fileCount: selectedFiles.length
    };
    return {
      ok: true,
      result: {
        action: 'uploaded',
        provider: 'chrome.debugger.DOM.setFileInputFiles',
        uploadTarget: message.target && message.target.handle ? message.target.handle : null,
        ruleset: message.ruleset || null,
        previewVerified: message.verifyPreview === true ? missingNames.length === 0 : false,
        previewEvidence: message.verifyPreview === true ? previewEvidence : null,
        input: {
          ...uploadInputSummary(input),
          fileCount: selectedFiles.length,
          fileNames: selectedNames
        },
        files: summaries
      }
    };
  }

  function clearNativeFileUploadMarker(message = {}, context = {}) {
    const documentRef = context.document || root.document;
    const token = text(message.uploadToken);
    if (!token || !documentRef || typeof documentRef.querySelector !== 'function') {
      return { ok: true, result: { cleared: false } };
    }
    const input = documentRef.querySelector(`[data-codex-upload-token="${cssAttributeValue(token)}"]`);
    if (input && typeof input.removeAttribute === 'function') {
      input.removeAttribute('data-codex-upload-token');
      return { ok: true, result: { cleared: true } };
    }
    return { ok: true, result: { cleared: false } };
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
    clearNativeFileUploadMarker,
    completeNativeFileUpload,
    prepareNativeFileUpload,
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
