# Site Profiles

Site profiles describe site-specific workflows without hard-coding real sites as
global browser behavior. The daemon loads JSON profiles from `siteProfiles/` and
checks them before guarded workflows such as e-commerce cart preparation.

## E-Commerce Cart Profiles

`page.prepareCart` currently accepts only profiles with:

- `kind: "ecommerce-cart-preparation"`
- `enabled: true`
- an origin allowed by `origins` or `originPatterns`
- `riskPolicy.allowAddToCart: true`
- `riskPolicy.blockedActionKinds` containing `checkout`, `payment`, and
  `order-placement`

The default cart profile is `localTest.ecommerce.v1`. It is local-only and
allows fixture origins such as `http://127.0.0.1:<port>` and
`http://localhost:<port>`.

`hepsiburada.shopping.v1` is intentionally installed as a dry-run profile with
`realSiteEnabled: false`. The daemon returns `SITE_PROFILE_UNAVAILABLE` with
`reason: "REAL_SITE_PROFILE_DISABLED"` before queueing browser work for that
profile. This keeps the real Hepsiburada cart workflow closed until selector
tests and stop-before-checkout proof exist.

## Current Profiles

- `localTest.ecommerce.v1`: enabled local fixture profile used by clean smoke.
- `hepsiburada.shopping.v1`: disabled real-site profile contract for future
  selector dry-run and guarded enablement.

## Enablement Rule

Real-site cart preparation must not be enabled by changing extension content
logic alone. The profile must first pass profile-level tests for candidate
extraction, detail recheck, cart verification, and checkout/payment/order
placement blocking.
