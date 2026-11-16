import { OrderType } from "../contracts/broker.js";
import type { PreOrder } from "../contracts/broker.js";
import type { TradingOverlaySpec, TradingProtectionLeg } from "../contracts/ports.js";
import { oppositeSide } from "../core/financial-rules.js";
import { orderTypeName } from "../core/order-labels.js";

/** What a projected exit line edits: a TP/SL leg (optionally of one allocated level) or the stop-limit trigger. */
export interface TicketLineTarget {
  readonly leg?: TradingProtectionLeg;
  readonly level?: string;
  readonly trigger?: boolean;
}
export interface TicketProjectionInput {
  readonly order: Readonly<PreOrder>;
  /** Projected entry: the order price, or the executable quote for market orders. */
  readonly entry: number;
  /** User can still change the draft (ticket editing or showing an error). */
  readonly editable: boolean;
  /** Ticket is reviewing or sending: lines show as pending instead of draft. */
  readonly pending: boolean;
  /** Leg dragged out of the entry line; its standalone line is hidden until the gesture ends. */
  readonly activeLeg?: TradingProtectionLeg;
  readonly flags: { readonly supportOrderBrackets: boolean; readonly supportMarketBrackets: boolean };
  /** Estimated result text for an exit at `exit` closing `qty`; undefined when unavailable. */
  readonly profitText: (exit: number, qty: number) => string | undefined;
}
export interface TicketLine {
  readonly key: string;
  readonly target: TicketLineTarget;
  readonly spec: TradingOverlaySpec;
}
export interface TicketProjection {
  readonly entry: TradingOverlaySpec;
  readonly lines: readonly TicketLine[];
}

const ENTRY_KEY = "projected-order";
const exitColors = { takeProfit: "#089981", stopLoss: "#b77900" } as const;

/** Unsent ticket draft as chart overlay specs; pure, so drafts never become broker rows. */
export function projectTicketOverlays(input: TicketProjectionInput): TicketProjection {
  const { order, entry, editable, activeLeg } = input;
  const phase = input.pending ? "pending" : "draft";
  // Only a plain legacy pair can be extended by dragging out of the entry line.
  const bracketsFromEntry =
    editable &&
    input.flags.supportOrderBrackets &&
    (order.type !== OrderType.Market || input.flags.supportMarketBrackets) &&
    !order.exitLevels?.length &&
    order.guaranteedStop === undefined &&
    order.trailingStopPips === undefined;
  const activeExit = activeLeg ? order[activeLeg] : undefined;
  const entrySpec: TradingOverlaySpec = {
    kind: "order",
    key: ENTRY_KEY,
    entityId: ENTRY_KEY,
    symbol: order.symbol,
    price: entry,
    side: order.side,
    quantity: order.qty,
    label: orderTypeName(order.type),
    group: ENTRY_KEY,
    actions: editable ? ["modify", "cancel", "submit"] : [],
    style: { lineStyle: 1 },
    protection: {
      phase,
      profitDirection: order.side,
      target: ENTRY_KEY,
      handles: bracketsFromEntry
        ? (["takeProfit", "stopLoss"] as const).filter((leg) => order[leg] === undefined || leg === activeLeg)
        : [],
      ...(activeLeg && activeExit !== undefined
        ? {
            preview: {
              leg: activeLeg,
              price: activeExit,
              text: input.profitText(activeExit, order.qty) ?? "—",
              quantity: String(order.qty),
            },
          }
        : {}),
    },
  };
  const lines = exitTargets(order)
    .filter((item) => !activeLeg || item.target.level || item.target.leg !== activeLeg)
    .flatMap((item): TicketLine[] => {
      if (item.price === undefined || !Number.isFinite(item.price)) return [];
      return [
        {
          key: item.key,
          target: item.target,
          spec: exitSpec(entrySpec, input, item.key, item.target, item.price, item.qty),
        },
      ];
    });
  return { entry: entrySpec, lines };
}

function exitTargets(order: Readonly<PreOrder>) {
  const targets: { key: string; price: number | undefined; qty: number; target: TicketLineTarget }[] = [];
  if (order.type === OrderType.StopLimit)
    targets.push({ key: "trigger", price: order.stopPrice, qty: order.qty, target: { trigger: true } });
  const levels = order.exitLevels?.length
    ? order.exitLevels
    : [{ id: undefined, qty: order.qty, takeProfit: order.takeProfit, stopLoss: order.stopLoss }];
  for (const level of levels)
    for (const leg of ["takeProfit", "stopLoss"] as const)
      targets.push({
        key: `${level.id ?? "root"}:${leg}`,
        price: level[leg],
        qty: level.qty,
        target: { leg, level: level.id },
      });
  return targets;
}

function exitLabel(target: TicketLineTarget): string {
  if (target.leg === "takeProfit") return "Take Profit";
  if (target.leg === "stopLoss") return "Stop Loss";
  return "Stop trigger";
}

function exitSpec(
  entrySpec: TradingOverlaySpec,
  input: TicketProjectionInput,
  key: string,
  target: TicketLineTarget,
  exit: number,
  qty: number,
): TradingOverlaySpec {
  const leg = target.leg;
  const profit = leg ? input.profitText(exit, qty) : undefined;
  const label = exitLabel(target);
  const lineColor = leg && exitColors[leg];
  const id = `${ENTRY_KEY}:${key}`;
  return {
    ...entrySpec,
    key: id,
    entityId: id,
    kind: "bracket",
    actions: input.editable ? ["modify", ...(target.trigger ? [] : (["cancel"] as const))] : [],
    quantity: qty,
    price: exit,
    label: profit ? `${label} · ${profit}` : label,
    side: leg ? oppositeSide(input.order.side) : input.order.side,
    protection: leg
      ? {
          target: id,
          handles: [],
          phase: input.pending ? "pending" : "draft",
          movingLeg: leg,
          entryPrice: input.entry,
          preview: { leg, price: exit, text: profit ?? "—", quantity: String(qty) },
        }
      : undefined,
    style: { lineColor, lineStyle: 1 },
  };
}
