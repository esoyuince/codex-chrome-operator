const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePrice,
  normalizeRating,
  selectBestCandidate,
  prepareCart
} = require('../extension/cartWorkflow');

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles === true;
  }
}

function fakeProduct({
  id,
  title,
  price,
  currency = 'TRY',
  sellerName,
  sellerRating,
  availability = 'in-stock',
  shipping = 'Tomorrow'
}) {
  const button = {
    clicked: false,
    click() {
      this.clicked = true;
    }
  };
  const dataset = {
    visualCard: 'product',
    productId: id,
    price,
    currency,
    sellerName,
    sellerRating,
    availability,
    shipping
  };
  return {
    dataset,
    textContent: title,
    querySelector(selector) {
      if (selector === '[data-cart-action="add"]') {
        return button;
      }
      return null;
    },
    button
  };
}

function fakeSelect() {
  return {
    value: '',
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event.type);
      return true;
    }
  };
}

function fakeInput() {
  return {
    value: '',
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event.type);
      return true;
    }
  };
}

function fakeMockCommerceDocument(products) {
  const fixture = { dataset: { fixture: 'mock-commerce' } };
  const search = fakeInput();
  const sort = fakeSelect();
  const cartCount = { textContent: '0', dataset: { cartItemCount: '0' } };
  const cartItems = { textContent: '' };
  const detail = {
    dataset: {},
    textContent: ''
  };
  const checkout = {
    id: 'checkoutButton',
    textContent: 'Pay now',
    dataset: { risk: 'checkout' },
    clicked: false,
    click() {
      this.clicked = true;
    }
  };

  return {
    products,
    search,
    sort,
    cartCount,
    cartItems,
    detail,
    checkout,
    querySelector(selector) {
      return {
        '[data-fixture="mock-commerce"]': fixture,
        '[data-commerce-search]': search,
        '[data-commerce-sort]': sort,
        '[data-cart-count]': cartCount,
        '[data-cart-items]': cartItems,
        '[data-detail-recheck]': detail,
        '[data-risk="checkout"]': checkout
      }[selector] || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-visual-card="product"]') {
        return products;
      }
      return [];
    }
  };
}

function sampleProducts() {
  return [
    fakeProduct({
      id: 'cheap-low-rating',
      title: 'Mac mini M2 8GB 256GB',
      price: '21.999 TL',
      sellerName: 'Ucuzcu',
      sellerRating: '3,7'
    }),
    fakeProduct({
      id: 'eligible-cheapest',
      title: 'Mac mini M2 8GB 256GB',
      price: '24.999 TL',
      sellerName: 'Tekno Liman',
      sellerRating: '4,5'
    }),
    fakeProduct({
      id: 'higher-rating',
      title: 'Mac mini M2 Pro 16GB 512GB',
      price: '31.499 TL',
      sellerName: 'Pro Store',
      sellerRating: '4.9'
    }),
    fakeProduct({
      id: 'out-of-stock',
      title: 'Mac mini M1 8GB 256GB',
      price: '23.499 TL',
      sellerName: 'Stok Yok',
      sellerRating: '4.8',
      availability: 'out-of-stock'
    })
  ];
}

test('normalizes Turkish TRY prices and decimal seller ratings', () => {
  assert.equal(normalizePrice('24.999 TL'), 24999);
  assert.equal(normalizePrice('31.499,50 TL'), 31499.5);
  assert.equal(normalizeRating('4,7'), 4.7);
});

test('selectBestCandidate excludes low-rated, out-of-stock, and over-budget products', () => {
  const selected = selectBestCandidate(sampleProducts(), {
    minSellerRating: 4,
    maxPrice: 30000,
    currency: 'try',
    sort: 'price-asc'
  });

  assert.equal(selected.productId, 'eligible-cheapest');
  assert.deepEqual(selected.excluded.map((item) => [item.productId, item.reason]), [
    ['cheap-low-rating', 'seller-rating-below-threshold'],
    ['out-of-stock', 'out-of-stock'],
    ['higher-rating', 'above-max-price']
  ]);
});

test('prepareCart returns CART_CANDIDATE_NOT_FOUND when all candidates are excluded', async () => {
  const document = fakeMockCommerceDocument(sampleProducts());

  const result = await prepareCart({
    query: 'Mac mini',
    criteria: { minSellerRating: 5, currency: 'TRY' },
    cartActionAllowed: true
  }, {
    document,
    Event: FakeEvent
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CART_CANDIDATE_NOT_FOUND');
  assert.equal(Array.isArray(result.error.excluded), true);
});

test('selectBestCandidate chooses highest rating when eligible prices tie', () => {
  const products = [
    fakeProduct({ id: 'same-price-a', title: 'Mac mini', price: '24.999 TL', sellerName: 'A', sellerRating: '4.2' }),
    fakeProduct({ id: 'same-price-b', title: 'Mac mini', price: '24.999 TL', sellerName: 'B', sellerRating: '4.8' })
  ];

  const selected = selectBestCandidate(products, { minSellerRating: 4, currency: 'TRY' });

  assert.equal(selected.productId, 'same-price-b');
});

test('prepareCart performs detail recheck and returns selected candidate without adding when cart action is not allowed', async () => {
  const document = fakeMockCommerceDocument(sampleProducts());

  const result = await prepareCart({
    query: 'Mac mini',
    criteria: { minSellerRating: 4, maxPrice: 30000, currency: 'TRY', sort: 'price-asc' },
    cartActionAllowed: false
  }, {
    document,
    Event: FakeEvent
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.selected.productId, 'eligible-cheapest');
  assert.deepEqual(result.result.detailRecheck, {
    ok: true,
    productId: 'eligible-cheapest',
    price: 24999,
    sellerRating: 4.5
  });
  assert.deepEqual(result.result.cart, {
    added: false,
    reason: 'cart-action-not-allowed'
  });
  assert.equal(document.products[1].button.clicked, false);
});

test('prepareCart adds to fixture cart, verifies count, and does not click checkout', async () => {
  const document = fakeMockCommerceDocument(sampleProducts());

  const result = await prepareCart({
    query: 'Mac mini',
    criteria: { minSellerRating: 4, currency: 'TRY', sort: 'price-asc' },
    cartActionAllowed: true
  }, {
    document,
    Event: FakeEvent
  });

  assert.equal(result.ok, true);
  assert.equal(document.products[1].button.clicked, true);
  assert.equal(document.checkout.clicked, false);
  assert.deepEqual(result.result.cart, {
    added: true,
    verified: true,
    itemCount: 1,
    productId: 'eligible-cheapest'
  });
  assert.equal(result.result.stoppedBeforeCheckout, true);
  assert.deepEqual(result.result.checkoutControl, {
    present: true,
    risk: 'checkout',
    id: 'checkoutButton',
    label: 'Pay now'
  });
});

test('prepareCart returns SITE_PROFILE_UNAVAILABLE outside the mock commerce fixture', async () => {
  const result = await prepareCart({}, {
    document: {
      querySelector: () => null,
      querySelectorAll: () => []
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SITE_PROFILE_UNAVAILABLE');
});
