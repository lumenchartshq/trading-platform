import { OrderStatus, OrderType, Side } from "../contracts/broker.js";
import type {
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  Order,
  SingleBrokerMetaInfo,
} from "../contracts/broker.js";
import type {
  LumenBrokerExtensions,
  TradingBrokerProfile,
  TradingClock,
  TradingFormatterPort,
  TradingMarketDataPort,
} from "../contracts/ports.js";
import { createTradingSession, type TradingSession } from "../core/session.js";
import type { CapabilityFlags } from "../core/capabilities.js";
import { instrumentPointValue } from "../core/financial-rules.js";
import { followCommand, type CommandFollowState } from "../core/command-follow.js";

export { createReplayBroker, recordBroker, type BrokerTranscript, type TranscriptEvent } from "./replay.js";

/** Drives the adapter's market and failure paths; every control is optional and its scenarios skip without it. */
export interface ConformanceControls {
  /** Sets the executable price of a symbol. */
  quote?(symbol: string, price: number): void;
  /** Fills a working order (when the adapter does not fill market orders by itself). */
  fill?(orderId: string): void;
  disconnect?(): void;
  reconnect?(): void;
  /** The next mutation is rejected by the broker. */
  rejectNext?(message: string): void;
  /**
   * The broker accepts the next write, but its reads and streams do not show the result until the returned release
   * is called: an acknowledged write whose result appears late.
   */
  holdNextWrite?(): () => void;
  /** The broker applies the next write, but its reply never reaches the adapter (the connection drops on the way back). */
  loseNextReply?(): void;
}
/** One fresh adapter per scenario. */
export interface ConformanceSetup {
  readonly brokerFactory: (host: IBrokerConnectionAdapterHost) => IBrokerTerminal;
  readonly brokerConfig?: SingleBrokerMetaInfo;
  readonly extensions?: LumenBrokerExtensions;
  readonly marketData: TradingMarketDataPort;
  /** The session clock; `advance` moves it for deadlines (a manual clock in tests). */
  readonly clock?: TradingClock & { advance?(milliseconds: number): void };
  /** A tradable symbol, its current price and a valid order quantity. */
  readonly symbol: string;
  readonly price: number;
  readonly qty: number;
  readonly controls?: ConformanceControls;
  /** The adapter rejects with the `BrokerRejection` shape; O02 then requires the broker's message to reach the user. */
  readonly rejectsWithBrokerRejection?: boolean;
  /**
   * What the adapter declares about itself. A declared behaviour turns the matching scenarios from optional into
   * required: their missing controls fail instead of skipping.
   */
  readonly profile?: TradingBrokerProfile;
  destroy?(): void;
}
export interface ConformanceOptions {
  readonly name: string;
  setup(): ConformanceSetup | Promise<ConformanceSetup>;
  /** Scenario IDs to run; default: all. */
  readonly scenarios?: readonly string[];
  /** Real milliseconds to wait for an asynchronous adapter (default 2,000). */
  readonly timeout?: number;
}
export type ConformanceStatus = "pass" | "fail" | "skip";
export interface ConformanceResult {
  readonly id: string;
  readonly title: string;
  readonly status: ConformanceStatus;
  /** Why it failed or was skipped. */
  readonly reason?: string;
  /** Broker calls and outcomes observed. */
  readonly evidence: readonly string[];
}
export interface ConformanceReport {
  readonly name: string;
  readonly results: readonly ConformanceResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

class Skip extends Error {}
interface ScenarioContext {
  readonly session: TradingSession;
  readonly setup: ConformanceSetup;
  readonly flags: CapabilityFlags;
  readonly calls: string[];
  readonly evidence: string[];
  /** Connection phases and broker calls observed before `ready` resolved. */
  readonly startup: { readonly phases: readonly string[]; readonly callsBeforeReady: readonly string[] };
  until(predicate: () => boolean, what: string): Promise<void>;
  /** Waits for a command, moving the session clock so its confirmation deadline can pass. */
  settle<T>(work: Promise<T>): Promise<T>;
  skip(reason: string): never;
}
interface Scenario {
  readonly id: string;
  readonly title: string;
  run(context: ScenarioContext): Promise<void>;
}
const formatters: TradingFormatterPort = {
  defaultPrice: async () => ({ format: (value: number) => String(value) }),
  numeric: async () => ({ format: (value: number) => String(value) }),
  quantity: async () => ({ format: (value: number) => String(value) }),
  createPriceFormatter: () => ({ format: (value: number) => String(value) }),
};
const settings = () => {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => void values.set(key, value),
    remove: (key: string) => void values.delete(key),
  };
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
/** A limit order the market will not reach. */
function restingLimit(setup: ConformanceSetup, side = Side.Buy) {
  const away = setup.price * (side === Side.Buy ? 0.8 : 1.2);
  return { symbol: setup.symbol, side, type: OrderType.Limit, qty: setup.qty, limitPrice: Number(away.toFixed(2)) };
}
/**
 * Waits up to `grace` real milliseconds in small clock steps, so an adapter that can confirm does, then moves the
 * session clock one second at a time until `work` settles or `limit` simulated milliseconds pass. The deadline can
 * expire without also ending its reconciliation window.
 */
async function outlast<T>(setup: ConformanceSetup, work: Promise<T>, limit: number, grace: number): Promise<T> {
  let done = false;
  const tracked = work.finally(() => (done = true));
  tracked.catch(() => {});
  for (const started = Date.now(); !done && Date.now() - started < grace; ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!done) setup.clock!.advance!(5);
  }
  for (let elapsed = 0; !done && elapsed < limit; elapsed += 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!done) setup.clock!.advance!(1000);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (!done) throw new Error(`the command did not settle within ${limit / 1000} simulated seconds`);
  return tracked;
}
/** Resolves with the command's first final state: confirmed, changed, rejected or unresolved. */
function finalState(session: TradingSession, commandId: string): Promise<CommandFollowState> {
  return new Promise((resolve) => {
    followCommand(session.pending, commandId, (state) => {
      if (state.kind !== "checking") resolve(state);
    });
  });
}
const workingOrders = (session: TradingSession, symbol: string) =>
  session.state.orders
    .ids()
    .map((id) => session.state.orders.get(id)!)
    .filter((order) => order.symbol === symbol && order.status === OrderStatus.Working && !("parentId" in order && order.parentId));

