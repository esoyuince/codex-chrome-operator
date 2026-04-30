(function initCartWorkflow(root) {
  'use strict';

  function text(value) {
    return String(value || '').trim();
  }

  function normalizeDecimal(value) {
    const raw = text(value).replace(/[^\d.,-]/g, '');
    if (!raw) {
      return null;
    }
    const lastComma = raw.lastIndexOf(',');
    const lastDot = raw.lastIndexOf('.');
    let normalized = raw;
    if (lastComma > lastDot) {
      normalized = raw.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > -1 && lastComma > -1) {
      normalized = raw.replace(/,/g, '');
    } else if (lastDot > -1) {
      const dotParts = raw.split('.');
      normalized = dotParts.at(-1).length === 3 ? raw.replace(/\./g, '') : raw;
    } else if (lastComma > -1) {
      const commaParts = raw.split(',');
      normalized = commaParts.at(-1).length === 3 ? raw.replace(/,/g, '') : raw.replace(',', '.');
    }
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function normalizePrice(value) {
    return normalizeDecimal(value);
  }

  function normalizeRating(value) {
    return normalizeDecimal(value);
  }

  function datasetValue(element, key) {
    if (!element || !element.dataset) {
      return '';
    }
    return element.dataset[key] || '';
  }

  function productSummaryFromCard(card) {
    const price = normalizePrice(datasetValue(card, 'price'));
    const sellerRating = normalizeRating(datasetValue(card, 'sellerRating'));
    return {
      element: card,
      productId: datasetValue(card, 'productId'),
      title: text(card && card.textContent),
      price,
      priceLabel: datasetValue(card, 'price'),
      currency: datasetValue(card, 'currency'),
      sellerName: datasetValue(card, 'sellerName'),
      sellerRating,
      sellerRatingLabel: datasetValue(card, 'sellerRating'),
      availability: datasetValue(card, 'availability') || 'unknown',
      shipping: datasetValue(card, 'shipping')
    };
  }

  function queryMatches(product, query) {
    const normalizedQuery = text(query).toLocaleLowerCase('tr-TR');
    if (!normalizedQuery) {
      return true;
    }
    return [
      product.title,
      product.productId,
      product.sellerName
    ].some((value) => text(value).toLocaleLowerCase('tr-TR').includes(normalizedQuery));
  }

  function exclusionReason(product, criteria = {}) {
    if (product.availability !== 'in-stock') {
      return 'out-of-stock';
    }
    if (product.sellerRating === null || product.sellerRating < Number(criteria.minSellerRating || 0)) {
      return 'seller-rating-below-threshold';
    }
    if (
      criteria.currency &&
      product.currency &&
      text(product.currency).toUpperCase() !== text(criteria.currency).toUpperCase()
    ) {
      return 'currency-mismatch';
    }
    if (criteria.maxPrice !== undefined && criteria.maxPrice !== null && product.price > Number(criteria.maxPrice)) {
      return 'above-max-price';
    }
    if (product.price === null) {
      return 'price-unavailable';
    }
    return null;
  }

  function sortProducts(products, sort) {
    const copy = [...products];
    if (sort === 'price-asc') {
      copy.sort((a, b) => {
        const priceA = a.price === null ? Number.POSITIVE_INFINITY : a.price;
        const priceB = b.price === null ? Number.POSITIVE_INFINITY : b.price;
        if (priceA !== priceB) {
          return priceA - priceB;
        }
        return (b.sellerRating || 0) - (a.sellerRating || 0);
      });
    }
    return copy;
  }

  function selectBestCandidate(cards, criteria = {}, query = '') {
    const products = sortProducts(
      [...(cards || [])].map(productSummaryFromCard).filter((product) => queryMatches(product, query)),
      criteria.sort
    );
    const eligible = [];
    const excluded = [];

    for (const product of products) {
      const reason = exclusionReason(product, criteria);
      if (reason) {
        excluded.push({
          productId: product.productId,
          reason
        });
      } else {
        eligible.push(product);
      }
    }

    eligible.sort((a, b) => {
      if (a.price !== b.price) {
        return a.price - b.price;
      }
      return b.sellerRating - a.sellerRating;
    });

    return {
      ...(eligible[0] || {}),
      eligible: eligible.map(publicProductSummary),
      excluded
    };
  }

  function publicProductSummary(product) {
    return {
      productId: product.productId,
      title: product.title,
      price: product.price,
      priceLabel: product.priceLabel,
      currency: product.currency,
      sellerName: product.sellerName,
      sellerRating: product.sellerRating,
      availability: product.availability,
      shipping: product.shipping
    };
  }

  function eventCtor(context) {
    return context.Event || root.Event;
  }

  function dispatchChange(element, context) {
    const EventCtor = eventCtor(context);
    if (!element || !EventCtor || typeof element.dispatchEvent !== 'function') {
      return;
    }
    element.dispatchEvent(new EventCtor('input', { bubbles: true }));
    element.dispatchEvent(new EventCtor('change', { bubbles: true }));
  }

  function applyFixtureControls(message, documentRef, context) {
    const search = documentRef.querySelector('[data-commerce-search]');
    if (search) {
      search.value = text(message.query);
      dispatchChange(search, context);
    }

    const sort = documentRef.querySelector('[data-commerce-sort]');
    if (sort && message.criteria && message.criteria.sort) {
      sort.value = message.criteria.sort;
      dispatchChange(sort, context);
    }
  }

  function detailRecheck(product, documentRef) {
    const panel = documentRef.querySelector('[data-detail-recheck]');
    if (panel && panel.dataset) {
      panel.dataset.productId = product.productId;
      panel.dataset.price = String(product.price);
      panel.dataset.sellerRating = String(product.sellerRating);
      panel.textContent = `Rechecked ${product.productId}: ${product.priceLabel}, seller ${product.sellerRatingLabel}`;
    }
    return {
      ok: true,
      productId: product.productId,
      price: product.price,
      sellerRating: product.sellerRating
    };
  }

  function cartCount(documentRef) {
    const counter = documentRef.querySelector('[data-cart-count]');
    const fromDataset = counter && counter.dataset ? Number(counter.dataset.cartItemCount) : NaN;
    const fromText = counter ? Number(text(counter.textContent)) : NaN;
    if (Number.isFinite(fromDataset)) {
      return fromDataset;
    }
    return Number.isFinite(fromText) ? fromText : 0;
  }

  function updateCartState(documentRef, product, beforeCount) {
    const counter = documentRef.querySelector('[data-cart-count]');
    const items = documentRef.querySelector('[data-cart-items]');
    const current = cartCount(documentRef);
    const next = current > beforeCount ? current : beforeCount + 1;
    if (counter) {
      counter.textContent = String(next);
      if (counter.dataset) {
        counter.dataset.cartItemCount = String(next);
      }
    }
    if (items) {
      items.textContent = `${product.productId} added`;
      if (items.dataset) {
        items.lastProductId = product.productId;
      }
    }
    return next;
  }

  function checkoutControlSummary(documentRef) {
    const checkout = documentRef.querySelector('[data-risk="checkout"]') ||
      documentRef.querySelector('[data-risk="high"][data-checkout-control]');
    if (!checkout) {
      return { present: false };
    }
    return {
      present: true,
      risk: checkout.dataset ? checkout.dataset.risk || null : null,
      id: checkout.id || null,
      label: text(checkout.textContent || checkout.getAttribute && checkout.getAttribute('aria-label'))
    };
  }

  function siteUnavailable() {
    return {
      ok: false,
      error: {
        code: 'SITE_PROFILE_UNAVAILABLE',
        message: 'Cart preparation is only available on the local mock commerce fixture.'
      }
    };
  }

  async function prepareCart(message = {}, context = {}) {
    const documentRef = context.document || root.document;
    if (!documentRef || typeof documentRef.querySelector !== 'function' || !documentRef.querySelector('[data-fixture="mock-commerce"]')) {
      return siteUnavailable();
    }

    const criteria = message.criteria || {};
    applyFixtureControls(message, documentRef, context);
    const cards = [...documentRef.querySelectorAll('[data-visual-card="product"]')];
    const selection = selectBestCandidate(cards, criteria, message.query);
    if (!selection.productId) {
      return {
        ok: false,
        error: {
          code: 'CART_CANDIDATE_NOT_FOUND',
          message: 'No product matched the requested cart criteria.',
          excluded: selection.excluded
        }
      };
    }

    const selected = publicProductSummary(selection);
    const detail = detailRecheck(selection, documentRef);
    const checkoutControl = checkoutControlSummary(documentRef);
    if (message.cartActionAllowed !== true) {
      return {
        ok: true,
        result: {
          origin: message.origin || null,
          profileId: message.profileId || null,
          selected,
          eligible: selection.eligible,
          excluded: selection.excluded,
          detailRecheck: detail,
          cart: {
            added: false,
            reason: 'cart-action-not-allowed'
          },
          stoppedBeforeCheckout: true,
          checkoutControl
        }
      };
    }

    const beforeCount = cartCount(documentRef);
    const addButton = selection.element && selection.element.querySelector('[data-cart-action="add"]');
    if (addButton && typeof addButton.click === 'function') {
      addButton.click();
    }
    const itemCount = updateCartState(documentRef, selection, beforeCount);
    return {
      ok: true,
      result: {
        origin: message.origin || null,
        profileId: message.profileId || null,
        selected,
        eligible: selection.eligible,
        excluded: selection.excluded,
        detailRecheck: detail,
        cart: {
          added: true,
          verified: itemCount > beforeCount,
          itemCount,
          productId: selection.productId
        },
        stoppedBeforeCheckout: true,
        checkoutControl
      }
    };
  }

  const api = {
    normalizePrice,
    normalizeRating,
    productSummaryFromCard,
    selectBestCandidate,
    prepareCart
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexCartWorkflow = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
