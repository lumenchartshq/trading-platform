import { orderTypeName, sideName } from "../core/order-labels.js";
import { showsIndividualPositions } from "../core/capabilities.js";
import { OrderStatus, OrderType, Side } from "../contracts/broker.js";
import type { Execution, IndividualPosition, Order, Position } from "../contracts/broker.js";
import type { TradingOverlayAction, TradingOverlayPatch, TradingOverlaySpec } from "../contracts/ports.js";
import { equalData } from "../core/immutable.js";
import type { CapabilityFlags } from "../core/capabilities.js";
import type { TradingFeatures } from "../core/features.js";
import { bracketParent } from "../core/bracket-parent.js";
import { commandKeys } from "../core/command-keys.js";
import { terminalStatuses } from "../core/entity-validation.js";
import type { ProtectionField } from "../core/protection-legs.js";
export type OverlayEntityKind = "order" | "position" | "individualPosition" | "execution";
/** The one spelling of an overlay key (`kind:id`): command kinds share their coordinator lock key. */
export function overlayKey(kind: OverlayEntityKind, id: string): string {
  return kind === "execution" ? `execution:${id}` : commandKeys.entity(kind, id);
}
export interface Projection {
  readonly parentRevision?: number;
  readonly kind: OverlayEntityKind;
  readonly id: string;
  readonly revision: number;
  readonly spec: TradingOverlaySpec;
}
export interface OverlayProjectionContext {
  readonly visible: boolean;
  readonly multiple?: boolean;
  readonly ready: boolean;
  readonly compact: boolean;
  readonly flags: CapabilityFlags;
  readonly features: TradingFeatures;
  readonly parentRevision?: number;
  readonly parentEntryPrice?: number;
  /** TP/SL legs a position's active child orders already provide, for brokers that report them only as children. */
  readonly childLegs?: ReadonlySet<ProtectionField>;
  readonly bracketText?: string;
  /** Hover text of a confirmed exit line; its label when absent. */
  readonly bracketTooltip?: string;
  readonly parentAvailable: (order: Readonly<Order>) => boolean;
  readonly positionProtectionEditable?: (kind: "position" | "individualPosition", symbol: string) => boolean;
  readonly protectionEditable?: (order: Readonly<Order>) => boolean;
  readonly priceEditable: (order: Readonly<Order>) => boolean;
  readonly reversible: (symbol: string) => boolean;
  /** "Reverse position button" setting; the broker policy still decides whether reversing is possible. */
  readonly reverseButton?: boolean;
  /** "Execution labels" setting: marks keep their arrow and drop the Bought/Sold text when off. */
  readonly executionLabels?: boolean;
  readonly profitTone?: (
    kind: "position" | "individualPosition",
    id: string,
    position: Readonly<Position | IndividualPosition>,
  ) => "positive" | "negative" | "neutral";
  readonly profitLabel: (
    kind: "position" | "individualPosition",
    id: string,
    position: Readonly<Position | IndividualPosition>,
  ) => string | undefined;
}

/** "Positions and orders" and "Execution marks" settings; bracket exits are orders. */
export function overlayKindVisible(
  kind: OverlayEntityKind,
  display: { readonly showPositions: boolean; readonly showOrders: boolean; readonly showExecutions: boolean },
): boolean {
  if (kind === "order") return display.showOrders;
  if (kind === "execution") return display.showExecutions;
  return display.showPositions;
}

function orderLabel(order: Readonly<Order>): string {
  const side = sideName(order.side);
  const type = orderTypeName(order.type);
  return order.type === OrderType.Market || !type ? side : `${side} ${type}`;
}

