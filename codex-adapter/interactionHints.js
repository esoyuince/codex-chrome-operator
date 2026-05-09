'use strict';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function elementRole(element = {}) {
  const tag = String(element.tag || element.tagName || '').toLowerCase();
  const type = String(element.type || '').toLowerCase();
  const role = String(element.role || '').toLowerCase();
  if (role) {
    return role;
  }
  if (tag === 'button') {
    return 'button';
  }
  if (tag === 'a') {
    return 'link';
  }
  if (tag === 'textarea') {
    return 'textbox';
  }
  if (tag === 'select') {
    return 'combobox';
  }
  if (tag === 'input') {
    if (['checkbox', 'radio', 'range'].includes(type)) {
      return type;
    }
    if (['button', 'submit', 'reset', 'image'].includes(type)) {
      return 'button';
    }
    return 'textbox';
  }
  return '';
}

function suggestedToolForElement(element = {}) {
  const role = elementRole(element);
  const tag = String(element.tag || element.tagName || '').toLowerCase();
  const type = String(element.type || '').toLowerCase();
  const label = normalizeText(element.label || element.placeholder || element.id || '');

  if (role === 'checkbox' || type === 'checkbox') {
    return {
      handle: element.handle,
      label,
      role: 'checkbox',
      preferredTool: 'codex_chrome_check',
      avoidTools: ['codex_chrome_click'],
      verification: 'value/state'
    };
  }

  if (role === 'radio' || type === 'radio') {
    return {
      handle: element.handle,
      label,
      role: 'radio',
      preferredTool: 'codex_chrome_check',
      avoidTools: ['codex_chrome_click'],
      verification: 'value/state'
    };
  }

  if (role === 'textbox' || tag === 'textarea') {
    return {
      handle: element.handle,
      label,
      role: 'textbox',
      preferredTool: 'codex_chrome_type',
      alternateTool: 'codex_chrome_fill',
      verification: 'value'
    };
  }

  if (role === 'combobox' || tag === 'select') {
    return {
      handle: element.handle,
      label,
      role: 'combobox',
      preferredTool: 'codex_chrome_select',
      verification: 'value'
    };
  }

  if (role === 'link' && element.href) {
    return {
      handle: element.handle,
      label,
      role: 'link',
      preferredTool: 'codex_chrome_click',
      verification: 'navigation'
    };
  }

  if (role === 'button') {
    return {
      handle: element.handle,
      label,
      role: 'button',
      preferredTool: 'codex_chrome_click',
      verification: 'explicit-post-condition-or-delta'
    };
  }

  return null;
}

function observationElements(result) {
  if (!result || typeof result !== 'object') {
    return [];
  }
  if (Array.isArray(result.elements)) {
    return result.elements;
  }
  if (result.observation && Array.isArray(result.observation.elements)) {
    return result.observation.elements;
  }
  return [];
}

function hintPriority(hint) {
  if (!hint || typeof hint !== 'object') {
    return 100;
  }
  if (hint.role === 'textbox') {
    return 1;
  }
  if (hint.role === 'checkbox' || hint.role === 'radio' || hint.role === 'combobox') {
    return 2;
  }
  if (hint.role === 'button') {
    return 3;
  }
  if (hint.role === 'link') {
    return 4;
  }
  return 10;
}

function buildInteractionHints(toolName, result) {
  if (!['codex_chrome_observe', 'codex_chrome_open_observe', 'codex_chrome_tab_observe'].includes(toolName)) {
    return null;
  }
  const elements = observationElements(result);
  if (elements.length === 0) {
    return null;
  }
  const suggestedTargets = elements
    .map(suggestedToolForElement)
    .filter(Boolean)
    .map((hint, index) => ({ hint, index }))
    .sort((left, right) => (
      hintPriority(left.hint) - hintPriority(right.hint) || left.index - right.index
    ))
    .map((entry) => entry.hint)
    .slice(0, 8);
  if (suggestedTargets.length === 0) {
    return null;
  }
  return {
    version: 1,
    suggestedTargets,
    generalRules: [
      'checkbox/radio: use check, not click',
      'text: use type/fill',
      'React buttons: add verify.oneOf when possible',
      'ACTION_RESULT_UNVERIFIED: re-observe before retry'
    ]
  };
}

function attachInteractionHints(toolName, result) {
  const interactionHints = buildInteractionHints(toolName, result);
  return interactionHints ? { ...result, interactionHints } : result;
}

module.exports = {
  attachInteractionHints,
  buildInteractionHints,
  suggestedToolForElement
};
