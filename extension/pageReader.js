(function initPageReader(root) {
  'use strict';

  const DEFAULT_DEPTH = 6;
  const DEFAULT_MAX_CHARS = 12000;
  const MAX_ELEMENTS = 400;
  const SKIPPED_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript']);
  const INTERACTIVE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'listbox',
    'menuitem',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox'
  ]);
  const TEXT_ROLES = new Set([
    'article',
    'blockquote',
    'caption',
    'cell',
    'heading',
    'label',
    'listitem',
    'paragraph',
    'region',
    'row',
    'status'
  ]);

  function attr(element, name) {
    return element && typeof element.getAttribute === 'function'
      ? element.getAttribute(name) || ''
      : '';
  }

  function tagName(element) {
    return String(element && element.tagName ? element.tagName : '').toLowerCase();
  }

  function normalizeText(value, limit = 160) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function escapeText(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function numberOption(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function booleanOption(value, fallback = false) {
    return value === undefined ? fallback : value === true;
  }

  function isSensitiveElement(element) {
    return Boolean(
      element &&
      typeof element.matches === 'function' &&
      element.matches('input[type="password"], [autocomplete="one-time-code"]')
    );
  }

  function sensitiveFormAttributeText(element) {
    return [
      attr(element, 'type'),
      attr(element, 'autocomplete'),
      attr(element, 'name'),
      attr(element, 'id'),
      attr(element, 'aria-label'),
      attr(element, 'placeholder'),
      attr(element, 'title')
    ].join(' ').toLowerCase();
  }

  function isSensitiveFormValueElement(element) {
    if (isSensitiveElement(element)) {
      return true;
    }
    const tag = tagName(element);
    const type = attr(element, 'type').toLowerCase();
    if (tag === 'input' && ['hidden', 'password', 'email', 'tel'].includes(type)) {
      return true;
    }
    return /\b(pass(word)?|token|secret|api[-_ ]?key|otp|one[-_ ]?time|2fa|mfa|email|e-mail|mail|phone|tel|mobile|credit|card|cc-|cvv|cvc)\b/.test(sensitiveFormAttributeText(element));
  }

  function formValueForElement(element, options = {}) {
    if (!booleanOption(options.includeFormValues)) {
      return null;
    }
    const tag = tagName(element);
    if (!['input', 'textarea', 'select'].includes(tag)) {
      return null;
    }
    if (isSensitiveFormValueElement(element)) {
      return null;
    }
    const type = attr(element, 'type').toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset', 'file', 'image'].includes(type)) {
      return null;
    }
    const rawValue = tag === 'select'
      ? (element.value || attr(element, 'value'))
      : element.value;
    const maxChars = Math.max(0, numberOption(options.maxFieldValueChars, 4000));
    return String(rawValue || '').slice(0, maxChars);
  }

  function directText(element) {
    const childNodes = Array.from(element && element.childNodes ? element.childNodes : []);
    const text = childNodes
      .filter((node) => node && node.nodeType === 3)
      .map((node) => node.textContent || '')
      .join(' ');
    if (text) {
      return normalizeText(text);
    }
    const children = Array.from(element && element.children ? element.children : []);
    if (children.length === 0) {
      return normalizeText(element && (element.innerText || element.textContent));
    }
    return '';
  }

  function elementChildren(element) {
    return Array.from(element && element.children ? element.children : [])
      .filter((child) => child && child.tagName);
  }

  function isVisible(element, context) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      return false;
    }
    const win = context.window || root.window;
    let style = null;
    if (win && typeof win.getComputedStyle === 'function') {
      style = win.getComputedStyle(element);
    }
    if (
      style &&
      (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      )
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function implicitRole(element) {
    const tag = tagName(element);
    const type = attr(element, 'type').toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      return 'heading';
    }
    if (tag === 'a' && attr(element, 'href')) {
      return 'link';
    }
    if (tag === 'button') {
      return 'button';
    }
    if (tag === 'textarea') {
      return 'textbox';
    }
    if (tag === 'select') {
      return 'combobox';
    }
    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(type)) {
        return 'button';
      }
      if (type === 'checkbox') {
        return 'checkbox';
      }
      if (type === 'radio') {
        return 'radio';
      }
      if (type === 'range') {
        return 'slider';
      }
      if (type === 'number') {
        return 'spinbutton';
      }
      if (type === 'search') {
        return 'searchbox';
      }
      return 'textbox';
    }
    if (tag === 'main') {
      return 'main';
    }
    if (tag === 'nav') {
      return 'navigation';
    }
    if (tag === 'header') {
      return 'banner';
    }
    if (tag === 'footer') {
      return 'contentinfo';
    }
    if (tag === 'form') {
      return 'form';
    }
    if (tag === 'section' && accessibleLabel(element, null)) {
      return 'region';
    }
    if (tag === 'article') {
      return 'article';
    }
    if (tag === 'label') {
      return 'label';
    }
    if (tag === 'li') {
      return 'listitem';
    }
    if (tag === 'p') {
      return 'paragraph';
    }
    if (tag === 'img') {
      return 'img';
    }
    if (tag === 'dialog') {
      return 'dialog';
    }
    return tag || 'generic';
  }

  function roleForElement(element) {
    return attr(element, 'role') || implicitRole(element);
  }

  function accessibleLabel(element, role) {
    if (isSensitiveElement(element)) {
      return 'redacted';
    }
    const explicit = normalizeText(
      attr(element, 'aria-label') ||
      attr(element, 'title') ||
      attr(element, 'alt')
    );
    if (explicit) {
      return explicit;
    }

    const tag = tagName(element);
    const controlText = normalizeText(
      attr(element, 'placeholder') ||
      attr(element, 'name')
    );
    if (['input', 'textarea', 'select'].includes(tag) && controlText) {
      return controlText;
    }

    const text = directText(element);
    if (text) {
      return text;
    }
    if (role === 'button') {
      return normalizeText(attr(element, 'value'));
    }
    return normalizeText(attr(element, 'id'));
  }

  function shouldInclude(element, role, label, filter) {
    const normalized = String(filter || 'all').toLowerCase();
    if (normalized === 'all' || normalized === 'visible') {
      return true;
    }
    if (normalized === 'interactive' || normalized === 'controls') {
      return INTERACTIVE_ROLES.has(role) ||
        attr(element, 'tabindex') !== '' ||
        attr(element, 'contenteditable') === 'true';
    }
    if (normalized === 'text') {
      return Boolean(label) || TEXT_ROLES.has(role);
    }
    return true;
  }

  function collectElements(context, options = {}) {
    const doc = context.document || root.document;
    const rootElement = context.rootElement || (doc && (doc.body || doc.documentElement));
    const depthLimit = Math.max(0, numberOption(options.depth, DEFAULT_DEPTH));
    const filter = options.filter || 'all';
    const collected = [];
    const seen = new Set();

    function visit(element, depth) {
      if (!element || collected.length >= MAX_ELEMENTS || seen.has(element)) {
        return;
      }
      seen.add(element);

      const tag = tagName(element);
      if (SKIPPED_TAGS.has(tag)) {
        return;
      }
      if (!isVisible(element, context)) {
        return;
      }

      const role = roleForElement(element);
      const label = accessibleLabel(element, role);
      if (shouldInclude(element, role, label, filter)) {
        collected.push({ element, depth, role, label });
      }

      if (depth >= depthLimit) {
        return;
      }
      for (const child of elementChildren(element)) {
        visit(child, depth + 1);
      }
    }

    visit(rootElement, 0);
    return collected;
  }

  function describeElements(context, entries) {
    if (typeof context.describeElements === 'function') {
      return context.describeElements(entries.map((entry) => entry.element));
    }
    const pageStateId = 'snapshot';
    return {
      pageStateId,
      items: entries.map((entry, index) => ({
        element: entry.element,
        handle: `el_${pageStateId}_${index}`
      }))
    };
  }

  function focusedRoot(context, options) {
    if (!options.refId) {
      return null;
    }
    if (typeof context.resolveHandle === 'function') {
      const resolved = context.resolveHandle(options.refId, options);
      if (resolved && resolved.ok && resolved.element) {
        return { ok: true, element: resolved.element };
      }
      if (resolved && resolved.ok === false) {
        return resolved;
      }
    }
    return null;
  }

  function attributeParts(element, role, options = {}) {
    const parts = [];
    const tag = tagName(element);
    const type = attr(element, 'type');
    const placeholder = attr(element, 'placeholder');
    const href = attr(element, 'href');
    const ariaExpanded = attr(element, 'aria-expanded');
    const formValue = formValueForElement(element, options);

    if (tag === 'input' && type && !isSensitiveElement(element)) {
      parts.push(`type="${escapeText(type)}"`);
    }
    if (placeholder && !isSensitiveElement(element)) {
      parts.push(`placeholder="${escapeText(placeholder)}"`);
    }
    if (href && role === 'link') {
      parts.push(`href="${escapeText(href.slice(0, 160))}"`);
    }
    if (/^h[1-6]$/.test(tag)) {
      parts.push(`level=${tag.slice(1)}`);
    }
    if (ariaExpanded) {
      parts.push(`expanded=${ariaExpanded}`);
    }
    if (element.disabled) {
      parts.push('disabled');
    }
    if (formValue !== null) {
      parts.push(`value="${escapeText(formValue)}"`);
    }
    return parts;
  }

  function buildLine(entry, handle, options = {}) {
    const indent = '  '.repeat(entry.depth);
    const label = entry.label ? ` "${escapeText(entry.label)}"` : '';
    const attrs = attributeParts(entry.element, entry.role, options);
    return `${indent}${entry.role}${label} [${handle}]${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
  }

  function viewport(context) {
    const win = context.window || root.window;
    if (!win) {
      return null;
    }
    return {
      width: win.innerWidth || 0,
      height: win.innerHeight || 0,
      scrollX: win.scrollX || 0,
      scrollY: win.scrollY || 0,
      devicePixelRatio: win.devicePixelRatio || 1
    };
  }

  function pageLocation(context) {
    return context.location || root.location || {};
  }

  function generatePageSnapshot(context = {}, options = {}) {
    const snapshotOptions = options || {};
    const resolved = focusedRoot(context, snapshotOptions);
    if (resolved && resolved.ok === false) {
      return resolved;
    }

    const effectiveContext = resolved && resolved.element
      ? { ...context, rootElement: resolved.element }
      : context;
    const entries = collectElements(effectiveContext, snapshotOptions);
    const described = describeElements(effectiveContext, entries);
    const lines = entries.map((entry, index) => {
      const item = described.items[index] || {};
      return buildLine(entry, item.handle || `el_snapshot_${index}`, snapshotOptions);
    });
    const pageContent = lines.join('\n');
    const maxChars = Math.max(0, numberOption(snapshotOptions.maxChars, DEFAULT_MAX_CHARS));

    if (pageContent.length > maxChars) {
      return {
        ok: false,
        error: {
          code: 'PAGE_CONTENT_TOO_LARGE',
          message: 'Compact page content exceeds the requested character budget.',
          maxChars,
          actualChars: pageContent.length,
          suggestedFixes: [
            'Increase maxChars.',
            'Use filter="interactive" for controls only.',
            'Use depth to narrow the tree.',
            'Use refId to read a focused subtree.'
          ]
        }
      };
    }

    const loc = pageLocation(effectiveContext);
    const doc = effectiveContext.document || root.document || {};
    return {
      ok: true,
      result: {
        url: loc.href || null,
        origin: loc.origin || null,
        title: doc.title || '',
        pageStateId: described.pageStateId || null,
        pageContent,
        handles: entries.map((entry, index) => {
          const item = described.items[index] || {};
          const handle = {
            handle: item.handle || `el_snapshot_${index}`,
            role: entry.role,
            label: entry.label,
            tag: tagName(entry.element),
            depth: entry.depth
          };
          const formValue = formValueForElement(entry.element, snapshotOptions);
          if (formValue !== null) {
            handle.value = formValue;
          }
          return handle;
        }),
        viewport: viewport(effectiveContext)
      }
    };
  }

  const api = {
    generatePageSnapshot,
    collectElements
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexPageReader = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