/** State-to-spec mapping with explicit policy and formatting inputs; no session or chart effects. */
export function projectOverlay(
  kind: OverlayEntityKind,
  value: Readonly<Order | Position | IndividualPosition | Execution> | undefined,
  revision: number,
  context: OverlayProjectionContext,
): Projection | undefined {
  if (!context.visible || !value) return undefined;
  const { flags } = context;
  const id = value.id;
  const commandActions = (actions: readonly TradingOverlayAction[]) => (context.ready ? actions : []);
  const base = {
    key: overlayKey(kind, id),
    entityId: id,
    symbol: value.symbol,
    side: value.side,
    quantity: value.qty,
  };
  if (kind === "order") {
    const order = value as Readonly<Order>;
    if (terminalStatuses.has(order.status)) return undefined;
    const price = order.type === OrderType.Limit ? order.limitPrice : (order.stopPrice ?? order.avgPrice);
    if (price === undefined || !Number.isFinite(price)) return undefined;
    const bracket = "parentId" in order;
    const parentLink = bracketParent(order);
    if (bracket && (!parentLink || !context.parentAvailable(order))) return undefined;
    const parentRevision = bracket ? context.parentRevision : undefined;
    return {
      kind,
      id,
      parentRevision,
      revision,
      spec: {
        ...base,
        ...(bracket && context.parentEntryPrice !== undefined
          ? {
              protection: {
                profitDirection: order.side,
                target: overlayKey("order", id),
                handles: [],
                entryPrice: context.parentEntryPrice,
                movingLeg: order.type === OrderType.Limit ? ("takeProfit" as const) : ("stopLoss" as const),
                phase: order.status === OrderStatus.Inactive ? ("inactive" as const) : ("confirmed" as const),
                showRegion: false,
                preview: {
                  leg: order.type === OrderType.Limit ? ("takeProfit" as const) : ("stopLoss" as const),
                  price,
                  quantity: String(order.qty),
                  text: context.bracketText ?? "—",
                },
              },
            }
          : {}),
        ...(context.ready &&
        !context.compact &&
        !bracket &&
        context.protectionEditable?.(order) &&
        (context.multiple || !order.exitLevels?.length) &&
        (flags.supportAddBracketsToExistingOrder ||
          order.takeProfit !== undefined ||
          order.stopLoss !== undefined ||
          order.guaranteedStop !== undefined ||
          order.trailingStopPips !== undefined)
          ? {
              protection: {
                profitDirection: order.side,
                target: overlayKey("order", id),
                handles: [
                  ...(context.multiple || order.takeProfit === undefined ? ["takeProfit" as const] : []),
                  ...((context.multiple || order.stopLoss === undefined) &&
                  order.guaranteedStop === undefined &&
                  order.trailingStopPips === undefined
                    ? ["stopLoss" as const]
                    : []),
                ],
              },
            }
          : {}),
        kind: bracket ? "bracket" : "order",
        price,
        label: orderLabel(order),
        ...(bracket && context.bracketTooltip ? { tooltip: context.bracketTooltip } : {}),
        group: parentLink?.key ?? overlayKey("order", id),
        actions: commandActions([
          ...(context.features.chart_hide_close_order_button ? [] : ["cancel" as const]),
          // Chart modify also owns dragging, which is a price edit; trailing children are not dragged as fixed stops.
          ...(context.priceEditable(order) ? ["modify" as const] : []),
        ]),
      },
    };
  }
  if (kind === "execution") {
    if (!flags.supportExecutions) return undefined;
    const execution = value as Readonly<Execution>;
    return {
      kind,
      id,
      revision,
      spec: {
        ...base,
        kind: "execution",
        price: execution.price,
        time: execution.time / 1000,
        label: context.executionLabels === false ? "" : `${execution.side === Side.Buy ? "Bought" : "Sold"} ${execution.qty}`,
        actions: [],
      },
    };
  }
  const showIndividuals = showsIndividualPositions(flags);
  if (!flags.supportPositions || (kind === "individualPosition") !== showIndividuals) return undefined;
  const position = value as Readonly<Position | IndividualPosition>;
  const price =
    kind === "position" ? (position as Readonly<Position>).avgPrice : (position as Readonly<IndividualPosition>).price;
  if (position.qty <= 0) return undefined;
  const money = context.compact ? undefined : context.profitLabel(kind, id, position);
  const tone = context.profitTone?.(kind, id, position) ?? "neutral";
  const pillText = money ?? "";
  const protectionCapability =
    kind === "position" ? flags.supportPositionBrackets : flags.supportIndividualPositionBrackets;
  const protection = protectionCapability && (context.positionProtectionEditable?.(kind, position.symbol) ?? true);
  return {
    kind,
    id,
    revision,
    spec: {
      ...base,
      ...(context.ready && protection && !context.compact && (context.multiple || !position.exitLevels?.length)
        ? {
            protection: {
              profitDirection: position.side,
              target: overlayKey(kind, id),
              handles: positionHandles(position, context),
            },
          }
        : {}),
      kind: "position",
      pill: { text: tone === "positive" && pillText && !pillText.startsWith("+") ? `+${pillText}` : pillText, tone },
      price,
      label: `${position.side === Side.Buy ? "Long" : "Short"} ${position.qty}${money === undefined ? "" : ` · ${money}`}`,
      group: overlayKey(kind, id),
      actions: commandActions([
        ...(context.features.chart_hide_close_position_button ? [] : ["close" as const]),
        ...(kind === "position" && context.reverseButton !== false && context.reversible(position.symbol) ? ["reverse" as const] : []),
        ...(protection && !context.compact ? ["protect" as const] : []),
      ]),
    },
  };
}

