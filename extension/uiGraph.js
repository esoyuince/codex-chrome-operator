(function initUiGraph(root) {
  'use strict';

  const UI_GRAPH_VERSION = 'uiGraph.v1';

  function normalizeText(value, maxChars = 200) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function fallbackRole(element = {}) {
    if (element.role) {
      return element.role;
    }
    if (element.tag === 'button') {
      return 'button';
    }
    if (element.tag === 'a') {
      return 'link';
    }
    if (element.tag === 'textarea') {
      return 'textbox';
    }
    if (element.tag === 'select') {
      return 'combobox';
    }
    if (element.tag === 'input') {
      const type = String(element.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) {
        return 'button';
      }
      if (['checkbox', 'radio', 'range'].includes(type)) {
        return type;
      }
      return 'textbox';
    }
    return element.visualRole || 'region';
  }

  function elementName(element = {}) {
    return normalizeText(
      element.label ||
      element.title ||
      element.placeholder ||
      element.name ||
      element.id ||
      element.href ||
      ''
    );
  }

  function nodeEvidence(element = {}, axNode) {
    const evidence = ['dom-tag'];
    if (element.label) {
      evidence.push('dom-label');
    }
    if (element.id) {
      evidence.push('dom-id');
    }
    if (element.name) {
      evidence.push('dom-name');
    }
    if (element.bbox) {
      evidence.push('dom-bbox');
    }
    if (axNode && axNode.name) {
      evidence.push('ax-name');
    }
    if (axNode && axNode.role) {
      evidence.push('ax-role');
    }
    return evidence;
  }

  function confidenceFor(evidence) {
    const score = evidence.reduce((total, item) => {
      if (item === 'ax-name' || item === 'ax-role') {
        return total + 0.18;
      }
      if (item === 'dom-label') {
        return total + 0.2;
      }
      if (item === 'dom-id' || item === 'dom-name' || item === 'dom-bbox') {
        return total + 0.08;
      }
      return total + 0.04;
    }, 0.35);
    return Math.round(Math.min(0.95, score) * 100) / 100;
  }

  function candidateAttributes(candidate = {}) {
    return candidate.dom && candidate.dom.attributes && typeof candidate.dom.attributes === 'object'
      ? candidate.dom.attributes
      : {};
  }

  function targetValue(target = {}, key) {
    if (target[key] !== undefined && target[key] !== null && target[key] !== '') {
      return target[key];
    }
    if (target.data && typeof target.data === 'object') {
      const dataKeys = key === 'testid'
        ? ['testid', 'testId', 'data-testid', 'data-test-id', 'data-test']
        : [key];
      for (const dataKey of dataKeys) {
        if (target.data[dataKey] !== undefined && target.data[dataKey] !== null && target.data[dataKey] !== '') {
          return target.data[dataKey];
        }
      }
    }
    return null;
  }

  function candidateTestId(candidate = {}) {
    const attributes = candidateAttributes(candidate);
    return attributes['data-testid'] ||
      attributes['data-test-id'] ||
      attributes['data-test'] ||
      attributes.testid ||
      null;
  }

  function addScore(state, points, evidence) {
    state.total += points;
    state.evidence.push(evidence);
  }

  function scoreCandidate(candidate = {}, query = {}) {
    const target = query.target || {};
    const previous = query.previousDescriptor || {};
    const state = { total: 0, evidence: [] };
    const targetName = normalizeText(target.name || target.label || '');
    const candidateName = normalizeText(candidate.name || '');
    const candidateText = normalizeText(candidate.visibleText || '');
    const testid = targetValue(target, 'testid');

    if (target.targetId && candidate.targetId === target.targetId) {
      addScore(state, 0.28, 'targetId matched');
    }
    if (target.handle && candidate.handle === target.handle) {
      addScore(state, 0.22, 'handle matched');
    }
    if (target.role && candidate.role === target.role) {
      addScore(state, 0.16, 'role matched');
    }
    if (targetName && candidateName === targetName) {
      addScore(state, 0.24, 'accessible name matched');
    }
    if (target.label && candidateText.includes(normalizeText(target.label))) {
      addScore(state, 0.16, 'visible label matched');
    }
    if (target.href && candidate.dom && candidate.dom.href === target.href) {
      addScore(state, 0.18, 'href matched');
    }
    if (testid && candidateTestId(candidate) === testid) {
      addScore(state, 0.2, 'data-testid matched');
    }
    if (
      previous.fingerprints &&
      previous.fingerprints.semantic &&
      candidate.fingerprints &&
      previous.fingerprints.semantic === candidate.fingerprints.semantic
    ) {
      addScore(state, 0.22, 'semantic fingerprint matched');
    }
    if (
      previous.fingerprints &&
      previous.fingerprints.neighborHash &&
      candidate.fingerprints &&
      previous.fingerprints.neighborHash === candidate.fingerprints.neighborHash
    ) {
      addScore(state, 0.08, 'neighbor context matched');
    }
    if (
      previous.fingerprints &&
      previous.fingerprints.layout &&
      candidate.fingerprints &&
      previous.fingerprints.layout === candidate.fingerprints.layout
    ) {
      addScore(state, 0.06, 'layout fingerprint matched');
    }
    if (candidate.states && candidate.states.visible === true) {
      addScore(state, 0.04, 'visible');
    }
    if (candidate.states && candidate.states.enabled === true) {
      addScore(state, 0.04, 'enabled');
    }
    if (candidate.states && candidate.states.occluded === false) {
      addScore(state, 0.04, 'not occluded');
    }
    if (Number.isFinite(Number(candidate.confidence))) {
      addScore(state, Math.max(0, Math.min(1, Number(candidate.confidence))) * 0.25, 'candidate confidence');
    }

    return {
      total: Math.round(Math.min(1, state.total) * 100) / 100,
      evidence: state.evidence
    };
  }

  function targetCandidateSummary(entry) {
    return {
      targetId: entry.candidate.targetId || null,
      handle: entry.candidate.handle || null,
      role: entry.candidate.role || null,
      name: entry.candidate.name || null,
      confidence: entry.score.total,
      evidence: entry.score.evidence
    };
  }

  function ambiguous(reason, scored, details = {}) {
    return {
      ok: false,
      error: {
        code: 'AMBIGUOUS_TARGET',
        message: reason === 'TARGET_NOT_UNIQUE'
          ? 'Multiple matching controls found with insufficient confidence separation.'
          : 'Target confidence is too low to act safely.',
        reason,
        candidates: scored.slice(0, 5).map(targetCandidateSummary),
        ...details
      }
    };
  }

  function resolveTarget({
    handle,
    target,
    intent,
    candidates = [],
    previousDescriptor,
    confidenceThreshold = 0.72,
    uniquenessMargin = 0.12
  } = {}) {
    const query = {
      handle,
      target: {
        ...(target || {}),
        ...(handle && !(target && target.handle) ? { handle } : {})
      },
      intent,
      previousDescriptor
    };
    const scored = candidates
      .filter((candidate) => candidate && typeof candidate === 'object')
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, query)
      }))
      .sort((a, b) => b.score.total - a.score.total);
    const best = scored[0];
    const second = scored[1];

    if (!best || best.score.total < confidenceThreshold) {
      return {
        ok: false,
        error: {
          code: 'TARGET_CONFIDENCE_TOO_LOW',
          message: 'Target confidence is below threshold.',
          reason: 'TARGET_CONFIDENCE_TOO_LOW',
          details: {
            threshold: confidenceThreshold,
            bestConfidence: best ? best.score.total : 0
          },
          candidates: scored.slice(0, 5).map(targetCandidateSummary)
        }
      };
    }

    if (second && best.score.total - second.score.total < uniquenessMargin) {
      return ambiguous('TARGET_NOT_UNIQUE', scored, {
        details: {
          threshold: confidenceThreshold,
          uniquenessMargin,
          bestConfidence: best.score.total,
          secondConfidence: second.score.total
        }
      });
    }

    return {
      ok: true,
      target: best.candidate,
      confidence: best.score.total,
      evidence: best.score.evidence
    };
  }

  function normalizedBox(value) {
    if (!value) {
      return null;
    }
    if (Array.isArray(value) && value.length >= 4) {
      return {
        x: Number(value[0]),
        y: Number(value[1]),
        width: Number(value[2]),
        height: Number(value[3])
      };
    }
    return {
      x: Number(value.x),
      y: Number(value.y),
      width: Number(value.width),
      height: Number(value.height)
    };
  }

  function smallLayoutDrift(previousBox, currentBox) {
    const previous = normalizedBox(previousBox);
    const current = normalizedBox(currentBox);
    if (!previous || !current) {
      return false;
    }
    return [previous.x, previous.y, previous.width, previous.height, current.x, current.y, current.width, current.height]
      .every((value) => Number.isFinite(value)) &&
      Math.abs(previous.x - current.x) <= 16 &&
      Math.abs(previous.y - current.y) <= 16 &&
      Math.abs(previous.width - current.width) <= 24 &&
      Math.abs(previous.height - current.height) <= 24;
  }

  function canUseStableIndexRecovery({ descriptor, currentSet } = {}) {
    if (!descriptor || !Array.isArray(currentSet)) {
      return false;
    }
    if (descriptor.originalMatchCount !== currentSet.length) {
      return false;
    }
    const candidate = currentSet[descriptor.index];
    if (!candidate) {
      return false;
    }
    const previousFingerprints = descriptor.fingerprints || {};
    const currentFingerprints = candidate.fingerprints || {};
    const previousLocation = descriptor.location || {};
    const currentLocation = candidate.location || {};
    return previousFingerprints.semantic === currentFingerprints.semantic &&
      previousFingerprints.neighborHash === currentFingerprints.neighborHash &&
      previousLocation.frameId === currentLocation.frameId &&
      previousLocation.documentId === currentLocation.documentId &&
      Number(candidate.confidence) >= 0.8 &&
      smallLayoutDrift(previousLocation.bbox, currentLocation.bbox);
  }

  function normalizedAxNodes(axSnapshot) {
    if (!axSnapshot || axSnapshot.ok !== true || !axSnapshot.result || !Array.isArray(axSnapshot.result.nodes)) {
      return [];
    }
    return axSnapshot.result.nodes;
  }

  function matchAxNode(element, axNodes, usedIndexes) {
    const role = fallbackRole(element);
    const name = elementName(element);
    if (!name) {
      return null;
    }
    for (let index = 0; index < axNodes.length; index += 1) {
      if (usedIndexes.has(index)) {
        continue;
      }
      const axNode = axNodes[index];
      if (
        normalizeText(axNode && axNode.name) === name &&
        (!axNode.role || axNode.role === role)
      ) {
        usedIndexes.add(index);
        return axNode;
      }
    }
    return null;
  }

  function elementAttributes(element = {}) {
    return Object.fromEntries(Object.entries({
      id: element.id || null,
      name: element.name || null,
      type: element.type || null,
      placeholder: element.placeholder || null,
      title: element.title || null,
      productId: element.productId || null,
      uploadRole: element.uploadRole || null,
      visualRole: element.visualRole || null
    }).filter(([, value]) => value !== null && value !== ''));
  }

  function layoutFingerprint(element = {}) {
    const box = normalizedBox(element.bbox);
    if (!box) {
      return 'layout:none';
    }
    return hashText([
      Math.round(box.x / 8),
      Math.round(box.y / 8),
      Math.round(box.width / 8),
      Math.round(box.height / 8)
    ].join('|'));
  }

  function neighborFingerprint(elements, index) {
    const previous = elements[index - 1] ? `${fallbackRole(elements[index - 1])}:${elementName(elements[index - 1])}` : '';
    const next = elements[index + 1] ? `${fallbackRole(elements[index + 1])}:${elementName(elements[index + 1])}` : '';
    return hashText(`${previous}|${next}`);
  }

  function domPathFingerprint(element = {}) {
    return hashText([
      element.tag || '',
      element.id || '',
      element.name || '',
      element.type || '',
      element.href || ''
    ].join('|'));
  }

  function buildUiNode(element, index, observation, axNode, elements = []) {
    const role = axNode && axNode.role ? axNode.role : fallbackRole(element);
    const name = axNode && axNode.name ? normalizeText(axNode.name) : elementName(element);
    const evidence = nodeEvidence(element, axNode);
    const pageStateId = observation && observation.pageStateId ? observation.pageStateId : 'unknown';
    const targetId = `ui_${pageStateId}_${index}`;
    const confidence = confidenceFor(evidence);
    const semanticFingerprint = hashText([
      role,
      name,
      element.tag || '',
      element.id || '',
      element.name || '',
      element.href || '',
      element.dataRisk || ''
    ].join('|'));

    return {
      targetId,
      handle: element.handle || null,
      target: {
        id: targetId,
        handle: element.handle || null,
        confidence,
        evidence
      },
      role,
      name,
      description: axNode && axNode.description ? axNode.description : null,
      visibleText: normalizeText(element.label || ''),
      tagName: element.tag || null,
      type: element.type || null,
      states: {
        visible: true,
        enabled: element.disabled === undefined ? null : !element.disabled,
        focused: axNode ? axNode.focused : null,
        checked: axNode ? axNode.checked : null,
        selected: axNode ? axNode.selected : null,
        expanded: axNode ? axNode.expanded : null,
        required: axNode ? axNode.required : null,
        invalid: axNode ? axNode.invalid : null
      },
      location: {
        bbox: element.bbox || null,
        viewportRelative: true,
        scrollX: element.context && element.context.scroll ? element.context.scroll.x : null,
        scrollY: element.context && element.context.scroll ? element.context.scroll.y : null
      },
      dom: {
        attributes: elementAttributes(element),
        href: element.href || null,
        dataRisk: element.dataRisk || null
      },
      ax: axNode ? {
        axNodeId: axNode.axNodeId || null,
        backendDOMNodeId: axNode.backendDOMNodeId ?? null
      } : null,
      visual: {},
      fingerprints: {
        semantic: semanticFingerprint,
        layout: layoutFingerprint(element),
        domPathHash: domPathFingerprint(element),
        neighborHash: neighborFingerprint(elements, index)
      },
      confidence,
      evidence,
      risk: {
        level: element.dataRisk ? 'medium' : 'low',
        reasons: element.dataRisk ? [element.dataRisk] : []
      }
    };
  }

  function buildUiGraph(observation = {}, options = {}) {
    const axNodes = normalizedAxNodes(options.axSnapshot);
    const usedAxIndexes = new Set();
    const axAvailable = axNodes.length > 0;
    const elements = Array.isArray(observation.elements) ? observation.elements : [];
    const nodes = elements
      .filter((element) => element && (element.handle || element.label || element.id || element.name || element.href))
      .map((element, index) => buildUiNode(
        element,
        index,
        observation,
        matchAxNode(element, axNodes, usedAxIndexes),
        elements
      ));

    return {
      version: UI_GRAPH_VERSION,
      source: axAvailable ? 'dom+ax' : 'dom-fallback',
      nodeCount: nodes.length,
      nodes
    };
  }

  function axStatus(axSnapshot) {
    if (!axSnapshot || axSnapshot.ok !== true || !axSnapshot.result) {
      return {
        available: false,
        error: axSnapshot && axSnapshot.error ? axSnapshot.error : null
      };
    }
    return {
      available: true,
      nodeCount: Array.isArray(axSnapshot.result.nodes) ? axSnapshot.result.nodes.length : 0,
      rawNodeCount: axSnapshot.result.rawNodeCount,
      truncated: Boolean(axSnapshot.result.truncated)
    };
  }

  function attachUiGraph(observation, options = {}) {
    if (!observation || typeof observation !== 'object') {
      return observation;
    }
    const status = axStatus(options.axSnapshot);
    return {
      ...observation,
      capabilities: {
        ...(observation.capabilities || {}),
        axAvailable: status.available,
        uiGraph: true
      },
      ax: status,
      uiGraph: buildUiGraph(observation, options)
    };
  }

  const api = {
    UI_GRAPH_VERSION,
    attachUiGraph,
    buildUiGraph,
    canUseStableIndexRecovery,
    resolveTarget,
    scoreCandidate
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexUiGraph = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
