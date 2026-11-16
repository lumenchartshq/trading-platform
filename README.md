# Lumen Charts trading platform

Trading for [Lumen Charts](https://lumencharts.com): the broker contracts, a
headless trading session, and the order ticket, account manager, depth ladder
and chart trading UI built on them. It also ships a simulated broker and a
conformance kit for testing your own broker integration.

| Entry point | Use it for |
| --- | --- |
| `@lumencharts/trading-platform/contracts` | Broker, datafeed and port types (also split into `/contracts/broker`, `/contracts/market-data` and `/contracts/ports`). |
| `@lumencharts/trading-platform` | The headless trading session: broker state, commands, capabilities, formatters and financial rules. No UI, no DOM. |
| `@lumencharts/trading-platform/ui` | Solid UI: order ticket, account manager, depth ladder, notifications and `mountTradingPlatform`. Style it with `/ui/style.css`. |
| `@lumencharts/trading-platform/market-data` | Quote and depth subscriptions shared by the session and the UI. |
| `@lumencharts/trading-platform/mock` | A simulated broker with scenarios, for demos and tests. |
| `@lumencharts/trading-platform/conformance` | Acceptance scenarios to run against your own broker integration. |
| `@lumencharts/trading-platform/asset` | The trading module the Lumen Charts widget loads. |

The broker and datafeed contracts follow the widely used broker API shape, so
an existing broker integration can be connected without changes.

The package is open source under the Apache License 2.0. Lumen Charts itself
is a separate, commercially licensed charting library.

## Install

```bash
npm install @lumencharts/trading-platform
```

## Try it with the simulated broker

`@lumencharts/trading-platform/mock` exports `createDeterministicBroker`, a
broker that runs in memory on a `SimulationClock`, and `simulationProfiles`,
ready-made account setups. The [`test`](test) folder shows the session, UI
and conformance kit in use. The
[trading guide](https://docs.lumencharts.com/charting-library/trading) covers
connecting a broker to the chart.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report issues and how
releases are made.

## License

[Apache License 2.0](LICENSE). "Lumen Charts" is a trademark and is not covered
by the license.