const scenarios: readonly Scenario[] = [
  {
    id: "A01",
    title: "Connected startup calls the factory once and hydrates before ready",
    async run({ session, startup }) {
      const { phases, callsBeforeReady } = startup;
      check(callsBeforeReady.filter((call) => call === "factory").length === 1, "one broker factory call");
      check(phases.indexOf("hydrating") >= 0 && phases.indexOf("hydrating") < phases.lastIndexOf("ready"), `hydrating before ready (saw ${phases.join(" → ")})`);
      for (const read of ["accountsMetainfo", "orders"])
        check(callsBeforeReady.includes(read), `${read} was read before ready`);
      check(!!session.state.connection.get().accountId, "the current account is known");
    },
  },
  {
    id: "A02",
    title: "Disconnect disables commands; reconnect re-reads before ready",
    async run({ session, setup, until, skip, evidence, settle }) {
      const disconnect = setup.controls?.disconnect, reconnect = setup.controls?.reconnect;
      if (!disconnect || !reconnect) return skip("no disconnect/reconnect controls");
      const context = session.commands.context();
      disconnect();
      await until(() => session.state.connection.get().phase === "disconnected", "disconnected phase");
      let code: string | undefined;
      await settle(session.commands.place({ context, order: restingLimit(setup) })).catch((error) => (code = error.code));
      check(code === "disconnected", `commands reject while disconnected (got ${code})`);
      reconnect();
      await until(() => session.state.connection.get().phase === "ready", "ready after reconnect");
      evidence.push("reconnected");
    },
  },
  {
    id: "A04",
    title: "Repeated refreshes coalesce and leave the snapshot stable",
    async run({ session }) {
      const before = session.state.orders.ids().length;
      await Promise.all([session.refresh(), session.refresh(), session.refresh()]);
      check(session.state.connection.get().phase === "ready", "ready after refreshes");
      check(session.state.orders.ids().length === before, "orders unchanged by refreshing");
    },
  },
  {
    id: "O01",
    title: "Place a resting limit order: one broker call, confirmed by a Working order",
    async run({ session, setup, calls, evidence, settle }) {
      const before = calls.filter((call) => call === "placeOrder").length;
      const result = await settle(session.commands.place({ context: session.commands.context(), order: restingLimit(setup) }));
      evidence.push(`outcome ${result.outcome}`);
      check(result.outcome === "confirmed", `confirmed (got ${result.outcome})`);
      check(calls.filter((call) => call === "placeOrder").length === before + 1, "exactly one placeOrder call");
      const order = session.state.orders.get(result.entityIds[0]!);
      check(order?.status === OrderStatus.Working, "the order is Working");
      check(order.symbol === setup.symbol && order.qty === setup.qty, "symbol and quantity match");
    },
  },
  {
    id: "O02",
    title: "A rejected placement fails with the broker's reason and leaves no row",
    async run({ session, setup, skip, settle, evidence }) {
      const rejectNext = setup.controls?.rejectNext;
      if (!rejectNext) return skip("no rejection control");
      const before = workingOrders(session, setup.symbol).length;
      const reason = "Rejected by conformance";
      rejectNext(reason);
      let code: string | undefined, message: string | undefined;
      await settle(session.commands.place({ context: session.commands.context(), order: restingLimit(setup) })).catch(
        (error) => ((code = error.code), (message = error.message)),
      );
      check(code === "broker-rejected", `broker-rejected (got ${code})`);
      if (setup.rejectsWithBrokerRejection) check(message === reason, `the broker's message reaches the user (got ${message})`);
      else evidence.push("message not checked: the adapter does not declare BrokerRejection");
      check(workingOrders(session, setup.symbol).length === before, "no new working order");
    },
  },
  {
    id: "O05",
    title: "Modify a working order's price and see the broker's update",
    async run({ session, setup, flags, skip, settle }) {
      if (!flags.supportModifyOrderPrice) skip("supportModifyOrderPrice is off");
      const placed = await settle(session.commands.place({ context: session.commands.context(), order: restingLimit(setup) }));
      const id = placed.entityIds[0]!;
      const order = session.state.orders.get(id)!;
      const limitPrice = Number((order.limitPrice! * 0.99).toFixed(2));
      const result = await settle(
        session.commands.modify({ context: session.commands.context(id, "order"), order: { ...order, limitPrice } as Order }),
      );
      check(result.outcome === "confirmed", `confirmed (got ${result.outcome})`);
      check(session.state.orders.get(id)?.limitPrice === limitPrice, "the new price is shown");
    },
  },
  {
    id: "O07",
    title: "Cancel a working order: confirmed by Canceled",
    async run({ session, setup, settle }) {
      const placed = await settle(session.commands.place({ context: session.commands.context(), order: restingLimit(setup) }));
      const id = placed.entityIds[0]!;
      const result = await settle(session.commands.cancel({ context: session.commands.context(id, "order"), id }));
      check(result.outcome === "confirmed", `confirmed (got ${result.outcome})`);
      const order = session.state.orders.get(id) ?? session.state.history.get(id);
      check(!order || order.status === OrderStatus.Canceled, "the order is Canceled or gone");
    },
  },
  {
    id: "B01",
    title: "A limit order with take profit and stop loss keeps its protection",
    async run({ session, setup, flags, skip, until, settle }) {
      if (!flags.supportOrderBrackets) skip("supportOrderBrackets is off");
      const draft = restingLimit(setup);
      const takeProfit = Number((draft.limitPrice * 1.05).toFixed(2));
      const stopLoss = Number((draft.limitPrice * 0.95).toFixed(2));
      const placed = await settle(
        session.commands.place({ context: session.commands.context(), order: { ...draft, takeProfit, stopLoss } }),
      );
      const id = placed.entityIds[0]!;
      const children = () =>
        session.state.orders
          .ids()
          .map((child) => session.state.orders.get(child)!)
          .filter((child) => "parentId" in child && child.parentId === id);
      await until(() => {
        const order = session.state.orders.get(id);
        return order?.takeProfit === takeProfit || children().length > 0;
      }, "protection on the order or as child orders");
    },
  },
  {
    id: "C01",
    title: "A filled market order opens a position that closes completely",
    async run({ session, setup, flags, skip, until, settle }) {
      if (!flags.supportPositions) skip("supportPositions is off");
      if (!flags.supportMarketOrders) skip("supportMarketOrders is off");
      const position = () =>
        session.state.positions
          .ids()
          .map((id) => session.state.positions.get(id)!)
          .find((value) => value.symbol === setup.symbol);
      const existing = position()?.qty ?? 0;
      const placed = await settle(
        session.commands.place({
          context: session.commands.context(),
          order: { symbol: setup.symbol, side: Side.Buy, type: OrderType.Market, qty: setup.qty },
        }),
      ).catch(() => undefined);
      const id = placed?.entityIds[0];
      if (!position() || position()!.qty === existing) {
        const fill = setup.controls?.fill;
        if (!fill || !id) return skip("the adapter did not fill and there is no fill control");
        fill(id);
      }
      await until(() => (position()?.qty ?? 0) !== existing, "a position change after the fill");
      const open = position()!;
      const result = await settle(
        session.commands.close({ id: open.id, context: session.commands.context(open.id, "position") }),
      );
      check(result.outcome !== "unconfirmed", `close settled (got ${result.outcome})`);
      await until(() => !position(), "the position closed");
    },
  },
  {
    id: "P02",
    title: "Money P&L in the instrument currency has the contract's point value",
    async run({ session, setup, flags, skip, evidence }) {
      if (!flags.positionPLInInstrumentCurrency) return skip("positionPLInInstrumentCurrency is off; money P&L uses account-currency pip values");
      const point = instrumentPointValue(await session.symbolInfo(setup.symbol));
      check(point !== undefined, `${setup.symbol} declares bigPointValue (or lotSize), so chart P&L can be estimated`);
      evidence.push(`point value ${point}`);
    },
  },
  {
    id: "R01",
    title: "A write the broker shows late is followed to confirmation, never resent, and blocks a repeat meanwhile",
    async run({ session, setup, calls, skip, evidence }) {
      const hold = setup.controls?.holdNextWrite;
      if (!hold) {
        check(setup.profile?.confirmation !== "eventual", "the profile declares eventual confirmation, so it must provide holdNextWrite");
        return skip("no holdNextWrite control");
      }
      if (!setup.clock?.advance) return skip("no manual session clock");
      const before = workingOrders(session, setup.symbol).length;
      const sent = calls.filter((call) => call === "placeOrder").length;
      const release = hold();
      const order = restingLimit(setup);
      const result = await outlast(setup, session.commands.place({ context: session.commands.context(), order }), 15000, 1000);
      evidence.push(`outcome ${result.outcome}`);
      check(result.outcome === "unconfirmed", `a held write is not confirmed before the broker shows it (got ${result.outcome}); check that holdNextWrite hides the write`);
      const settled = finalState(session, result.commandId);
      let code: string | undefined;
      await session.commands.place({ context: session.commands.context(), order }).catch((error) => (code = error.code));
      check(code === "operation-pending", `a repeat is refused while the first is checked (got ${code ?? "accepted"})`);
      release();
      const state = await Promise.race([
        settled,
        new Promise<undefined>((resolve) => setTimeout(resolve, 3000)),
      ]);
      evidence.push(`followed to ${state?.kind ?? "nothing"}`);
      check(state?.kind === "confirmed", `the released write is confirmed (got ${state?.kind ?? "no final state"})`);
      check(calls.filter((call) => call === "placeOrder").length === sent + 1, "exactly one placeOrder call");
      check(workingOrders(session, setup.symbol).length === before + 1, "exactly one new working order");
    },
  },
  {
    id: "R02",
    title: "A write whose reply was lost is confirmed from broker state and creates one order",
    async run({ session, setup, calls, skip, until, settle, evidence }) {
      const lose = setup.controls?.loseNextReply;
      if (!lose) {
        check(setup.profile?.clientOrderIds !== true, "the profile declares client order IDs, so it must provide loseNextReply");
        return skip("no loseNextReply control");
      }
      const before = workingOrders(session, setup.symbol).length;
      const sent = calls.filter((call) => call === "placeOrder").length;
      lose();
      const result = await settle(session.commands.place({ context: session.commands.context(), order: restingLimit(setup) }));
      evidence.push(`outcome ${result.outcome}`);
      const state = result.outcome === "unconfirmed" ? await finalState(session, result.commandId) : undefined;
      check(result.outcome === "confirmed" || state?.kind === "confirmed",
        `confirmed from broker state (got ${result.outcome}${state ? ` then ${state.kind}` : ""})`);
      await until(() => workingOrders(session, setup.symbol).length >= before + 1, "the order is shown");
      check(calls.filter((call) => call === "placeOrder").length === sent + 1, "exactly one placeOrder call");
      check(workingOrders(session, setup.symbol).length === before + 1, "exactly one new working order");
    },
  },
  {
    id: "A05",
    title: "Destroy settles pending work and makes retained host callbacks inert",
    async run({ session, setup, settle }) {
      const pending = session.commands.place({ context: session.commands.context(), order: restingLimit(setup) });
      session.destroy();
      const settled = await settle(pending).then(
        () => "resolved",
        (error) => error.code,
      );
      check(settled === "disposed" || settled === "resolved", `pending command settles (got ${settled})`);
      check(session.state.connection.get().phase === "disposed", "disposed phase");
    },
  },
];

