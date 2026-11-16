import type { InstrumentInfo, Order, Side } from "../contracts/broker.js";
import type { TradingProtectionLeg, TradingProtectionView } from "../contracts/ports.js";
import type { ChartOrderEdit } from "../core/chart-order-edit.js";
import { chartExitLevelId } from "../core/chart-order-edit.js";
import { minimumExitQuantity } from "../core/exit-level-draft.js";
import { entityEntryPrice, oppositeSide, orderEntryPrice } from "../core/financial-rules.js";

/** A proposed price for one protection leg, or for the entry line when `leg` is omitted. */
export interface EditPreviewPoint {
  readonly price: number;
  readonly leg?: TradingProtectionLeg;
}

/** Where a saved (reviewing or sending) proposal sits: its proposed exit, or the moved order entry. */
export function proposedEditPoint(edit: Readonly<ChartOrderEdit>): EditPreviewPoint | undefined {
  if (edit.leg) {
    const levelId = edit.level ?? chartExitLevelId(edit.token);
    const allocated = edit.order.exitLevels?.find((level) => level.id === levelId);
    const price = allocated?.[edit.leg] ?? edit.order[edit.leg];
    return typeof price === "number" ? { price, leg: edit.leg } : undefined;
  }
  const price = edit.kind === "order" ? orderEntryPrice(edit.order as Order) : undefined;
  return price === undefined ? undefined : { price };
}

export interface EditPreviewInput {
  readonly edit: Readonly<ChartOrderEdit>;
  /** Protection the line is projected with (handles, entry, moving leg for exit lines). */
  readonly protection: TradingProtectionView | undefined;
  readonly point: EditPreviewPoint;
  readonly instrument: InstrumentInfo;
  /** Price a position's exits must sit around (its current closing price); orders use their entry. */
  readonly reference?: number;
  /** Estimated result text of closing `qty` of `side` exposure from `entry` at `exit`. */
  readonly profitText: (side: Side, qty: number, entry: number | undefined, exit: number) => string;
}

/**
 * Protection shown while a TP/SL (or an exit line itself) is dragged or reviewed: the moving leg's price,
 * amount, quantity and whether the price is on the profitable/protective side of entry.
 */
export function editPreviewProtection(input: EditPreviewInput): TradingProtectionView | undefined {
  const { edit, protection, point, instrument } = input;
  const leg = point.leg ?? protection?.movingLeg;
  if (!leg) return undefined;
  const entity = edit.order;
  const hasExits = !!entity.exitLevels?.length || entity.takeProfit !== undefined || entity.stopLoss !== undefined;
  // A moved level closes its own allocation; a new allocated level starts at the smallest quantity;
  // otherwise the exit closes the whole entity.
  const level = edit.level !== undefined ? entity.exitLevels?.find((value) => value.id === edit.level) : undefined;
  let quantity = entity.qty;
  if (level) quantity = level.qty;
  else if (edit.multiple && hasExits) quantity = minimumExitQuantity(instrument.qty);
  let entry = entityEntryPrice(edit.kind, entity);
  let side = entity.side;
  // An exit line dragged by its body measures from its parent's entry, closing the opposite exposure.
  if (!point.leg && protection?.entryPrice !== undefined) {
    entry = protection.entryPrice;
    side = oppositeSide(side);
  }
  const direction = leg === "takeProfit" ? 1 : -1;
  const reference = point.leg && edit.kind !== "order" && input.reference !== undefined ? input.reference : entry;
  const valid = reference !== undefined && (point.price - reference) * side * direction > 0;
  return {
    ...protection,
    phase: edit.phase === "dragging" ? "dragging" : "pending",
    showRegion: true,
    handles: protection?.handles ?? [],
    preview: {
      leg,
      price: point.price,
      text: input.profitText(side, quantity, entry, point.price),
      quantity: String(quantity),
      invalid: !valid,
    },
  };
}
