'use strict';

const { ERROR_CODES } = require('./protocol');

const DEFAULT_PROVIDER = 'local-basic';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxPixels: 4096 * 4096,
  allowedMimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp'])
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeProviderName(provider) {
  const value = typeof provider === 'string' ? provider.trim() : '';
  return value || DEFAULT_PROVIDER;
}

function normalizeByteCount(value) {
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (value && typeof value.byteLength === 'number') {
    return finiteNumber(value.byteLength, 0);
  }
  return Math.max(0, finiteNumber(value, 0));
}

function normalizeMimeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeBBox(bbox) {
  if (!isObject(bbox)) {
    return null;
  }

  if (
    Number.isFinite(Number(bbox.x)) &&
    Number.isFinite(Number(bbox.y)) &&
    Number.isFinite(Number(bbox.width)) &&
    Number.isFinite(Number(bbox.height))
  ) {
    return {
      x: roundNumber(finiteNumber(bbox.x)),
      y: roundNumber(finiteNumber(bbox.y)),
      width: roundNumber(Math.max(0, finiteNumber(bbox.width))),
      height: roundNumber(Math.max(0, finiteNumber(bbox.height)))
    };
  }

  const left = finiteNumber(bbox.left, NaN);
  const top = finiteNumber(bbox.top, NaN);
  if (Number.isFinite(left) && Number.isFinite(top)) {
    const width = Number.isFinite(Number(bbox.width))
      ? finiteNumber(bbox.width)
      : finiteNumber(bbox.right, left) - left;
    const height = Number.isFinite(Number(bbox.height))
      ? finiteNumber(bbox.height)
      : finiteNumber(bbox.bottom, top) - top;
    return {
      x: roundNumber(left),
      y: roundNumber(top),
      width: roundNumber(Math.max(0, width)),
      height: roundNumber(Math.max(0, height))
    };
  }

  return null;
}

function normalizeLabels(labels) {
  if (Array.isArray(labels)) {
    return labels.map((label) => String(label).trim()).filter(Boolean);
  }
  if (typeof labels === 'string' && labels.trim()) {
    return [labels.trim()];
  }
  return [];
}

function normalizeData(data) {
  if (!isObject(data)) {
    return {};
  }
  return Object.keys(data).sort().reduce((normalized, key) => {
    const value = data[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      normalized[key] = value;
    }
    return normalized;
  }, {});
}

function normalizeElement(element = {}) {
  const data = normalizeData({
    ...(element.data || element.dataset || element.dataAttributes || {}),
    ...(element.visualRole === undefined ? {} : { role: element.visualRole, visualRole: element.visualRole }),
    ...(element.dataVisualRole === undefined ? {} : { role: element.dataVisualRole, visualRole: element.dataVisualRole }),
    ...(element.productId === undefined ? {} : { productId: element.productId }),
    ...(element.ratingValue === undefined ? {} : { rating: element.ratingValue }),
    ...(element.maxRating === undefined ? {} : { maxRating: element.maxRating }),
    ...(element.analyzerField === undefined ? {} : { analyzerField: element.analyzerField })
  });
  return {
    handle: element.handle === undefined || element.handle === null ? null : String(element.handle),
    bbox: normalizeBBox(element.bbox || element.rect || element.boundingBox),
    labels: normalizeLabels(element.labels || element.label || element.ariaLabel),
    data,
    tagName: typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '',
    role: typeof element.role === 'string' ? element.role : ''
  };
}

function normalizeViewport(observation) {
  const source = isObject(observation.viewport) ? observation.viewport : observation;
  const width = finiteNumber(source.width || source.viewportWidth, 0);
  const height = finiteNumber(source.height || source.viewportHeight, 0);
  return {
    width: roundNumber(Math.max(0, width)),
    height: roundNumber(Math.max(0, height))
  };
}