/**
 * TP/SL handles a position offers: a leg is missing only when neither the position nor an active child order
 * provides it. Multiple exit levels always offer both, since a handle adds a level.
 */
function positionHandles(
  position: Readonly<Position | IndividualPosition>,
  context: Pick<OverlayProjectionContext, "multiple" | "childLegs">,
): ("takeProfit" | "stopLoss")[] {
  if (context.multiple) return ["takeProfit", "stopLoss"];
  const has = (field: ProtectionField) => position[field] !== undefined || context.childLegs?.has(field) === true;
  const handles: ("takeProfit" | "stopLoss")[] = [];
  if (!has("takeProfit")) handles.push("takeProfit");
  if (!has("stopLoss") && !has("guaranteedStop") && !has("trailingStopPips")) handles.push("stopLoss");
  return handles;
}

type SpecField = TradingOverlaySpec extends infer Spec ? (Spec extends unknown ? keyof Spec : never) : never;
/**
 * How each spec field reaches a live overlay: sent in a patch when it changes, or fixed for the overlay's life.
 * Every spec field must be listed, so a new contract field cannot be left out of updates.
 */
const specFields = {
  pill: "patch",
  protection: "patch",
  price: "patch",
  label: "patch",
  tooltip: "patch",
  quantity: "patch",
  actions: "patch",
  style: "patch",
  key: "fixed",
  entityId: "fixed",
  symbol: "fixed",
  side: "fixed",
  group: "fixed",
  kind: "fixed",
  time: "fixed",
} as const satisfies Record<SpecField, "patch" | "fixed">;
type PatchedField = { [Field in keyof typeof specFields]: (typeof specFields)[Field] extends "patch" ? Field : never }[keyof typeof specFields];
// Both directions: every patched spec field is a patch field, and every patch field is patched.
const patchFieldsMatch: [PatchedField, keyof TradingOverlayPatch] extends [keyof TradingOverlayPatch, PatchedField] ? true : never = true;
void patchFieldsMatch;

/** Patch for the spec fields that changed; a field that changed to undefined is sent as an explicit undefined. */
export function overlaySpecPatch(old: TradingOverlaySpec, next: TradingOverlaySpec): TradingOverlayPatch {
  const patch: Record<string, unknown> = {};
  for (const [field, mode] of Object.entries(specFields)) {
    const before: unknown = old[field as keyof typeof old];
    const after: unknown = next[field as keyof typeof next];
    if (mode === "patch" && !equalData(before, after)) patch[field] = after;
  }
  return patch as TradingOverlayPatch;
}
