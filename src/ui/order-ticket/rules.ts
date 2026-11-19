import { orderDisplayPrice, orderTypeName } from "../../core/order-labels.js";
import { OrderType } from "../../contracts/broker.js";
import type { InstrumentInfo, PreOrder } from "../../contracts/broker.js";
import { cryptoTicketMode, type CapabilityPolicy } from "../../core/capabilities.js";
import type { OrderEditability } from "../../core/order-modification.js";
import type { TicketState } from "./controller.js";

export type LockedField = "price" | "qty" | "type" | "duration" | "brackets";
export function locked(modifying: boolean, editability: OrderEditability | undefined, field: LockedField): boolean {
  return modifying && !editability?.[field];
}
export function bracketsAllowed(policy: CapabilityPolicy, order: Readonly<PreOrder>, instrumentType?: string): boolean {
  return policy.flags.supportOrderBrackets &&
    (order.type !== OrderType.Market || policy.flags.supportMarketBrackets) &&
    (!cryptoTicketMode(policy, instrumentType) || policy.flags.supportCryptoBrackets);
}
export function riskAllowed(
  policy: CapabilityPolicy,
  order: Readonly<PreOrder>,
  instrument: InstrumentInfo | undefined,
  orderInformation: boolean,
): boolean {
  return orderInformation && bracketsAllowed(policy, order, instrument?.type) &&
    (policy.flags.supportStopLoss || policy.flags.supportGuaranteedStop) &&
    !order.exitLevels?.length && policy.symbol.supportRiskControlsAndInfo !== false &&
    (!cryptoTicketMode(policy, instrument?.type) || policy.flags.supportCryptoBrackets) &&
    instrument?.pipValue !== 0;
}
export function phaseText(phase: TicketState["phase"], modifying: boolean, checking = false, accepted = false): string {
  if (phase === "sending" && accepted) return "Sent to the broker. Waiting for confirmation…";
  if (phase === "sending") return "Waiting for the broker to confirm…";
  if (phase === "unconfirmed" && checking) return "Taking longer than expected. Checking with the broker…";
  if (phase === "unconfirmed") return "We could not confirm the result. Check your orders before sending another trade.";
  if (phase === "confirmed") return modifying ? "The broker confirmed the result." : "";
  if (phase === "loading") return "Loading trading information…";
  return "";
}
/** `previewShown`: the broker previews this order (see `ticketShowsPreview`), not just the user preference. */
export function submitAction(previewShown: boolean, confirmationRequired: boolean, modifying: boolean): string {
  if (previewShown || confirmationRequired) return "Review order";
  if (modifying) return "Modify order";
  return "Place order";
}
export function priceSuffix(order: Readonly<PreOrder>, format: (value: number) => string): string {
  const price = orderDisplayPrice(order);
  return price === undefined ? "" : ` @ ${format(price)}`;
}
export const typeName = orderTypeName;
/**
 * Whether the ticket has settled with nothing left to send: a confirmed order or modification, or a result the session
 * stopped checking on. The ticket then offers to start a new order instead of leaving the user at a dead end.
 */
export function ticketCanStartNext(state: Pick<TicketState, "phase" | "checking">): boolean {
  return state.phase === "confirmed" || (state.phase === "unconfirmed" && state.checking !== true);
}
/** Ticket phases where the user can still change the draft (on the ticket or its chart lines). */
export function ticketEditable(phase: string): boolean {
  return phase === "editing" || phase === "error";
}