function normalizeObservation(observation = {}) {
  const input = isObject(observation) ? observation : {};
  const elements = Array.isArray(input.elements) ? input.elements : [];
  return {
    viewport: normalizeViewport(input),
    sensitive: input.sensitive === true,
    sensitiveVisualContent: input.sensitiveVisualContent === true,
    visualPolicy: isObject(input.visualPolicy) ? input.visualPolicy : null,
    riskSummary: isObject(input.riskSummary) ? input.riskSummary : null,
    visibleTextSummary: typeof input.visibleTextSummary === 'string' ? input.visibleTextSummary : '',
    title: typeof input.title === 'string' ? input.title : '',
    elements: elements.map(normalizeElement)
  };
}

function normalizeScreenshot(screenshot = {}) {
  const input = isObject(screenshot) ? screenshot : {};
  return {
    artifactId: input.artifactId === undefined || input.artifactId === null
      ? null
      : String(input.artifactId),
    path: input.path === undefined || input.path === null ? null : String(input.path),
    mimeType: normalizeMimeType(input.mimeType || input.type),
    bytes: normalizeByteCount(input.bytes || input.bytesApprox || input.byteLength || input.size),
    width: roundNumber(Math.max(0, finiteNumber(input.width, 0))),
    height: roundNumber(Math.max(0, finiteNumber(input.height, 0))),
    sensitive: Boolean(
      input.sensitive ||
      input.containsSensitiveData ||
      input.sensitivity === 'sensitive' ||
      input.classification === 'sensitive'
    )
  };
}

function normalizeSensitiveArtifactPolicy(policy) {
  const values = [
    policy.sensitiveArtifacts,
    policy.sensitiveArtifactPolicy,
    policy.sensitiveArtifact
  ].filter((value) => value !== undefined && value !== null);

  if (policy.allowSensitiveArtifacts === false) {
    return 'forbid';
  }

  for (const value of values) {
    const normalized = String(value).toLowerCase();
    if (['forbid', 'forbidden', 'block', 'blocked', 'deny', 'denied'].includes(normalized)) {
      return 'forbid';
    }
    if (['allow', 'allowed'].includes(normalized)) {
      return 'allow';
    }
  }

  return 'allow';
}

function normalizeLimits(policy) {
  const limits = isObject(policy.limits) ? policy.limits : {};
  const allowedMimeTypes = Array.isArray(limits.allowedMimeTypes)
    ? limits.allowedMimeTypes.map(normalizeMimeType).filter(Boolean)
    : Array.isArray(policy.allowedMimeTypes)
      ? policy.allowedMimeTypes.map(normalizeMimeType).filter(Boolean)
    : DEFAULT_LIMITS.allowedMimeTypes.slice();

  return {
    maxBytes: Math.max(0, finiteNumber(
      policy.maxBytes === undefined ? limits.maxBytes : policy.maxBytes,
      DEFAULT_LIMITS.maxBytes
    )),
    maxPixels: Math.max(0, finiteNumber(
      policy.maxPixels === undefined ? limits.maxPixels : policy.maxPixels,
      DEFAULT_LIMITS.maxPixels
    )),
    allowedMimeTypes
  };
}

function normalizePolicy(policy = {}) {
  const input = isObject(policy) ? policy : {};
  return {
    sensitiveArtifacts: normalizeSensitiveArtifactPolicy(input),
    allowSensitive: input.allowSensitive === true || input.allowSensitiveArtifacts === true,
    allowExternal: input.allowExternal === true || input.external === true,
    limits: normalizeLimits(input)
  };
}

function normalizeVisualAnalyzeRequest(request = {}) {
  const input = isObject(request) ? request : {};
  return {
    provider: normalizeProviderName(input.provider),
    observation: normalizeObservation(input.observation),
    screenshot: normalizeScreenshot(input.screenshot),
    policy: normalizePolicy(input.policy)
  };
}

function emptyResult(normalized, status, extra = {}) {
  return {
    ok: status === 'ok',
    provider: normalized.provider,
    status,
    artifactId: normalized.screenshot.artifactId,
    regions: [],
    handleCorrelations: [],
    policy: normalized.policy,
    warnings: [],
    confidence: 0,
    ...extra
  };
}

function unavailableResult(normalized, reason) {
  return emptyResult(normalized, 'unavailable', {
    error: {
      code: ERROR_CODES.VISUAL_ANALYSIS_UNAVAILABLE,
      message: 'Visual analyzer provider is unavailable.',
      reason,
      provider: normalized.provider
    }
  });
}

