import { Side } from "../contracts/broker.js";
import { orderDisplayPrice, orderTypeName, sideName } from "../core/order-labels.js";
import type {
  BrokerCustomUI,
  IBrokerConnectionAdapterHost,
  Order,
  Position,
} from "../contracts/broker.js";
import { DialogCoordinator } from "../core/dialog-coordinator.js";
import { TradingError } from "../core/errors.js";

/** Reference wording: the symbol on one line, `Sell Stop 4 @ 341.09` on the next. */
function describeOrder(order: Readonly<Order>): string {
  const price = orderDisplayPrice(order);
  const suffix = price === undefined ? "" : ` @ ${price}`;
  return `${sideName(order.side)} ${orderTypeName(order.type) || "Order"} ${order.qty}${suffix}`;
}
type DialogHost = Pick<
  IBrokerConnectionAdapterHost,
  | "showOrderDialog"
  | "showCancelOrderDialog"
  | "showCancelMultipleOrdersDialog"
  | "showCancelBracketsDialog"
  | "showCancelMultipleBracketsDialog"
  | "showReversePositionDialog"
  | "showPositionBracketsDialog"
  | "showTradingProperties"
  | "showMessageDialog"
  | "showConfirmDialog"
  | "showSimpleConfirmDialog"
>;
export function createHostDialogs(
  dialogs: DialogCoordinator,
  custom: BrokerCustomUI | undefined,
  order: (id: string) => Readonly<Order> | undefined,
  position: (id: string) => Readonly<Position> | undefined,
  context: () => unknown = () => undefined,
  cancellingBothBracketsOnly: () => boolean = () => false,
  openSettings: () => boolean = () => false,
): DialogHost {
  const current = async <T>(work: () => Promise<T>): Promise<T> => {
    const captured = context();
    const value = await work();
    if (context() !== captured)
      throw TradingError.accountChanged();
    return value;
  };
  const confirm: IBrokerConnectionAdapterHost["showConfirmDialog"] = (
    title,
    content,
    mainButtonText,
    cancelButtonText,
    showDisableConfirmationsCheckbox,
  ) =>
    current(() =>
      dialogs.request({
        kind: "confirm",
        title,
        content,
        mainButtonText,
        cancelButtonText,
        showDisableConfirmationsCheckbox,
      }),
    );
  const cancel = async (
    id: string,
    handler: () => Promise<void>,
    brackets = false,
  ) => {
    const entity = order(id);
    if (!entity)
      throw new TradingError(
        "stale-context",
        "This order is no longer available.",
      );
    const protection =
      brackets || ("parentId" in entity && typeof entity.parentId === "string");
    const paired = protection && cancellingBothBracketsOnly();
    const description = describeOrder(entity);
    const content = paired
      ? [entity.symbol, description, "Its paired order will also be canceled."]
      : [entity.symbol, description];
    const approved = custom?.showCancelOrderDialog
      ? await current(() =>
          custom.showCancelOrderDialog!(structuredClone(entity) as Order),
        )
      : await current(() =>
          dialogs.request({
            kind: "confirm",
            title: protection ? "Cancel protection" : "Cancel order",
            content,
            mainButtonText: protection ? "Cancel protection" : "Cancel order",
            cancelButtonText: protection ? "Keep protection" : "Keep order",
            symbol: { name: entity.symbol, logo: "cancel" },
          }),
        );
    if (!approved) return;
    if (paired !== (protection && cancellingBothBracketsOnly()))
      throw new TradingError(
        "stale-context",
        "Cancellation changed. Review the order again.",
      );
    await handler();
  };
  return {
    showOrderDialog: (entity, focus) =>
      custom?.showOrderDialog
        ? current(() => custom.showOrderDialog!(structuredClone(entity), focus))
        : current(() =>
            dialogs.request({ kind: "order", order: entity, focus }),
          ),
    showPositionBracketsDialog: (entity, brackets, focus) =>
      custom?.showPositionDialog
        ? current(() =>
            custom.showPositionDialog!(
              structuredClone(entity),
              structuredClone(brackets),
              focus,
            ),
          )
        : current(() =>
            dialogs.request({
              kind: "position",
              position: entity,
              brackets,
              focus,
            }),
          ),
    showCancelOrderDialog: (id, handler) => cancel(id, handler),
    showCancelBracketsDialog: (id, handler) => cancel(id, handler, true),
    showCancelMultipleBracketsDialog: (id, handler) =>
      cancel(id, handler, true),
    showCancelMultipleOrdersDialog: async (symbol, side, qty, handler) => {
      if (
        await current(() =>
          dialogs.request({
            kind: "confirm",
            title: "Cancel orders",
            content: [
              symbol,
              `${side === Side.Buy ? "Buy" : "Sell"} orders, ${qty} in total`,
            ],
            mainButtonText: "Cancel orders",
            cancelButtonText: "Keep orders",
          }),
        )
      )
        await handler();
    },
    showReversePositionDialog: async (id, handler) => {
      const entity = position(id);
      if (!entity)
        throw new TradingError(
          "stale-context",
          "This position is no longer available.",
        );
      const approved = custom?.showReversePositionDialog
        ? await current(() =>
            custom.showReversePositionDialog!(
              structuredClone(entity) as Position,
            ),
          )
        : await current(() =>
            dialogs.request({
              kind: "confirm",
              title: "Reverse position",
              content: [
                entity.symbol,
                `${entity.side === Side.Buy ? "Long" : "Short"} ${entity.qty}`,
              ],
              mainButtonText: "Reverse position",
              cancelButtonText: "Keep position",
            }),
          );
      if (!approved) return false;
      return handler();
    },
    showTradingProperties: () => {
      // Chart hosts own trading settings as a page of their settings dialog.
      if (openSettings()) return;
      void dialogs.request({ kind: "properties" }).catch(() => {});
    },
    showMessageDialog: (title, content, html = false) => {
      void dialogs
        .request({ kind: "message", title, content, html })
        .catch(() => {});
    },
    showConfirmDialog: confirm,
    showSimpleConfirmDialog: confirm,
  };
}