/** IDs of the scenarios the kit runs. */
export const conformanceScenarios: readonly string[] = scenarios.map((scenario) => scenario.id);

/**
 * Runs the acceptance scenarios against an adapter through a real trading session. Each scenario gets a fresh
 * adapter from `setup()`; scenarios whose capability flag is off or whose control is missing are skipped
 * explicitly, never passed.
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const selected = scenarios.filter((scenario) => !options.scenarios || options.scenarios.includes(scenario.id));
  const timeout = options.timeout ?? 2000;
  const results: ConformanceResult[] = [];
  for (const scenario of selected) {
    const setup = await options.setup();
    const calls: string[] = [];
    const evidence: string[] = [];
    let session: TradingSession | undefined;
    try {
      session = createTradingSession({
        brokerConfig: setup.brokerConfig,
        extensions: setup.extensions,
        marketData: setup.marketData,
        clock: setup.clock,
        formatters,
        settings: settings(),
        brokerFactory: (host) => {
          calls.push("factory");
          return observe(setup.brokerFactory(host), calls);
        },
      });
      const phases: string[] = [session.state.connection.get().phase];
      const releasePhases = session.state.connection.subscribe((value) => {
        if (phases[phases.length - 1] !== value.phase) phases.push(value.phase);
      });
      await session.ready;
      releasePhases();
      const startup = { phases, callsBeforeReady: [...calls] };
      const live = session;
      const context: ScenarioContext = {
        session: live,
        setup,
        flags: live.policy.get().flags,
        calls,
        evidence,
        startup,
        skip(reason: string): never {
          throw new Skip(reason);
        },
        async settle(work) {
          let done = false;
          const tracked = work.finally(() => (done = true));
          tracked.catch(() => {});
          const started = Date.now();
          let forced = false;
          while (!done) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (done) break;
            if (Date.now() - started > timeout) {
              if (forced) throw new Error("a command never settled");
              // Past the real wait: let every session deadline fire once.
              setup.clock?.advance?.(60000);
              forced = true;
            } else setup.clock?.advance?.(5);
          }
          return tracked;
        },
        async until(predicate, what) {
          const started = Date.now();
          while (!predicate()) {
            if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            setup.clock?.advance?.(5);
          }
        },
      };
      await scenario.run(context);
      results.push({ id: scenario.id, title: scenario.title, status: "pass", evidence: [...evidence, ...summary(calls)] });
    } catch (cause) {
      const skipped = cause instanceof Skip;
      results.push({
        id: scenario.id,
        title: scenario.title,
        status: skipped ? "skip" : "fail",
        reason: cause instanceof Error ? cause.message : String(cause),
        evidence: [...evidence, ...summary(calls)],
      });
    } finally {
      session?.destroy();
      setup.destroy?.();
    }
  }
  return {
    name: options.name,
    results,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "fail").length,
    skipped: results.filter((result) => result.status === "skip").length,
  };
}
/** Records broker method names without changing behaviour. */
function observe(broker: IBrokerTerminal, calls: string[]): IBrokerTerminal {
  return new Proxy(broker, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        calls.push(property);
        return value.apply(target, args);
      };
    },
  });
}
function summary(calls: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1);
  return [...counts].filter(([name]) => /^(factory|placeOrder|modifyOrder|cancelOrder|closePosition)$/.test(name)).map(([name, count]) => `${name} ×${count}`);
}