function policyBlockedResult(normalized, reason, message) {
  return emptyResult(normalized, 'blocked', {
    error: {
      code: reason === 'ARTIFACT_TOO_LARGE'
        ? ERROR_CODES.VISUAL_ARTIFACT_TOO_LARGE
        : ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED,
      message,
      reason
    }
  });
}

function createVisualAnalyzerRegistry(options = {}) {
  const providerEntries = new Map();
  const registry = {
    defaultProvider: normalizeProviderName(options.defaultProvider),
    registerProvider(name, provider) {
      const providerName = normalizeProviderName(name);
      providerEntries.set(providerName, normalizeProviderEntry(providerName, provider));
      return registry;
    },
    hasProvider(name) {
      return providerEntries.has(normalizeProviderName(name));
    },
    getProvider(name) {
      return providerEntries.get(normalizeProviderName(name)) || null;
    },
    analyze(request) {
      return analyzeVisualObservation(request, registry);
    }
  };

  if (options.includeLocalBasic !== false) {
    registry.registerProvider(DEFAULT_PROVIDER, localBasicAnalyze);
  }

  if (isObject(options.providers)) {
    for (const [name, provider] of Object.entries(options.providers)) {
      registry.registerProvider(name, provider);
    }
  }

  return registry;
}

function normalizeProviderEntry(name, provider) {
  if (typeof provider === 'function') {
    return {
      name,
      analyze: provider,
      isAvailable: () => true
    };
  }
  if (!isObject(provider)) {
    return {
      name,
      analyze: null,
      isAvailable: () => false
    };
  }
  return {
    name,
    analyze: typeof provider.analyze === 'function' ? provider.analyze : null,
    isAvailable: typeof provider.isAvailable === 'function'
      ? provider.isAvailable
      : () => provider.available !== false
  };
}

function analyzeVisualObservation(request = {}, registry = createVisualAnalyzerRegistry()) {
  const normalized = normalizeVisualAnalyzeRequest(request);
  const activeRegistry = registry && typeof registry.getProvider === 'function'
    ? registry
    : createVisualAnalyzerRegistry(registry);
  const provider = activeRegistry.getProvider(normalized.provider);

  if (!provider || typeof provider.analyze !== 'function') {
    return unavailableResult(normalized, 'PROVIDER_NOT_REGISTERED');
  }

  let available = false;
  try {
    available = provider.isAvailable();
  } catch {
    available = false;
  }
  if (!available) {
    return unavailableResult(normalized, 'PROVIDER_UNAVAILABLE');
  }

  try {
    return provider.analyze(normalized);
  } catch (error) {
    return unavailableResult(normalized, 'PROVIDER_ERROR', {
      detail: error && error.message ? error.message : String(error)
    });
  }
}

function evaluatePolicy(normalized) {
  const { screenshot, policy } = normalized;
  const limits = policy.limits;
  if (!policy.allowSensitive && (screenshot.sensitive || isSensitiveVisualObservation(normalized.observation))) {
    return {
      reason: 'SENSITIVE_VISUAL_CONTENT',
      message: 'Visual analysis is blocked because sensitive page content was detected.'
    };
  }
  if (!limits.allowedMimeTypes.includes(screenshot.mimeType)) {
    return {
      reason: 'UNSUPPORTED_MIME_TYPE',
      message: `Image type is not allowed for local visual analysis: ${screenshot.mimeType || 'unknown'}.`
    };
  }
  if (screenshot.bytes > limits.maxBytes) {
    return {
      reason: 'ARTIFACT_TOO_LARGE',
      message: `Screenshot artifact is ${screenshot.bytes} bytes, above the ${limits.maxBytes} byte limit.`
    };
  }
  if (screenshot.width > 0 && screenshot.height > 0 && screenshot.width * screenshot.height > limits.maxPixels) {
    return {
      reason: 'ARTIFACT_TOO_LARGE',
      message: `Screenshot dimensions exceed the ${limits.maxPixels} pixel limit.`
    };
  }
  if (policy.sensitiveArtifacts === 'forbid' && screenshot.sensitive) {
    return {
      reason: 'SENSITIVE_VISUAL_CONTENT',
      message: 'Sensitive screenshot artifacts are forbidden by policy.'
    };
  }
  return null;
}

