# Changelog

Each release of `@lumencharts/trading-platform` has a section here. The notes
for a version also appear on its GitHub release.

## 0.1.2

No code changes from 0.1.1. Security reports now go to
support@lumencharts.com; the address in earlier versions does not exist.

## 0.1.1

No code changes from 0.1.0. This version is published from the release
workflow with npm provenance, so you can check that the package was built
from the public repository. Upgrade at any time; nothing else changes.

## 0.1.0

First public release of the Lumen Charts trading platform.

- Broker, datafeed and port contracts in `@lumencharts/trading-platform/contracts`,
  following the widely used broker API shape so existing broker integrations
  connect unchanged.
- A headless trading session: broker state, order and position commands,
  capabilities, formatters and financial rules.
- Solid UI in `@lumencharts/trading-platform/ui`: order ticket, account
  manager, depth ladder, notifications and `mountTradingPlatform`.
- Quote and depth subscriptions in `@lumencharts/trading-platform/market-data`.
- A paper broker in `@lumencharts/trading-platform/paper`: `createPaperBroker`
  fills market, limit and stop orders against your own quotes, with take profit
  and stop loss, one net position per symbol and an account in the currency you
  choose. Use it for demos and tests, or as a starting point for your adapter.
- A simulated broker in `@lumencharts/trading-platform/mock`, with ready-made
  account profiles.
- A conformance kit in `@lumencharts/trading-platform/conformance` for testing
  your own broker integration.
