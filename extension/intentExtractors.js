'use strict';

(function initIntentExtractors(globalScope) {
  const SUPPORTED_INTENTS = ['shopping.productCandidates'];
  const DEFAULT_MAX_CANDIDATES = 20;

  function cleanText(value, maxChars = 180) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  }

  function elementText(element, maxChars = 240) {
    if (!element) {
      return '';
    }
    const ownText = cleanText(element.innerText || element.textContent || '', maxChars);
    if (ownText) {
      return ownText;
    }
    const childText = [...(element.children || [])]
      .map((child) => elementText(child, maxChars))
      .filter(Boolean)
      .join(' ');
    return cleanText(childText, maxChars);
  }

  function queryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return [];
    }
    try {
      return [...root.querySelectorAll(selector)];
    } catch (_) {
      return [];
    }
  }

  function queryFirst(root, selector) {
    if (!root || typeof root.querySelector !== 'function') {
      return null;
    }
    try {
      return root.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function findFirstDescendant(root, selectors) {
    for (const selector of selectors) {
      const match = queryFirst(root, selector);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function attributeText(element, names) {
    for (const name of names) {
      const value = element && element.getAttribute ? cleanText(element.getAttribute(name)) : '';
      if (value) {
        return value;
      }
    }
    return '';
  }

  function numberFromAttribute(element, name) {
    const raw = element.getAttribute(name);
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    const value = Number(String(raw).replace(',', '.'));
    return Number.isFinite(value) ? value : null;
  }

  function parseLocalizedNumber(value) {
    let numeric = String(value || '').replace(/[^\d.,]/g, '');
    if (!numeric) {
      return null;
    }

    const lastComma = numeric.lastIndexOf(',');
    const lastDot = numeric.lastIndexOf('.');
    if (lastComma !== -1 && lastDot !== -1) {
      const decimalSeparator = lastComma > lastDot ? ',' : '.';
      const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
      numeric = numeric
        .split(thousandsSeparator).join('')
        .replace(decimalSeparator, '.');
    } else if (lastComma !== -1) {
      const decimals = numeric.length - lastComma - 1;
      numeric = decimals > 0 && decimals <= 2
        ? numeric.replace(/\./g, '').replace(',', '.')
        : numeric.replace(/,/g, '');
    } else if (lastDot !== -1) {
      const decimals = numeric.length - lastDot - 1;
      numeric = decimals > 0 && decimals <= 2
        ? numeric.replace(/,/g, '')
        : numeric.replace(/\./g, '');
    }

    const parsed = Number(numeric);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function priceLabelFromText(text) {
    const value = cleanText(text, 500);
    const patterns = [
      /(?:\u20ba|TL|TRY)\s*\d[\d.,\s]*(?:,\d{1,2})?/i,
      /\d[\d.,\s]*(?:,\d{1,2})?\s*(?:TL|TRY|\u20ba)\b/i,
      /(?:USD|\$|EUR|\u20ac)\s*\d[\d.,\s]*(?:[.,]\d{1,2})?/i,
      /\d[\d.,\s]*(?:[.,]\d{1,2})?\s*(?:USD|\$|EUR|\u20ac)\b/i
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) {
        return cleanText(match[0], 80);
      }
    }
    return '';
  }

  function maxCandidatesFromOptions(options = {}) {
    const requested = Number(options.maxCandidates);
    return Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : DEFAULT_MAX_CANDIDATES;
  }

  function parseVolumeMl(text) {
    const match = String(text || '').match(/\b(\d{1,4})\s*ml\b/i);
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  function inferGenderHint(text) {
    const value = ` ${String(text || '').toLowerCase()} `;
    const women = /\b(women|woman|female|femme|for her|kadın|kadin)\b/i.test(value);
    const men = /\b(men|man|male|homme|for him|erkek)\b/i.test(value);
    if (women && !men) {
      return 'women';
    }
    if (men && !women) {
      return 'men';
    }
    return null;
  }

  function findHref(card) {
    if (typeof card.href === 'string' && card.href) {
      return card.href;
    }
    const ownHref = card.getAttribute('href');
    if (ownHref) {
      return ownHref;
    }
    const link = card.querySelector && card.querySelector('a[href]');
    if (link) {
      return link.href || link.getAttribute('href') || null;
    }
    return null;
  }

  function candidateName(card) {
    const explicitName = attributeText(card, [
      'data-product-name',
      'data-name',
      'aria-label',
      'title'
    ]);
    if (explicitName) {
      return explicitName;
    }

    const titleElement = findFirstDescendant(card, [
      '[data-product-name]',
      '[data-test-id="product-title"]',
      '[data-testid="product-title"]',
      '[data-test-id="product-name"]',
      '[data-testid="product-name"]',
      'h2',
      'h3',
      'a[href]'
    ]);
    const titleText = elementText(titleElement);
    if (titleText) {
      return titleText;
    }

    return cleanText(
      elementText(card) ||
      card.getAttribute('data-product-id') ||
      card.getAttribute('data-sku') ||
      ''
    );
  }

  function priceDetails(card) {
    const explicitPrice = numberFromAttribute(card, 'data-price');
    const rawLabel = cleanText(card.getAttribute('data-price-label'), 80);
    if (rawLabel) {
      return {
        price: explicitPrice !== null ? explicitPrice : parseLocalizedNumber(rawLabel),
        priceLabel: rawLabel
      };
    }
    const rawPrice = card.getAttribute('data-price');
    const currency = cleanText(card.getAttribute('data-currency'), 12);
    if (currency && rawPrice) {
      return {
        price: explicitPrice,
        priceLabel: `${currency} ${rawPrice}`
      };
    }
    if (rawPrice) {
      return {
        price: explicitPrice,
        priceLabel: rawPrice
      };
    }

    const priceElement = findFirstDescendant(card, [
      '[data-test-id="price-current"]',
      '[data-testid="price-current"]',
      '[data-price]',
      '[itemprop="price"]',
      '.price'
    ]);
    const priceLabel = priceLabelFromText(elementText(priceElement) || elementText(card));
    return {
      price: parseLocalizedNumber(priceLabel),
      priceLabel: priceLabel || null
    };
  }

  function productSignal(element) {
    const values = [
      element.getAttribute('data-visual-card'),
      element.getAttribute('data-product-id'),
      element.getAttribute('data-sku'),
      element.getAttribute('data-test-id'),
      element.getAttribute('data-testid'),
      element.getAttribute('itemtype'),
      element.getAttribute('class'),
      element.getAttribute('id')
    ].filter(Boolean).join(' ').toLowerCase();
    return /\b(product|sku|item|urun)\b/.test(values) || values.includes('schema.org/product');
  }

  function findAddButton(card) {
    const explicit = findFirstDescendant(card, [
      '[data-cart-action="add"]',
      '[data-test-id="add-to-cart"]',
      '[data-testid="add-to-cart"]'
    ]);
    if (explicit) {
      return explicit;
    }
    const button = findFirstDescendant(card, ['button', '[role="button"]']);
    const text = elementText(button, 80).toLowerCase();
    return /\b(add|cart|basket|sepet|sepete)\b/.test(text) ? button : null;
  }

  function collectProductCards(context) {
    const explicitCards = queryAll(context.document, '[data-visual-card="product"]');
    const genericCards = queryAll(context.document, [
      '[data-product-id]',
      '[data-sku]',
      '[data-test-id="product-card"]',
      '[data-testid="product-card"]',
      '[itemtype*="Product"]',
      'article',
      'li'
    ].join(','));

    const seen = new Set();
    return [...explicitCards, ...genericCards].filter((card) => {
      if (!card || seen.has(card)) {
        return false;
      }
      seen.add(card);

      if (card.getAttribute('data-visual-card') === 'product') {
        return true;
      }

      const name = candidateName(card);
      const price = priceDetails(card);
      const score = [
        productSignal(card),
        Boolean(name),
        Boolean(price.priceLabel),
        Boolean(findHref(card)),
        Boolean(findAddButton(card))
      ].filter(Boolean).length;
      return score >= 3 && Boolean(name) && Boolean(price.priceLabel);
    });
  }

  function describeHandles(elements, context) {
    if (!globalScope.CodexPageHandles || typeof globalScope.CodexPageHandles.describeElements !== 'function') {
      return { pageStateId: null, items: [] };
    }
    return globalScope.CodexPageHandles.describeElements(elements, context);
  }

  function extractShoppingProductCandidates(context, options = {}) {
    const maxCandidates = maxCandidatesFromOptions(options);
    const cards = collectProductCards(context);
    const limitedCards = cards.slice(0, maxCandidates);
    const addButtons = limitedCards.map((card) => findAddButton(card));
    const describedCards = describeHandles(limitedCards, context);
    const describedAdds = describeHandles(addButtons.filter(Boolean), context);
    const addHandleByElement = new Map();
    addButtons.filter(Boolean).forEach((button, index) => {
      const item = describedAdds.items[index];
      if (item && item.handle) {
        addHandleByElement.set(button, item.handle);
      }
    });

    const productCandidates = limitedCards.map((card) => {
      const text = candidateName(card);
      const price = priceDetails(card);
      const addButton = findAddButton(card);
      const explicitFixtureCard = card.getAttribute('data-visual-card') === 'product';
      const evidenceBits = [
        card.getAttribute('data-product-id') ? `product-id:${card.getAttribute('data-product-id')}` : null,
        explicitFixtureCard ? 'fixture-product-card' : 'generic-product-card',
        price.priceLabel ? 'price' : null,
        addButton ? 'add-action' : null,
        text ? cleanText(text, 80) : null
      ].filter(Boolean);

      return {
        name: text || null,
        price: price.price,
        priceLabel: price.priceLabel,
        volumeMl: parseVolumeMl(text),
        genderHint: inferGenderHint(text),
        href: findHref(card),
        addToCartHandle: addButton ? addHandleByElement.get(addButton) || null : null,
        confidence: card.getAttribute('data-product-id') || explicitFixtureCard ? 0.9 : 0.72,
        evidence: evidenceBits.join(' | ').slice(0, 180)
      };
    });

    return {
      intent: 'shopping.productCandidates',
      status: 'ok',
      origin: context.location.origin,
      url: context.location.href,
      pageStateId: describedCards.pageStateId,
      productCandidates,
      limits: {
        maxCandidates,
        defaultMaxCandidates: DEFAULT_MAX_CANDIDATES,
        availableCandidates: cards.length
      }
    };
  }

  function extractIntent(context, options = {}) {
    const intent = options.intent;
    if (intent !== 'shopping.productCandidates') {
      return {
        intent,
        status: 'unsupported-intent',
        supportedIntents: SUPPORTED_INTENTS
      };
    }
    return extractShoppingProductCandidates(context, options);
  }

  globalScope.CodexIntentExtractors = {
    SUPPORTED_INTENTS,
    extractIntent
  };
})(globalThis);