function sensitiveTextDetected(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /\b(password|otp|one[-\s]?time|credit card|card number|cvv|cvc|recovery code|secret|token)\b/i.test(value);
}

function isSensitiveVisualObservation(observation = {}) {
  if (!isObject(observation)) {
    return false;
  }
  if (
    observation.sensitive === true ||
    observation.sensitiveVisualContent === true ||
    observation.visualPolicy?.sensitive === true ||
    observation.riskSummary?.detectedSensitiveFields?.length > 0
  ) {
    return true;
  }
  if (sensitiveTextDetected(observation.visibleTextSummary || observation.title || '')) {
    return true;
  }
  const elements = Array.isArray(observation.elements) ? observation.elements : [];
  return elements.some((element) => sensitiveTextDetected([
    element.label,
    element.ariaLabel,
    element.name,
    element.type,
    element.role,
    element.visualRole,
    ...(Array.isArray(element.labels) ? element.labels : [])
  ].filter(Boolean).join(' ')));
}

function visualPolicyBlockIfNeeded({ observation = {}, screenshot = {}, policy = {} } = {}) {
  const normalized = normalizeVisualAnalyzeRequest({
    observation,
    screenshot,
    policy
  });
  const policyBlock = evaluatePolicy(normalized);
  if (!policyBlock) {
    return null;
  }
  return {
    ok: false,
    error: {
      code: policyBlock.reason === 'ARTIFACT_TOO_LARGE'
        ? ERROR_CODES.VISUAL_ARTIFACT_TOO_LARGE
        : ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED,
      message: policyBlock.message,
      reason: policyBlock.reason
    }
  };
}

function searchableText(element) {
  const dataParts = Object.entries(element.data).flatMap(([key, value]) => [key, value]);
  return [
    ...element.labels,
    element.tagName,
    element.role,
    ...dataParts
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();
}

function displayText(element) {
  const values = [...element.labels];
  for (const key of ['text', 'title', 'name', 'ariaLabel', 'price', 'value']) {
    if (element.data[key] !== undefined) {
      values.push(String(element.data[key]));
    }
  }
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].join(' ');
}

function includesProductCard(element, text) {
  return (
    element.data.role === 'product-card' ||
    element.data.type === 'product-card' ||
    element.data.productId !== undefined ||
    /\bproduct[-_\s]*(card|tile)?\b/.test(text) ||
    /\b(card|tile)\b/.test(text) && /\bproduct\b/.test(text)
  );
}

function includesRatingStars(element, text) {
  return (
    element.data.rating !== undefined ||
    element.data.maxRating !== undefined ||
    /\brating\b/.test(text) ||
    /\bstars?\b/.test(text) ||
    /out of\s+\d/.test(text)
  );
}

