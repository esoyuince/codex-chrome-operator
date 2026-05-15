const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createVisualAnalyzerRegistry,
  analyzeVisualObservation,
  localBasicAnalyze,
  normalizeVisualAnalyzeRequest
} = require('../operator-daemon/visualAnalyzer');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function screenshot(overrides = {}) {
  return {
    artifactId: 'shot_test',
    path: 'C:\\tmp\\shot_test.png',
    mimeType: 'image/png',
    bytes: 1200,
    width: 1000,
    height: 800,
    ...overrides
  };
}

function observation(overrides = {}) {
  return {
    viewport: {
      width: 1000,
      height: 800
    },
    elements: [],
    ...overrides
  };
}

test('normalizeVisualAnalyzeRequest applies local-basic defaults without mutating input', () => {
  const request = {
    screenshot: screenshot({ bytes: Buffer.from('hello') }),
    observation: observation({
      elements: [
        {
          handle: 'el_card',
          bbox: { left: 10, top: 20, right: 110, bottom: 70 },
          labels: 'Product card',
          data: { role: 'product-card' }
        }
      ]
    })
  };

  const normalized = normalizeVisualAnalyzeRequest(request);

  assert.equal(normalized.provider, 'local-basic');
  assert.equal(normalized.screenshot.artifactId, 'shot_test');
  assert.equal(normalized.screenshot.bytes, 5);
  assert.deepEqual(normalized.observation.elements[0].bbox, {
    x: 10,
    y: 20,
    width: 100,
    height: 50
  });
  assert.deepEqual(normalized.observation.elements[0].labels, ['Product card']);
  assert.equal(request.observation.elements[0].bbox.x, undefined);
});

test('analyzeVisualObservation uses local-basic provider when provider is omitted', () => {
  const registry = createVisualAnalyzerRegistry();
  const result = analyzeVisualObservation({
    screenshot: screenshot(),
    observation: observation()
  }, registry);

  assert.equal(registry.hasProvider('local-basic'), true);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'local-basic');
  assert.equal(result.status, 'analyzed');
  assert.equal(result.artifactId, 'shot_test');
  assert.deepEqual(result.regions, []);
  assert.deepEqual(result.handleCorrelations, []);
  assert.equal(result.policy.sensitiveArtifacts, 'allow');
  assert.deepEqual(result.warnings, []);
  assert.equal(typeof result.confidence, 'number');
});

test('analyzeVisualObservation returns VISUAL_ANALYSIS_UNAVAILABLE for missing providers', () => {
  const result = analyzeVisualObservation({
    provider: 'cloud-vision',
    screenshot: screenshot(),
    observation: observation()
  });

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'cloud-vision');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.artifactId, 'shot_test');
  assert.equal(result.error.code, ERROR_CODES.VISUAL_ANALYSIS_UNAVAILABLE);
});

test('local-basic blocks unsupported image types and oversized artifacts', () => {
  const unsupportedType = analyzeVisualObservation({
    screenshot: screenshot({ mimeType: 'image/gif' }),
    observation: observation()
  });

  assert.equal(unsupportedType.ok, false);
  assert.equal(unsupportedType.status, 'blocked');
  assert.equal(unsupportedType.error.code, ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED);
  assert.equal(unsupportedType.error.reason, 'UNSUPPORTED_MIME_TYPE');

  const oversized = analyzeVisualObservation({
    screenshot: screenshot({ bytes: 2048 }),
    observation: observation(),
    policy: {
      limits: {
        maxBytes: 1024
      }
    }
  });

  assert.equal(oversized.ok, false);
  assert.equal(oversized.status, 'blocked');
  assert.equal(oversized.error.code, ERROR_CODES.VISUAL_ARTIFACT_TOO_LARGE);
  assert.equal(oversized.error.reason, 'ARTIFACT_TOO_LARGE');
});

