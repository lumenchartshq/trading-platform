import { placesOrdersWithoutTicket, editsPositionsWithoutDialog } from "../core/review-policy.js";
import { protectionFields } from "../core/parent-protection.js";
import { OrderType, OrderTicketFocusControl } from "../contracts/broker.js";
import type { Order, PreOrder } from "../contracts/broker.js";
import type { TradingChartBinding, ChartTradeIntent, TradingCollectionPort } from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
import type { OverlayAction } from "../chart/overlay-coordinator.js";
import { entityEntryPrice } from "../core/financial-rules.js";
import { sameBinding, sameAccountGeneration } from "../core/identity.js";
import { withDefaultDuration } from "../core/order-duration.js";
import { TradingError } from "../core/errors.js";

/** Route chart and account actions through the same captured command/dialog paths. */
export function createChartActions(
  session: TradingSession,
  collection: TradingCollectionPort,
  open: (binding: TradingChartBinding, template?: Partial<PreOrder> | Order, initiator?: HTMLElement) => Promise<void>,
) {
  function bindingFor(symbol: string): TradingChartBinding {
    return (
      collection
        .charts()
        .find((chart) => chart.binding.get().symbol === symbol)
        ?.binding.get() ?? { id: "unbound-ticket", generation: 0, symbol }
    );
  }
  let placing = false;
  async function intent(value: ChartTradeIntent): Promise<void> {
    if (
      (value.type === "priceOrder" || value.type === "openTicket") &&
      value.account &&
      !sameAccountGeneration(value.account, session.state.connection.get())
    )
      return;
    if (value.type === "priceOrder") {
      if (placing) return;
      const context = session.commands.context();
      const live = () =>
        sameAccountGeneration(context, session.state.connection.get()) &&
        collection
          .charts()
          .some(
            (chart) =>
              sameBinding(chart.binding.get(), value.binding) && chart.binding.get().symbol === value.binding.symbol,
          );
      if (!live()) return;
      if (!placesOrdersWithoutTicket(session)) {
        await intent({ ...value, type: "openTicket" });
        return;
      }
      placing = true;
      try {
        const [qty, instrument] = await Promise.all([
          session.host.getQty(value.binding.symbol),
          session.symbolInfo(value.binding.symbol),
        ]);
        if (!live()) return;
        const flags = session.symbolPolicy(value.binding.symbol).flags;
        if (flags.supportPlaceOrderPreview && session.ticketSettings.get().showOrderPreview) {
          await intent({ ...value, type: "openTicket" });
          return;
        }
        const type = value.orderType ?? OrderType.Limit;
        const order = withDefaultDuration(
          {
            symbol: value.binding.symbol,
            side: value.side,
            type,
            qty,
            ...(type === OrderType.Stop ? { stopPrice: value.price } : { limitPrice: value.price }),
          },
          session.symbolPolicy(value.binding.symbol),
          instrument,
        );
        await session.commands.place({ context, order });
      } finally {
        placing = false;
      }
      return;
    }
    if (value.type === "openTicket") {
      const type = value.orderType ?? (value.price === undefined ? OrderType.Market : OrderType.Limit);
      await open(value.binding, {
        side: value.side,
        type,
        ...(type === OrderType.Stop ? { stopPrice: value.price } : { limitPrice: value.price }),
      });
      return;
    }
    if (value.type === "modifyOrder") {
      const order = session.state.orders.get(value.entityId);
      if (order) open(value.binding, order);
      return;
    }
    if (value.type === "cancelOrder") {
      const context = session.commands.context(value.entityId);
      await session.host.showCancelOrderDialog(value.entityId, async () => {
        await session.commands.cancel({ context, id: value.entityId });
      });
      return;
    }
    if (value.type === "closePosition") {
      await session.requestClose({
        id: value.entityId,
        context: session.commands.context(value.entityId, "position"),
      });
      return;
    }
    if (value.type === "reversePosition") {
      const context = session.commands.context(value.entityId, "position");
      await session.host.showReversePositionDialog(value.entityId, async () => {
        const result = await session.commands.reverse({
          id: value.entityId,
          context,
        });
        if (result.outcome !== "confirmed")
          throw new TradingError("broker-unavailable", "Reversal is unconfirmed. Refresh to check the position.");
        return true;
      });
      return;
    }
    if (value.type !== "editProtection") return;
    if (value.entityKind === "order") {
      const order = session.state.orders.get(value.entityId);
      if (order) open(value.binding, order);
      return;
    }
    const entity =
      value.entityKind === "individualPosition"
        ? session.state.individualPositions.get(value.entityId)
        : session.state.positions.get(value.entityId);
    if (entity)
      await session.host.showPositionBracketsDialog(
        structuredClone(entity),
        protectionFields(entity),
        OrderTicketFocusControl.TakeProfit,
      );
  }
  async function overlayAction(action: OverlayAction): Promise<void> {
    const { event, binding, entityId, kind } = action;
    if (event.type === "dragCommit" && session.chartEdits && kind !== "execution") {
      const edit = session.chartEdits.state.get();
      if (!edit || edit.id !== entityId || edit.kind !== kind || edit.context.revision !== action.revision)
        throw new TradingError("stale-context", "This trade changed. Review its latest details.");
      let levels;
      if (edit.multiple && event.leg) {
        const instrument = await session.symbolInfo(edit.order.symbol);
        const options =
          kind === "order"
            ? await session.orderDialogOptions(edit.order.symbol)
            : await session.positionDialogOptions(edit.order.symbol);
        if (session.chartEdits.state.get()?.token !== edit.token)
          throw new TradingError("stale-context", "This trade changed. Review its latest details.");
        const entry = entityEntryPrice(kind, edit.order);
        if (entry === undefined) throw new TradingError("invalid-input", "The entry price is unavailable.");
        levels = { entry, instrument, maximum: options?.maxExitLevelsCount };
      }
      const proposed = session.chartEdits.propose(event.price, levels);
      try {
        if (kind === "order") {
          const policy = session.symbolPolicy(proposed.order.symbol);
          const immediate =
            placesOrdersWithoutTicket(session) &&
            !(policy.flags.supportModifyOrderPreview && session.ticketSettings.get().showOrderPreview);
          if (immediate) await session.commands.modify({ context: proposed.context, order: proposed.order as Order });
          else await open(binding, proposed.order as Order);
        } else {
          const brackets = protectionFields(proposed.order);
          if (editsPositionsWithoutDialog(session))
            await session.commands.editProtection({
              id: entityId,
              context: proposed.context,
              individual: kind === "individualPosition",
              brackets,
            });
          else
            await session.host.showPositionBracketsDialog(
              structuredClone(proposed.order) as Parameters<typeof session.host.showPositionBracketsDialog>[0],
              brackets,
              event.leg === "takeProfit" ? OrderTicketFocusControl.TakeProfit : OrderTicketFocusControl.StopLoss,
            );
        }
      } finally {
        session.chartEdits.clearIf(proposed.token);
      }
      return;
    }
    if (event.type === "dragCommit") {
      const order = session.state.orders.get(entityId);
      if (!order) return;
      const context = {
        ...session.commands.context(entityId),
        revision: action.revision,
      };
      const price = order.type === OrderType.Limit ? { limitPrice: event.price } : { stopPrice: event.price };
      if (await session.host.showConfirmDialog("Change order price?", `${order.symbol} · ${event.price}`))
        await session.commands.modify({
          context,
          order: { ...order, ...price },
        });
      return;
    }
    if (event.type === "protect" || (event.type === "modify" && kind !== "order")) {
      await intent({
        type: "editProtection",
        binding,
        entityId,
        entityKind: kind === "individualPosition" ? "individualPosition" : "position",
      });
      return;
    }
    if (event.type === "cancel") await intent({ type: "cancelOrder", binding, entityId });
    else if (event.type === "modify") await intent({ type: "modifyOrder", binding, entityId });
    else if (event.type === "close") await intent({ type: "closePosition", binding, entityId });
    else if (event.type === "reverse") await intent({ type: "reversePosition", binding, entityId });
  }
  async function positionAction(
    id: string,
    individual: boolean,
    action: "close" | "reverse" | "protect",
  ): Promise<void> {
    const position = (individual ? session.state.individualPositions : session.state.positions).get(id);
    if (!position) return;
    if (action === "close") {
      const result = await session.requestClose({
        id,
        individual,
        context: session.commands.context(id, individual ? "individualPosition" : "position"),
      });
      if (result && result.outcome !== "confirmed")
        throw new TradingError("broker-unavailable", "Closing is unconfirmed. Refresh to check the position.");
      return;
    }
    await intent({
      type: action === "reverse" ? "reversePosition" : "editProtection",
      binding: bindingFor(position.symbol),
      entityId: id,
      entityKind: individual ? "individualPosition" : "position",
    });
  }
  return { bindingFor, intent, overlayAction, positionAction };
}