function includesPrice(element, text) {
  return (
    element.data.price !== undefined ||
    /\bprice\b/.test(text) ||
    /[$€£]\s*\d/.test(text) ||
    /\b\d+(?:[.,]\d{2})?\s*(usd|eur|try|gbp)\b/.test(text)
  );
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const parsed = Number(String(value).replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseRating(element) {
  const text = searchableText(element);
  const outOf = text.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(\d+(?:\.\d+)?)/);
  const value = outOf
    ? Number(outOf[1])
    : firstFiniteNumber([element.data.rating, element.data.value, ...element.labels]);
  const max = outOf
    ? Number(outOf[2])
    : firstFiniteNumber([element.data.maxRating, element.data.max, element.data.stars]) || 5;

  if (!Number.isFinite(value)) {
    return null;
  }
  return {
    value,
    max: Number.isFinite(max) ? max : 5
  };
}

function regionForElement(element, artifactId) {
  if (!element.bbox) {
    return null;
  }

  const text = searchableText(element);
  let kind = null;
  let confidence = 0.6;
  const extra = {};

  if (includesProductCard(element, text)) {
    kind = 'product-card';
    confidence = 0.78;
  } else if (includesRatingStars(element, text)) {
    kind = 'rating-stars';
    confidence = 0.86;
    const rating = parseRating(element);
    if (rating) {
      extra.rating = rating;
    }
  } else if (includesPrice(element, text)) {
    kind = 'price';
    confidence = 0.74;
  }

  if (!kind) {
    return null;
  }

  return {
    kind,
    handle: element.handle,
    artifactId,
    bbox: { ...element.bbox },
    labels: element.labels.slice(),
    text: displayText(element),
    confidence,
    ...extra
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scaledBbox(bbox, screenshot, viewport) {
  const scaleX = screenshot.width > 0 && viewport.width > 0 ? screenshot.width / viewport.width : 1;
  const scaleY = screenshot.height > 0 && viewport.height > 0 ? screenshot.height / viewport.height : 1;
  const maxX = screenshot.width > 0 ? screenshot.width : Infinity;
  const maxY = screenshot.height > 0 ? screenshot.height : Infinity;
  const left = clamp(bbox.x * scaleX, 0, maxX);
  const top = clamp(bbox.y * scaleY, 0, maxY);
  const right = clamp((bbox.x + bbox.width) * scaleX, 0, maxX);
  const bottom = clamp((bbox.y + bbox.height) * scaleY, 0, maxY);
  return {
    x: roundNumber(left),
    y: roundNumber(top),
    width: roundNumber(Math.max(0, right - left)),
    height: roundNumber(Math.max(0, bottom - top))
  };
}

function correlateElement(element, normalized) {
  if (!element.handle || !element.bbox || element.bbox.width <= 0 || element.bbox.height <= 0) {
    return null;
  }

  const screenshotBbox = scaledBbox(
    element.bbox,
    normalized.screenshot,
    normalized.observation.viewport
  );

  if (screenshotBbox.width <= 0 || screenshotBbox.height <= 0) {
    return null;
  }

  return {
    handle: element.handle,
    artifactId: normalized.screenshot.artifactId,
    bbox: { ...element.bbox },
    screenshotBbox,
    center: {
      x: roundNumber(screenshotBbox.x + screenshotBbox.width / 2),
      y: roundNumber(screenshotBbox.y + screenshotBbox.height / 2)
    },
    confidence: 0.9
  };
}

function averageConfidence(regions, handleCorrelations) {
  if (regions.length > 0) {
    return roundNumber(
      regions.reduce((total, region) => total + region.confidence, 0) / regions.length
    );
  }
  if (handleCorrelations.length > 0) {
    return 0.7;
  }
  return 0.55;
}

function localBasicAnalyze(request = {}) {
  const normalized = normalizeVisualAnalyzeRequest(request);
  const policyBlock = evaluatePolicy(normalized);
  if (policyBlock) {
    return policyBlockedResult(normalized, policyBlock.reason, policyBlock.message);
  }

  const regions = normalized.observation.elements
    .map((element) => regionForElement(element, normalized.screenshot.artifactId))
    .filter(Boolean)
    .sort((left, right) => (
      left.bbox.y - right.bbox.y ||
      left.bbox.x - right.bbox.x ||
      String(left.handle || '').localeCompare(String(right.handle || ''))
    ));
  const handleCorrelations = normalized.observation.elements
    .map((element) => correlateElement(element, normalized))
    .filter(Boolean)
    .sort((left, right) => String(left.handle).localeCompare(String(right.handle)));

  return {
    ok: true,
    provider: DEFAULT_PROVIDER,
    status: 'analyzed',
    artifactId: normalized.screenshot.artifactId,
    regions,
    handleCorrelations,
    policy: normalized.policy,
    warnings: [],
    confidence: averageConfidence(regions, handleCorrelations)
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_PROVIDER,
  createVisualAnalyzerRegistry,
  analyzeVisualObservation,
  isSensitiveVisualObservation,
  localBasicAnalyze,
  normalizeVisualAnalyzeRequest,
  visualPolicyBlockIfNeeded
};