test('local-basic blocks sensitive screenshots when policy forbids them', () => {
  const result = analyzeVisualObservation({
    screenshot: screenshot({ sensitive: true }),
    observation: observation(),
    policy: {
      allowSensitiveArtifacts: false
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED);
  assert.equal(result.error.reason, 'SENSITIVE_VISUAL_CONTENT');
  assert.equal(result.policy.sensitiveArtifacts, 'forbid');
});

test('local-basic detects product card and rating star regions from observed elements', () => {
  const result = localBasicAnalyze(normalizeVisualAnalyzeRequest({
    screenshot: screenshot(),
    observation: observation({
      elements: [
        {
          handle: 'product_1',
          bbox: { x: 40, y: 30, width: 320, height: 190 },
          labels: ['Product Card', 'Mac mini M4'],
          data: { role: 'product-card', productId: 'mac-mini-m4' }
        },
        {
          handle: 'price_1',
          bbox: { x: 64, y: 138, width: 92, height: 22 },
          labels: ['Price'],
          data: { price: '$599' }
        },
        {
          handle: 'rating_1',
          bbox: { x: 64, y: 170, width: 112, height: 18 },
          labels: ['4.5 out of 5 stars'],
          data: { rating: '4.5', maxRating: '5' }
        }
      ]
    })
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 'analyzed');

  const product = result.regions.find((region) => region.kind === 'product-card');
  const rating = result.regions.find((region) => region.kind === 'rating-stars');
  const price = result.regions.find((region) => region.kind === 'price');

  assert.equal(product.handle, 'product_1');
  assert.equal(product.text, 'Product Card Mac mini M4');
  assert.deepEqual(product.bbox, { x: 40, y: 30, width: 320, height: 190 });
  assert.equal(rating.handle, 'rating_1');
  assert.equal(rating.rating.value, 4.5);
  assert.equal(rating.rating.max, 5);
  assert.equal(price.handle, 'price_1');
  assert.equal(price.text, 'Price $599');
});

test('local-basic correlates DOM handles to screenshot coordinates using viewport metadata', () => {
  const result = localBasicAnalyze(normalizeVisualAnalyzeRequest({
    screenshot: screenshot({
      width: 1600,
      height: 900
    }),
    observation: observation({
      viewport: {
        width: 800,
        height: 450
      },
      elements: [
        {
          handle: 'el_buy',
          bbox: { x: 25, y: 50, width: 100, height: 40 },
          labels: ['Buy now button'],
          data: { role: 'button' }
        }
      ]
    })
  }));

  assert.equal(result.ok, true);
  assert.equal(result.handleCorrelations.length, 1);
  assert.deepEqual(result.handleCorrelations[0], {
    handle: 'el_buy',
    artifactId: 'shot_test',
    bbox: { x: 25, y: 50, width: 100, height: 40 },
    screenshotBbox: { x: 50, y: 100, width: 200, height: 80 },
    center: { x: 150, y: 140 },
    confidence: 0.9
  });
});

test('local-basic detects tables, charts, images, badges, and primary actions', () => {
  const result = localBasicAnalyze(normalizeVisualAnalyzeRequest({
    screenshot: screenshot(),
    observation: observation({
      elements: [
        {
          handle: 'table_1',
          bbox: { x: 20, y: 40, width: 420, height: 180 },
          tagName: 'table',
          labels: ['Revenue table']
        },
        {
          handle: 'chart_1',
          bbox: { x: 480, y: 40, width: 320, height: 200 },
          labels: ['Monthly trend chart'],
          data: { visualRole: 'chart' }
        },
        {
          handle: 'image_1',
          bbox: { x: 20, y: 260, width: 140, height: 90 },
          tagName: 'img',
          labels: ['Product photo']
        },
        {
          handle: 'badge_1',
          bbox: { x: 180, y: 260, width: 76, height: 24 },
          labels: ['Best seller badge']
        },
        {
          handle: 'button_1',
          bbox: { x: 280, y: 260, width: 130, height: 40 },
          role: 'button',
          labels: ['Add to cart'],
          data: { cartAction: 'add-to-cart' }
        }
      ]
    })
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.regions.map((region) => region.kind), [
    'table',
    'chart',
    'image',
    'badge',
    'primary-action'
  ]);
  assert.deepEqual(result.summary.regionCounts, {
    badge: 1,
    chart: 1,
    image: 1,
    'primary-action': 1,
    table: 1
  });
  assert.equal(result.summary.viewport.width, 1000);
  assert.equal(result.summary.screenshot.width, 1000);
});

test('local-basic does not classify plain form label elements as badges', () => {
  const result = localBasicAnalyze(normalizeVisualAnalyzeRequest({
    screenshot: screenshot(),
    observation: observation({
      elements: [{
        handle: 'label_1',
        tagName: 'label',
        bbox: { x: 20, y: 40, width: 120, height: 24 },
        labels: ['Email']
      }]
    })
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.regions, []);
  assert.equal(result.summary.regionCount, 0);
});
