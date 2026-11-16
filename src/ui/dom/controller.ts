import {
  OrderStatus,
  OrderType,
  Side,
} from "../../contracts/broker.js";
import type {
  TradingChartBinding,
  TradingChartPort,
} from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { DisposalScope } from "../../core/disposal.js";
import { ValueStore } from "../../core/value-store.js";
import { valueReader } from "../../core/readers.js";
import { TradingError } from "../../core/errors.js";
import { equalData } from "../../core/immutable.js";
import { validateQuantity } from "../../core/trading-rules.js";
import { createDepthLadder } from "./ladder.js";
interface DomState {
  readonly phase: "loading" | "ready" | "error" | "disposed";
  readonly qty: number;
  readonly pending: boolean;
  readonly error?: string;
}
export function createDomController(
  session: TradingSession,
  chart: TradingChartPort,
) {
  const scope = new DisposalScope(),
    binding: TradingChartBinding = chart.binding.get(),
    context = session.commands.context();
  const state = new ValueStore<DomState>({
    phase: "loading",
    qty: 0,
    pending: false,
  });
  let ladder: ReturnType<typeof createDepthLadder> | undefined;
  let instrument: Awaited<ReturnType<typeof session.symbolInfo>> | undefined;
  let disposed = false;
  function assertCurrent(): void {
    if (disposed)
      throw TradingError.disposed("This depth panel is closed.");
    const connection = session.state.connection.get();
    if (
      connection.phase !== "ready" ||
      connection.generation !== context.generation ||
      connection.accountId !== context.accountId ||
      !equalData(binding, chart.binding.get())
    )
      throw new TradingError(
        "stale-context",
        "Review the current account and symbol.",
      );
    if (!session.symbolPolicy(binding.symbol).dom)
      throw new TradingError(
        "unsupported",
        "Market depth trading is unavailable.",
      );
  }
  const ready = (async () => {
    instrument = await session.symbolInfo(binding.symbol);
    assertCurrent();
    const qty = await session.host.getQty(binding.symbol);
    assertCurrent();
    ladder = createDepthLadder(
      instrument.minTick,
      31,
      session.features.static_dom,
    );
    scope.own(() => ladder?.destroy());
    scope.own(
      session.acquireDepth(binding.symbol, (data) => ladder!.apply(data)),
    );
    scope.own(
      session.acquireQuotes(binding.symbol, "fast", (data) => {
        if (data.value?.trade !== undefined)
          ladder!.lastPrice(data.value.trade);
        else if (data.value?.bid !== undefined && data.value.ask !== undefined)
          ladder!.lastPrice((data.value.bid + data.value.ask) / 2);
      }),
    );
    const ownOrders = new Map<string, { side: Side; price: number }>();
    const applyOrder = (id: string) => {
      const order = session.state.orders.get(id),
        previous = ownOrders.get(id);
      if (previous) ladder!.order(id, previous.side, previous.price, 0);
      ownOrders.delete(id);
      if (
        !order ||
        order.symbol !== binding.symbol ||
        order.type !== OrderType.Limit ||
        order.limitPrice === undefined ||
        [
          OrderStatus.Canceled,
          OrderStatus.Filled,
          OrderStatus.Rejected,
        ].includes(order.status)
      )
        return;
      ownOrders.set(id, { side: order.side, price: order.limitPrice });
      ladder!.order(
        id,
        order.side,
        order.limitPrice,
        order.qty - (order.filledQty ?? 0),
      );
    };
    for (const id of session.state.orders.ids()) applyOrder(id);
    scope.own(
      session.state.orders.subscribeChanges((change) => {
        for (const id of [
          ...change.added,
          ...change.updated,
          ...change.removed,
        ])
          applyOrder(id);
      }),
    );
    state.set({ phase: "ready", qty, pending: false });
  })().catch((cause) => {
    if (!disposed) {
      state.set({
        ...state.get(),
        phase: "error",
        error:
          cause instanceof Error
            ? cause.message
            : "Market depth is unavailable.",
      });
      scope.destroy();
    }
    throw cause;
  });
  void ready.catch(() => {});
  async function action(work: () => Promise<unknown>): Promise<void> {
    assertCurrent();
    if (state.get().pending)
      throw new TradingError(
        "operation-pending",
        "Wait for the current action.",
      );
    state.set({ ...state.get(), pending: true, error: undefined });
    try {
      await work();
    } catch (cause) {
      if (!disposed)
        state.set({
          ...state.get(),
          error:
            cause instanceof Error
              ? cause.message
              : "The action could not be completed.",
        });
      throw cause;
    } finally {
      if (!disposed) state.set({ ...state.get(), pending: false });
    }
  }
  return {
    state: valueReader(state),
    ready,
    get ladder() {
      return ladder;
    },
    binding,
    quantity(qty: number): void {
      assertCurrent();
      if (!instrument)
        throw new TradingError(
          "configuration",
          "Quantity information is loading.",
        );
      validateQuantity(qty, instrument.qty);
      session.host.setQty(binding.symbol, qty);
      state.set({ ...state.get(), qty });
    },
    order(side: Side, key?: number): Promise<void> {
      return action(async () => {
        if (!instrument)
          throw new TradingError(
            "configuration",
            "Quantity information is loading.",
          );
        const target = key === undefined ? undefined : ladder!.beginAction(key);
        try {
          const order = {
            symbol: binding.symbol,
            side,
            type: target ? OrderType.Limit : OrderType.Market,
            qty: state.get().qty,
            ...(target ? { limitPrice: target.price } : {}),
          };
          await session.commands.validate({ context, order });
          assertCurrent();
          // The ticket/custom form owns confirmation, preview and dispatch.
          await session.showOrderTicket(binding, order);
        } finally {
          target?.release();
        }
      });
    },
    cancel(side?: Side): Promise<void> {
      return action(async () => {
        const orders = session.state.orders.ids().flatMap((id) => {
          const order = session.state.orders.get(id)!;
          if (
            order.symbol !== binding.symbol ||
            (side !== undefined && order.side !== side) ||
            [
              OrderStatus.Canceled,
              OrderStatus.Filled,
              OrderStatus.Rejected,
            ].includes(order.status)
          )
            return [];
          return [{ id, revision: session.state.orders.revision(id) }];
        });
        if (!orders.length) return;
        if (
          !(await session.host.showConfirmDialog(
            "Cancel orders",
            [binding.symbol, `${orders.length} pending orders`],
            "Cancel orders",
            "Keep orders",
          ))
        )
          return;
        assertCurrent();
        const results = await session.commands.cancelMany({
          context,
          symbol: binding.symbol,
          side,
          orders,
        });
        if (
          results.some(
            (result) => result.error || result.result?.outcome !== "confirmed",
          )
        )
          throw new TradingError(
            "broker-unavailable",
            "Some orders could not be confirmed as canceled. Review your orders.",
          );
      });
    },
    reverse(id: string): Promise<void> {
      return action(async () => {
        const position = session.state.positions.get(id);
        if (position?.symbol !== binding.symbol)
          throw new TradingError(
            "stale-context",
            "Choose a current position for this symbol.",
          );
        const request = {
          id,
          context: session.commands.context(id, "position"),
        };
        await session.host.showReversePositionDialog(id, async () => {
          assertCurrent();
          const result = await session.commands.reverse(request);
          return result.outcome === "confirmed";
        });
      });
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      state.set({ ...state.get(), phase: "disposed" });
      scope.destroy();
      state.destroy();
    },
  };
}
export type DomController = ReturnType<typeof createDomController>;
