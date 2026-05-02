'use strict';

(function initIntentExtractors(globalScope) {
  const SUPPORTED_INTENTS = ['shopping.productCandidates'];
  const DEFAULT_MAX_CANDIDATES = 20;

  function cleanText(value, maxChars = 180) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  }

  function numberFromAttribute(element, name) {
    const raw = element.getAttribute(name);
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    const value = Number(String(raw).replace(',', '.'));
    return Number.isFinite(value) ? value : null;
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
    return cleanText(
      card.getAttribute('data-product-name') ||
      card.getAttribute('aria-label') ||
      card.getAttribute('title') ||
      card.innerText ||
      card.textContent ||
      card.getAttribute('data-product-id') ||
      ''
    );
  }

  function buildPriceLabel(card, price) {
    const rawLabel = cleanText(card.getAttribute('data-price-label'), 80);
    if (rawLabel) {
      return rawLabel;
    }
    const rawPrice = card.getAttribute('data-price');
    const currency = cleanText(card.getAttribute('data-currency'), 12);
    if (currency && rawPrice) {
      return `${currency} ${rawPrice}`;
    }
    if (rawPrice) {
      return rawPrice;
    }
    return price === null ? null : String(price);
  }

  function describeHandles(elements, context) {
    if (!globalScope.CodexPageHandles || typeof globalScope.CodexPageHandles.describeElements !== 'function') {
      return { pageStateId: null, items: [] };
    }
    return globalScope.CodexPageHandles.describeElements(elements, context);
  }

  function extractShoppingProductCandidates(context, options = {}) {
    const maxCandidates = maxCandidatesFromOptions(options);
    const cards = [...context.document.querySelectorAll('[data-visual-card="product"]')];
    const limitedCards = cards.slice(0, maxCandidates);
    const addButtons = limitedCards.map((card) => (
      card.querySelector ? card.querySelector('[data-cart-action="add"]') : null
    ));
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
      const price = numberFromAttribute(card, 'data-price');
      const addButton = card.querySelector ? card.querySelector('[data-cart-action="add"]') : null;
      const evidenceBits = [
        card.getAttribute('data-product-id') ? `product-id:${card.getAttribute('data-product-id')}` : null,
        price !== null ? 'fixture-price' : null,
        addButton ? 'add-action' : null,
        text ? cleanText(text, 80) : null
      ].filter(Boolean);

      return {
        name: text || null,
        price,
        priceLabel: buildPriceLabel(card, price),
        volumeMl: parseVolumeMl(text),
        genderHint: inferGenderHint(text),
        href: findHref(card),
        addToCartHandle: addButton ? addHandleByElement.get(addButton) || null : null,
        confidence: card.getAttribute('data-product-id') ? 0.9 : 0.7,
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
