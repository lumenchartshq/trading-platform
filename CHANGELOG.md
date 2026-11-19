# Changelog

Each release of `@lumencharts/trading-platform` has a section here. The notes
for a version also appear on its GitHub release.

## 0.2.0

Hosts can now lay out the trading panels themselves, and the order ticket
handles more situations on its own. Existing integrations keep working
without changes; the new options are all optional.

- Place panels yourself: the `dockSizing(kind)` port method (`platform`,
  `host` or `fixed`) says who sizes each dock, and `setDockSize` also reports
  whether the Account Manager is collapsed. With `fixed`, the Account Manager
  always shows its tables and has no minimise or maximise controls.
- Panels mounted in your own page's document get working events and popups,
  and trading dialogs and notifications can show over the whole page.
- New session options: `privacyMode` (a readable value) masks the money the
  platform estimates on chart lines, and `showPositionProfitCurrency` names
  the account currency on the position line's P&L.
- Toasts and confirmations name the broker's display symbol, and the order
  table's Type column names take profit and stop loss legs.
- The order ticket checks its own fields: zero, empty and off-step values get
  the ticket's message instead of the browser's validation bubble.
- After a confirmed modification, or a send the platform could not confirm,
  the ticket offers "Start creating order" instead of leaving you on a status
  message. A new limit or stop draft starts at the market price.
- `orderPanelVisibility` also reports position protection, so a host can show
  the chart when protection opens; writing `false` closes it.
- The chart's order draft popover is removed; drafts are edited in the ticket.
- Paper broker: only the price an order's type uses is checked, so a price
  left over from another order type no longer rejects an order.
- Keyboard focus returns to the control that opened a dialog.

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
