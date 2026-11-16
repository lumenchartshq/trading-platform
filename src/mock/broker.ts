import {
  ConnectionStatus,
  OrderStatus,
  OrderType,
  ParentType,
  Side,
  StandardFormatterName,
  StopType,
} from "../contracts/broker.js";
import type {
  BrokerConfigFlags,
  AccountId,
  AccountManagerInfo,
  BracketOrder,
  Brackets,
  Execution,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  IndividualPosition,
  IWatchedValue,
  Order,
  OrderPreviewResult,
  Position,
  PreOrder,
} from "../contracts/broker.js";
import type { LumenBrokerExtensions } from "../contracts/ports.js";
import { SimulationClock } from "./clock.js";
import { simulationConfig, simulationInstrument } from "./scenarios.js";
import type { SimulationProfile } from "./scenarios.js";
import { createSimulationFeeds } from "./feeds.js";
import { completeParentProtection } from "../core/parent-protection.js";
import { protectionFromChildEdit } from "../core/bracket-modification.js";
import { withoutCanceledProtection } from "./protection-cancellation.js";
import { validateQuantity } from "../core/trading-rules.js";
interface AccountState {
  readonly orders: Map<string, Order>;
  readonly positions: Map<string, Position>;
  readonly individuals: Map<string, IndividualPosition>;
  readonly executions: Map<string, Execution>;
  equity: number;
}
const protectionLegKinds = ["takeProfit", "stopLoss", "guaranteedStop", "trailingStopPips"] as const;
type ProtectionLeg = (typeof protectionLegKinds)[number];
/** How a protection edit reaches existing legs: `modify` keeps surviving IDs, `replace` cancels and recreates all. */
export type ProtectionEdits = "modify" | "replace";
/** Simulated commission per execution, as a signed cash flow. */
const commission = -0.1;
/**
 * When host updates emitted by a mutation reach the platform relative to its promise: `before` emits them
 * synchronously, `after` holds them until the promise has resolved, `split` emits the first before and the rest after.
 */
export type UpdateOrdering = "before" | "after" | "split";
const updateOrderings: readonly UpdateOrdering[] = ["before", "after", "split"];
function updateOrdering(value: unknown): UpdateOrdering {
  if (updateOrderings.includes(value as UpdateOrdering)) return value as UpdateOrdering;
  throw new Error(`Unknown update ordering: ${String(value)}.`);
}
/** Test runners may set `TRADING_UPDATE_ORDERING`; browsers have no `process`, so the default stays `before`. */
function defaultUpdateOrdering(): UpdateOrdering {
  const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = environment?.TRADING_UPDATE_ORDERING;
  return value ? updateOrdering(value) : "before";
}
interface HeldUpdates {
  readonly pending: (() => void)[];
  passFirst: boolean;
}
/** `pipValue` models a contract multiplier for pip-arithmetic scenarios; by default a pip is worth pipSize USD per unit. */
interface SimulationOptions {
  readonly updateOrdering?: UpdateOrdering;
  readonly profile?: SimulationProfile;
  readonly seed?: number;
  readonly clock?: SimulationClock;
  readonly instrumentUnits?: string;
  readonly pipValue?: number;
}
export interface SimulationCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly accountId: string;
}
/** A broker-owned state machine. Platform/demo controls can only issue broker operations or scripted events. */
export function createDeterministicBroker(options: SimulationOptions = {}) {
  const profile = options.profile ?? "equity-net";
  const seed = options.seed ?? 1;
  const clock = options.clock ?? new SimulationClock();
  const pipValue = () => options.pipValue ?? simulationInstrument(profile).pipValue;
  const feeds = createSimulationFeeds(seed);
  const config = simulationConfig(profile);
  const accounts = new Map<string, AccountState>();
  const calls: SimulationCall[] = [];
  let host: IBrokerConnectionAdapterHost | undefined;
  let broker: IBrokerTerminal | undefined;
  let accountId = "simulation-A";
  let status = ConnectionStatus.Connected;
  let sequence = seed >>> 0;
  let alive = true;
  let factoryCalls = 0;
  let rejectNext: string | undefined;
  let rejectAsBrokerRejection = false;
  let ackDelay = 0;
  const leverage = new Map<string, number>();
  const equityDemand = new Set<string>();
  const marginDemand = new Set<string>();
  const pipDemand = new Set<string>();
  const equityValues = new Map<string, IWatchedValue<number>>();
  const previews = new Map<string, { readonly payload: string; readonly createdAt: number }>();
  let previewTtl: number | undefined;
  const acknowledgements = new Map<unknown, () => void>();
  const bracketQuantities = new Map<string, number>();
  const bracketParents = new Map<string, string>();
  const delayedReads: { release: () => void }[] = [];
  let delayNext = false;
  let ordering =
    options.updateOrdering === undefined ? defaultUpdateOrdering() : updateOrdering(options.updateOrdering);
  let held: HeldUpdates | undefined;
  let protectionEdits: ProtectionEdits = "modify";
  const id = (kind: string) => `sim-${kind}-${++sequence}`;
  const activeOrder = (order: Order) =>
    [OrderStatus.Working, OrderStatus.Inactive, OrderStatus.Placing].includes(order.status);
  for (const [index, name] of ["simulation-A", "simulation-B"].entries()) {
    const state: AccountState = {
      orders: new Map(),
      positions: new Map(),
      individuals: new Map(),
      executions: new Map(),
      equity: 10000 + index * 5000,
    };
    const position: Position = {
      id: `${name}:net:SIM:X`,
      symbol: "SIM:X",
      qty: 4,
      side: Side.Buy,
      avgPrice: 99,
      extra: { pl: 4 },
    };
    state.positions.set(position.id, position);
    const individual: IndividualPosition = {
      id: `${name}:individual:1`,
      date: clock.now(),
      symbol: "SIM:X",
      qty: 4,
      side: Side.Buy,
      price: 99,
      extra: { pl: 4 },
    };
    state.individuals.set(individual.id, individual);
    accounts.set(name, state);
  }
  const current = () => accounts.get(accountId)!;
  const requireHost = () => {
    if (!host || !alive) throw new Error("Simulation is closed or not initialized.");
    return host;
  };
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args: structuredClone(args), accountId });
  };
  /**
   * Sends one host update now, or holds it while a mutation's ordering defers its updates. Broker state has already
   * changed; a disconnected broker withholds the push, so the platform must re-read after reconnecting.
   */
  const publish = (send: (adapter: IBrokerConnectionAdapterHost) => void) => {
    const adapter = requireHost();
    const deliver = () => {
      if (alive && status === ConnectionStatus.Connected) send(adapter);
    };
    if (!held) return deliver();
    if (held.passFirst) {
      held.passFirst = false;
      return deliver();
    }
    held.pending.push(deliver);
  };
  const mutation = <T>(method: string, args: unknown[], work: () => T): Promise<T> => {
    if (ordering === "before") return settle(method, args, work);
    const hold: HeldUpdates = { pending: [], passFirst: ordering === "split" };
    const settled = settle(method, args, work, hold);
    // Registered before the caller's reaction, so held updates follow the caller's continuation.
    const release = () =>
      void Promise.resolve().then(() => {
        for (const deliver of hold.pending.splice(0)) deliver();
      });
    settled.then(release, release);
    return settled;
  };
  const settle = async <T>(method: string, args: unknown[], work: () => T, hold?: HeldUpdates): Promise<T> => {
    requireHost();
    record(method, ...args);
    if (status !== ConnectionStatus.Connected) throw new Error("Simulation is disconnected.");
    if (rejectNext) {
      const message = rejectNext;
      rejectNext = undefined;
      if (rejectAsBrokerRejection) throw { code: "rejected", message };
      throw new Error(message);
    }
    held = hold;
    let result: T;
    try {
      result = work();
    } finally {
      held = undefined;
    }
    const delay = ackDelay;
    ackDelay = 0;
    if (delay > 0)
      await new Promise<void>((resolve) => {
        const handle = clock.setTimeout(() => {
          acknowledgements.delete(handle);
          resolve();
        }, delay);
        acknowledgements.set(handle, resolve);
      });
    return result;
  };
  const read = <T>(method: string, value: T): Promise<T> => {
    record(method);
    if (status !== ConnectionStatus.Connected) return Promise.reject(new Error("Simulation is disconnected."));
    const captured = structuredClone(value);
    if (!delayNext) return Promise.resolve(captured);
    delayNext = false;
    return new Promise<T>((resolve) => delayedReads.push({ release: () => resolve(captured) }));
  };
  const emitOrder = (order: Order) => {
    current().orders.set(order.id, structuredClone(order));
    const update = structuredClone(order);
    publish((adapter) => adapter.orderUpdate(update));
  };
  const emitPosition = (position: Position) => {
    if (position.qty) current().positions.set(position.id, structuredClone(position));
    else current().positions.delete(position.id);
    const update = structuredClone(position);
    publish((adapter) => adapter.positionUpdate(update));
  };
  const emitIndividual = (position: IndividualPosition) => {
    if (position.qty) current().individuals.set(position.id, structuredClone(position));
    else current().individuals.delete(position.id);
    const update = structuredClone(position);
    publish((adapter) => adapter.individualPositionUpdate(update));
  };
  /** Books realised P&L and costs into the account equity, its summary value and any subscribed equity channel. */
  const realise = (cashFlow: number) => {
    if (!cashFlow) return;
    const state = current();
    state.equity += cashFlow;
    const equity = state.equity;
    equityValues.get(accountId)?.setValue(equity);
    if (equityDemand.has(accountId)) publish((adapter) => adapter.equityUpdate(equity));
  };
  /** Money P&L of closing `qty` at `price` against an average entry, in account currency (one USD unit per qty). */
  const closedPL = (side: Side, average: number, price: number, qty: number) => (price - average) * qty * side;
  const markPrice = (symbol: string) => feeds.lastPrice(symbol) ?? 100;
  function getOrder(orderId: string): Order {
    const order = current().orders.get(orderId);
    if (!order || !activeOrder(order)) throw new Error("The order is no longer active.");
    return order;
  }
  function getPosition(positionId: string): Position {
    const position = current().positions.get(positionId);
    if (!position) throw new Error("The position is no longer active.");
    return position;
  }
  function cancelSelectedOrder(order: Order): void {
    if (!activeOrder(current().orders.get(order.id) ?? order)) return;
    const selected: Order[] = [order];
    for (const candidate of current().orders.values()) {
      if (
        candidate.id === order.id ||
        !activeOrder(candidate) ||
        !("parentId" in candidate) ||
        candidate.symbol !== order.symbol
      )
        continue;
      if (!("parentId" in order)) {
        if (candidate.parentType === ParentType.Order && candidate.parentId === order.id) selected.push(candidate);
        continue;
      }
      if (
        config.configFlags.supportCancellingBothBracketsOnly &&
        candidate.parentType === order.parentType &&
        candidate.parentId === order.parentId &&
        candidate.exitLevelId === order.exitLevelId
      )
        selected.push(candidate);
    }
    for (const candidate of selected) emitOrder({ ...candidate, status: OrderStatus.Canceled });
    if (!("parentId" in order)) return;
    const children = selected.filter((child): child is BracketOrder => "parentId" in child);
    if (order.parentType === ParentType.Order) {
      const parent = current().orders.get(order.parentId);
      if (parent && activeOrder(parent)) emitOrder(withoutCanceledProtection(parent, children));
    } else if (order.parentType === ParentType.Position) {
      const parent = current().positions.get(order.parentId);
      if (parent) emitPosition(withoutCanceledProtection(parent, children));
    } else if (order.parentType === ParentType.IndividualPosition) {
      const parent = current().individuals.get(order.parentId);
      if (parent) emitIndividual(withoutCanceledProtection(parent, children));
    }
  }
  function modifyBracketOrder(previous: BracketOrder, order: BracketOrder): void {
    let parent: Order | Position | IndividualPosition | undefined;
    if (previous.parentType === ParentType.Order) parent = current().orders.get(previous.parentId);
    else if (previous.parentType === ParentType.Position) parent = current().positions.get(previous.parentId);
    else if (previous.parentType === ParentType.IndividualPosition)
      parent = current().individuals.get(previous.parentId);
    if (!parent) throw new Error("Protection parent is unavailable.");
    const children = [...current().orders.values()].filter(
      (child) =>
        "parentId" in child &&
        child.parentType === previous.parentType &&
        child.parentId === previous.parentId &&
        activeOrder(child),
    );
    const brackets = protectionFromChildEdit(
      completeParentProtection<typeof parent>(parent, children),
      previous,
      order,
    );
    const updated = { ...parent, ...brackets };
    if (previous.parentType === ParentType.Order) {
      const parentOrder = updated as Order;
      parentOrder.stopType = undefined;
      if (brackets.trailingStopPips !== undefined) parentOrder.stopType = StopType.TrailingStop;
      else if (brackets.guaranteedStop !== undefined) parentOrder.stopType = StopType.GuaranteedStop;
      else if (brackets.stopLoss !== undefined) parentOrder.stopType = StopType.StopLoss;
      emitOrder(parentOrder);
    } else if (previous.parentType === ParentType.Position) emitPosition(updated as Position);
    else emitIndividual(updated as IndividualPosition);
    bracketQuantities.set(order.id, order.qty);
    emitOrder({ ...order, status: previous.status });
    for (const sibling of current().orders.values()) {
      if (
        sibling.id === order.id ||
        !("parentId" in sibling) ||
        !activeOrder(sibling) ||
        sibling.parentType !== previous.parentType ||
        sibling.parentId !== previous.parentId ||
        sibling.exitLevelId !== previous.exitLevelId ||
        sibling.qty === order.qty
      )
        continue;
      bracketQuantities.set(sibling.id, order.qty);
      emitOrder({ ...sibling, qty: order.qty });
    }
  }
  /**
   * Reconciles a parent's protection against the requested brackets, per exit level and leg kind: surviving legs keep
   * their broker ID and are updated in place only when they change, removed legs are cancelled, new legs are created.
   */
  function protection(parent: Order | Position | IndividualPosition, parentType: ParentType, brackets: Brackets): void {
    const existing = new Map<string, BracketOrder>();
    const replaced: BracketOrder[] = [];
    for (const child of current().orders.values())
      if ("parentId" in child && child.parentType === parentType && child.parentId === parent.id && activeOrder(child))
        if (protectionEdits === "replace") replaced.push(child);
        else existing.set(legKey(child.exitLevelId, legKind(child)), child);
    const requested = protectionLegs(parent, parentType, brackets);
    for (const child of replaced) emitOrder({ ...child, status: OrderStatus.Canceled });
    for (const [key, child] of existing) if (!requested.has(key)) emitOrder({ ...child, status: OrderStatus.Canceled });
    for (const [key, template] of requested) {
      const survivor = existing.get(key);
      const child: BracketOrder = survivor
        ? { ...template, id: survivor.id, status: survivor.status }
        : { ...template, id: id("bracket") };
      bracketQuantities.set(child.id, child.qty);
      if (parentType === ParentType.Order) bracketParents.set(child.id, parent.id);
      if (!survivor || !sameOrder(survivor, child)) emitOrder(child);
    }
  }
  const legKey = (exitLevelId: string | undefined, leg: ProtectionLeg) => `${exitLevelId ?? "single"}:${leg}`;
  function legKind(child: BracketOrder): ProtectionLeg {
    if (child.type === OrderType.Limit) return "takeProfit";
    if (child.stopType === StopType.TrailingStop) return "trailingStopPips";
    if (child.stopType === StopType.GuaranteedStop) return "guaranteedStop";
    return "stopLoss";
  }
  const sameOrder = (left: Order, right: Order) =>
    Object.keys({ ...left, ...right }).every(
      (key) => JSON.stringify(left[key as keyof Order]) === JSON.stringify(right[key as keyof Order]),
    );
  /** The legs the requested brackets describe, keyed by exit level and leg kind, without broker IDs. */
  function protectionLegs(
    parent: Order | Position | IndividualPosition,
    parentType: ParentType,
    brackets: Brackets,
  ): Map<string, Omit<BracketOrder, "id">> {
    const legs = new Map<string, Omit<BracketOrder, "id">>();
    const levels = brackets.exitLevels ?? [
      {
        id: "single",
        qty: parent.qty,
        takeProfit: brackets.takeProfit,
        stopLoss: brackets.stopLoss,
        guaranteedStop: brackets.guaranteedStop,
        trailingStopPips: brackets.trailingStopPips,
      },
    ];
    for (const level of levels) {
      for (const leg of protectionLegKinds) {
        const price = level[leg];
        if (price === undefined) continue;
        const takeProfit = leg === "takeProfit";
        legs.set(legKey(level.id, leg), {
          symbol: parent.symbol,
          side: -parent.side as Side,
          qty: level.qty,
          type: takeProfit ? OrderType.Limit : OrderType.Stop,
          status: parentType === ParentType.Order ? OrderStatus.Inactive : OrderStatus.Working,
          parentId: parent.id,
          parentType,
          exitLevelId: level.id,
          ...(takeProfit
            ? { limitPrice: price }
            : {
                stopPrice:
                  leg === "trailingStopPips"
                    ? 100 - parent.side * price * simulationInstrument(profile).pipSize
                    : price,
              }),
          ...(leg === "trailingStopPips" ? { stopType: StopType.TrailingStop, trailingStopPips: price } : {}),
          ...(leg === "guaranteedStop" ? { stopType: StopType.GuaranteedStop } : {}),
        });
      }
    }
    return legs;
  }
  /** Reduces a net position at `price` (default: the current quote) and realises its P&L; commission is the caller's. */
  function closePosition(positionId: string, amount?: number, price?: number): void {
    const position = getPosition(positionId);
    const qty = amount ?? position.qty;
    validateQuantity(qty, simulationInstrument(profile).qty);
    if (qty > position.qty) throw new Error("Close quantity exceeds the position.");
    emitPosition({ ...position, qty: position.qty - qty });
    if (qty === position.qty)
      for (const order of current().orders.values())
        if ("parentId" in order && order.parentId === positionId && activeOrder(order))
          emitOrder({ ...order, status: OrderStatus.Canceled });
    realise(closedPL(position.side, position.avgPrice, price ?? markPrice(position.symbol), qty));
  }
  /** Reduces one individual position and the net position it belongs to; a full close cancels its protection. */
  function closeIndividualPosition(positionId: string, amount?: number, price?: number): void {
    const position = current().individuals.get(positionId);
    if (!position) throw new Error("Unknown individual position.");
    const qty = amount ?? position.qty;
    validateQuantity(qty, simulationInstrument(profile).qty);
    if (qty > position.qty) throw new Error("Invalid close quantity.");
    emitIndividual({ ...position, qty: position.qty - qty });
    if (qty === position.qty)
      for (const order of current().orders.values())
        if (
          "parentId" in order &&
          order.parentType === ParentType.IndividualPosition &&
          order.parentId === positionId &&
          activeOrder(order)
        )
          emitOrder({ ...order, status: OrderStatus.Canceled });
    const net = [...current().positions.values()].find((value) => value.symbol === position.symbol);
    if (net) closePosition(net.id, Math.min(qty, net.qty), price);
  }
  /** One-cancels-other: a filled leg cancels the other legs of its exit level. */
  function cancelExitLevelSiblings(order: BracketOrder): void {
    for (const sibling of current().orders.values())
      if (
        "parentId" in sibling &&
        sibling.parentId === order.parentId &&
        sibling.exitLevelId === order.exitLevelId &&
        sibling.id !== order.id &&
        activeOrder(sibling)
      )
        emitOrder({ ...sibling, status: OrderStatus.Canceled });
  }
  /** Publishes one execution and books its commission. */
  function recordExecution(symbol: string, side: Side, qty: number, price: number): void {
    const execution: Execution = { id: id("execution"), symbol, side, qty, price, time: clock.now(), commission };
    current().executions.set(execution.id, execution);
    publish((adapter) => adapter.executionUpdate(execution));
    realise(commission);
  }
  /** Applies a fill to a position under netting: same side averages in, opposite side reduces or flips it. */
  function netFill(positionKey: string, symbol: string, fillSide: Side, qty: number, price: number): Position {
    const previous = current().positions.get(positionKey);
    const signed = (previous ? previous.qty * previous.side : 0) + qty * fillSide;
    const side = signed < 0 ? Side.Sell : Side.Buy;
    let avgPrice = price;
    if (previous && previous.side === fillSide)
      avgPrice = (previous.avgPrice * previous.qty + price * qty) / (previous.qty + qty);
    else if (previous && side === previous.side) avgPrice = previous.avgPrice;
    const position: Position = { id: positionKey, symbol, side, qty: Math.abs(signed), avgPrice, extra: { pl: 0 } };
    emitPosition(position);
    if (previous && previous.side !== fillSide)
      realise(closedPL(previous.side, previous.avgPrice, price, Math.min(qty, previous.qty)));
    return position;
  }
  /**
   * Native reverse: cancels the position's protection, then one synthetic market fill of twice the quantity at the
   * current quote (a closing and an opening execution) flips it through the netting path, keeping its ID.
   */
  function reversePosition(positionId: string): void {
    const position = getPosition(positionId);
    const price = markPrice(position.symbol);
    const side = -position.side as Side;
    for (const order of current().orders.values())
      if ("parentId" in order && order.parentId === positionId && activeOrder(order))
        emitOrder({ ...order, status: OrderStatus.Canceled });
    if (config.configFlags.supportPositionNetting)
      for (const individual of [...current().individuals.values()])
        if (individual.symbol === position.symbol) {
          for (const order of current().orders.values())
            if ("parentId" in order && order.parentId === individual.id && activeOrder(order))
              emitOrder({ ...order, status: OrderStatus.Canceled });
          emitIndividual({ ...individual, qty: 0 });
        }
    const qty = position.qty * 2;
    emitOrder({
      id: id("order"),
      symbol: position.symbol,
      side,
      qty,
      type: OrderType.Market,
      status: OrderStatus.Filled,
      filledQty: qty,
      avgPrice: price,
    });
    recordExecution(position.symbol, side, position.qty, price);
    recordExecution(position.symbol, side, position.qty, price);
    netFill(positionId, position.symbol, side, qty, price);
    if (config.configFlags.supportPositionNetting)
      emitIndividual({
        id: id("individual"),
        date: clock.now(),
        symbol: position.symbol,
        side,
        qty: position.qty,
        price,
      });
  }
  function fill(orderId: string, quantity?: number, price = 100): void {
    const order = getOrder(orderId),
      remaining = order.qty - (order.filledQty ?? 0),
      qty = quantity ?? remaining;
    if (order.status === OrderStatus.Inactive) throw new Error("The bracket is not active.");
    validateQuantity(qty, simulationInstrument(profile).qty);
    if (qty > remaining || !Number.isFinite(price)) throw new Error("Invalid fill.");
    const filledQty = (order.filledQty ?? 0) + qty;
    emitOrder({
      ...order,
      filledQty,
      avgPrice: price,
      status: filledQty === order.qty ? OrderStatus.Filled : OrderStatus.Working,
    });
    recordExecution(order.symbol, order.side, qty, price);
    if ("parentId" in order && order.parentType === ParentType.Position) {
      closePosition(order.parentId, qty, price);
      cancelExitLevelSiblings(order);
      return;
    }
    if ("parentId" in order && order.parentType === ParentType.IndividualPosition) {
      closeIndividualPosition(order.parentId, qty, price);
      cancelExitLevelSiblings(order);
      return;
    }
    const positionKey = config.configFlags.supportMultiposition ? id("position") : `${accountId}:net:${order.symbol}`;
    const position = netFill(positionKey, order.symbol, order.side, qty, price);
    if (config.configFlags.supportPositionNetting)
      emitIndividual({ id: id("individual"), date: clock.now(), symbol: order.symbol, side: order.side, qty, price });
    // Broker-confirmed activation/reparenting, preserving child IDs.
    for (const child of current().orders.values())
      if ("parentId" in child && bracketParents.get(child.id) === order.id && activeOrder(child))
        emitOrder({
          ...child,
          parentId: position.id,
          parentType: ParentType.Position,
          // Multiposition: each fill opens its own position, so an exit moved onto it covers that position only.
          qty: Math.min(
            bracketQuantities.get(child.id) ?? child.qty,
            config.configFlags.supportMultiposition ? position.qty : filledQty,
          ),
          status: OrderStatus.Working,
        });
  }
  const formatter = (places = 2) => ({
    format: (value?: number) => (value === undefined ? "" : value.toFixed(places)),
    parse: (text: string) => {
      const value = Number(text);
      if (!text.trim() || !Number.isFinite(value)) return { res: false as const, error: "Enter a number." };
      return { res: true as const, value };
    },
  });
  /** A confirmId must name an unused, unexpired preview of the same payload; successful use consumes it. */
  const checkPreview = (value: PreOrder | Order, confirmId?: string) => {
    if (!confirmId) return;
    const preview = previews.get(confirmId);
    if (preview?.payload !== JSON.stringify(value)) throw new Error("This preview is stale.");
    if (previewTtl !== undefined && clock.now() - preview.createdAt > previewTtl) {
      previews.delete(confirmId);
      throw new Error("This preview has expired.");
    }
  };
  const consumePreview = (confirmId?: string) => {
    if (confirmId) previews.delete(confirmId);
  };
  /** A close preview's ID names the position and amount it was issued for; the same rules as order previews. */
  const openQuantity = (positionId: string) =>
    current().individuals.get(positionId)?.qty ?? current().positions.get(positionId)?.qty;
  const closePreviewPayload = (positionId: string, amount?: number) => ({
    positionId,
    amount: amount ?? openQuantity(positionId) ?? null,
  });
  const checkClosePreview = (positionId: string, amount: number | undefined, confirmId?: string) =>
    checkPreview(closePreviewPayload(positionId, amount) as unknown as PreOrder, confirmId);
  const factory = (adapterHost: IBrokerConnectionAdapterHost): IBrokerTerminal => {
    factoryCalls++;
    if (host) throw new Error("A simulation supports one session. Create another fixture for another widget.");
    host = adapterHost;
    const summaries = new Map<string, AccountManagerInfo>();
    const terminal: IBrokerTerminal = {
      connectionStatus: () => status,
      currentAccount: () => accountId as AccountId,
      accountsMetainfo: () =>
        read(
          "accountsMetainfo",
          [...accounts.keys()].map((account, index) => ({
            id: account as AccountId,
            name: `Simulated account ${index + 1}`,
            type: "demo" as const,
            currency: "USD",
          })),
        ),
      setCurrentAccount: (target) => {
        record("setCurrentAccount", target);
        if (!accounts.has(target)) throw new Error("Unknown account.");
        accountId = target;
        requireHost().currentAccountUpdate();
      },
      accountManagerInfo: () => {
        let info = summaries.get(accountId);
        if (!info) {
          const equity = requireHost().factory.createWatchedValue(current().equity);
          equityValues.set(accountId, equity);
          info = {
            accountTitle: "Simulated trading",
            pages: [],
            summary: [{ text: "Equity", wValue: equity }],
            orderColumns: [
              { id: "symbol", label: "Symbol", dataFields: ["symbol"] },
              { id: "qty", label: "Quantity", dataFields: ["qty"], formatter: StandardFormatterName.FormatQuantity },
              { id: "status", label: "Status", dataFields: ["status"], formatter: StandardFormatterName.Status },
            ],
            positionColumns: [
              { id: "symbol", label: "Symbol", dataFields: ["symbol", "symbol"], formatter: StandardFormatterName.Symbol },
              { id: "side", label: "Side", dataFields: ["side"], formatter: StandardFormatterName.Side },
              { id: "qty", label: "Qty", dataFields: ["qty"], formatter: StandardFormatterName.FormatQuantity },
              {
                id: "avgPrice",
                label: "Avg fill price",
                dataFields: ["avgPrice"],
                formatter: StandardFormatterName.FormatPrice,
              },
              {
                id: "profitLoss",
                label: "P&L",
                dataFields: [["extra", "pl"]],
                formatter: StandardFormatterName.Profit,
                showZeroValues: false,
              },
              {
                id: "takeProfit",
                label: "Take profit",
                dataFields: ["takeProfit"],
                formatter: StandardFormatterName.FormatPrice,
              },
              {
                id: "stopLoss",
                label: "Stop loss",
                dataFields: ["stopLoss"],
                formatter: StandardFormatterName.FormatPrice,
              },
            ],
          };
          summaries.set(accountId, info);
        }
        return info;
      },
      orders: () => read("orders", [...current().orders.values()].filter(activeOrder)),
      ordersHistory: () =>
        read(
          "ordersHistory",
          [...current().orders.values()].filter((order) => !activeOrder(order)),
        ),
      positions: () => read("positions", [...current().positions.values()]),
      individualPositions: () => read("individualPositions", [...current().individuals.values()]),
      executions: (symbol) =>
        read(
          "executions",
          [...current().executions.values()].filter((execution) => execution.symbol === symbol),
        ),
      symbolInfo: async (symbol) => {
        record("symbolInfo", symbol);
        if (symbol !== "SIM:X") throw new Error("Unknown simulated instrument.");
        const value = simulationInstrument(profile);
        const multiple = leverage.get(symbol);
        return {
          ...value,
          pipValue: pipValue(),
          ...(options.instrumentUnits === undefined ? {} : { units: options.instrumentUnits }),
          leverage: String(multiple ?? 10),
          marginRate: 1 / (multiple ?? 10),
        };
      },
      isTradable: async (symbol) => symbol === "SIM:X",
      chartContextMenuActions: (context) => requireHost().defaultContextMenuActions(context),
      placeOrder: (order, confirmId) =>
        mutation("placeOrder", [order, confirmId], () => {
          validateQuantity(order.qty, simulationInstrument(profile).qty);
          checkPreview(order, confirmId);
          const placed: Order = { ...structuredClone(order), id: id("order"), status: OrderStatus.Working };
          emitOrder(placed);
          protection(placed, ParentType.Order, placed);
          consumePreview(confirmId);
          return { orderId: placed.id };
        }),
      modifyOrder: (order, confirmId) =>
        mutation("modifyOrder", [order, confirmId], () => {
          const old = getOrder(order.id);
          if (old.symbol !== order.symbol || old.side !== order.side) throw new Error("Immutable order identity.");
          validateQuantity(order.qty, simulationInstrument(profile).qty);
          checkPreview(order, confirmId);
          if ("parentId" in old && "parentId" in order) modifyBracketOrder(old, order);
          else {
            emitOrder({ ...order, status: old.status });
            protection(order, ParentType.Order, order);
          }
          consumePreview(confirmId);
        }),
      cancelOrder: (orderId) => mutation("cancelOrder", [orderId], () => cancelSelectedOrder(getOrder(orderId))),
      cancelOrders: (symbol, side, ids) =>
        mutation("cancelOrders", [symbol, side, ids], () => {
          const selected = ids.map(getOrder);
          if (selected.some((order) => order.symbol !== symbol || (side !== undefined && order.side !== side)))
            throw new Error("Invalid cancellation selection.");
          for (const order of selected) cancelSelectedOrder(order);
        }),
      closePosition: (positionId, amount, confirmId) =>
        mutation("closePosition", [positionId, amount, confirmId], () => {
          checkClosePreview(positionId, amount, confirmId);
          closePosition(positionId, amount);
          consumePreview(confirmId);
          realise(commission);
        }),
      closeIndividualPosition: (positionId, amount, confirmId) =>
        mutation("closeIndividualPosition", [positionId, amount, confirmId], () => {
          checkClosePreview(positionId, amount, confirmId);
          closeIndividualPosition(positionId, amount);
          consumePreview(confirmId);
          realise(commission);
        }),
      reversePosition: (positionId) => mutation("reversePosition", [positionId], () => reversePosition(positionId)),
      editPositionBrackets: (positionId, brackets, fields) =>
        mutation("editPositionBrackets", [positionId, brackets, fields], () => {
          const position = getPosition(positionId);
          const updated = { ...position, ...brackets };
          emitPosition(updated);
          protection(updated, ParentType.Position, brackets);
        }),
      editIndividualPositionBrackets: (positionId, brackets) =>
        mutation("editIndividualPositionBrackets", [positionId, brackets], () => {
          const position = current().individuals.get(positionId);
          if (!position) throw new Error("Unknown individual position.");
          const updated = { ...position, ...brackets };
          emitIndividual(updated);
          protection(updated, ParentType.IndividualPosition, brackets);
        }),
      previewOrder: async (order) => {
        record("previewOrder", order);
        const confirmId = id("preview");
        previews.set(confirmId, { payload: JSON.stringify(order), createdAt: clock.now() });
        const result: OrderPreviewResult = {
          confirmId,
          sections: [{ rows: [{ title: "Simulated commission", value: "0.10 USD" }] }],
        };
        return result;
      },
      leverageInfo: async (params) => {
        record("leverageInfo", params);
        return { title: "Simulated leverage", leverage: leverage.get(params.symbol) ?? 10, min: 1, max: 100, step: 1 };
      },
      previewLeverage: async (params) => {
        record("previewLeverage", params);
        return {
          infos: ["Simulation only"],
          errors: params.leverage < 1 || params.leverage > 100 ? ["Choose leverage from 1 to 100."] : [],
        };
      },
      setLeverage: (params) =>
        mutation("setLeverage", [params], () => {
          if (!Number.isInteger(params.leverage) || params.leverage < 1 || params.leverage > 100)
            throw new Error("Invalid leverage.");
          leverage.set(params.symbol, params.leverage);
          return { leverage: params.leverage };
        }),
      subscribeEquity: () => {
        equityDemand.add(accountId);
        requireHost().equityUpdate(current().equity);
      },
      unsubscribeEquity: () => {
        equityDemand.delete(accountId);
      },
      subscribeMarginAvailable: (symbol) => {
        marginDemand.add(`${accountId}:${symbol}`);
        requireHost().marginAvailableUpdate(current().equity / 2);
      },
      unsubscribeMarginAvailable: (symbol) => {
        marginDemand.delete(`${accountId}:${symbol}`);
      },
      subscribePipValue: (symbol) => {
        pipDemand.add(`${accountId}:${symbol}`);
        requireHost().pipValueUpdate(symbol, { buyPipValue: pipValue(), sellPipValue: pipValue() });
      },
      unsubscribePipValue: (symbol) => {
        pipDemand.delete(`${accountId}:${symbol}`);
      },
      formatter: async () => formatter(),
      spreadFormatter: async () => formatter(),
      quantityFormatter: async () => formatter(0),
      getSymbolSpecificTradingOptions: async () => ({ supportBracketsInPips: true, supportRiskControlsAndInfo: true }),
      getOrderDialogOptions: async () => ({
        maxExitLevelsCount: 4,
      }),
      getPositionDialogOptions: async () => ({ maxExitLevelsCount: 4 }),
    };
    broker = terminal;
    return terminal;
  };
  if (profile === "custom-ui")
    config.customUI = {
      showOrderDialog: async (template) => {
        const approved = await requireHost().showConfirmDialog("Custom simulated order", template.symbol);
        if (!approved) return false;
        await broker!.placeOrder({
          ...template,
          type: template.type ?? OrderType.Market,
          side: template.side ?? Side.Buy,
          qty: template.qty ?? 2,
        });
        return true;
      },
      showPositionDialog: async (position, brackets) => {
        if (!(await requireHost().showConfirmDialog("Custom protection", position.symbol))) return false;
        await broker!.editPositionBrackets!(position.id, brackets);
        return true;
      },
      showCancelOrderDialog: (order) => requireHost().showConfirmDialog("Custom cancellation", order.id),
      showClosePositionDialog: (position) => requireHost().showConfirmDialog("Custom close", position.id),
      showReversePositionDialog: (position) => requireHost().showConfirmDialog("Custom reverse", position.id),
    };
  const extensions: LumenBrokerExtensions = {
    previewClosePosition: async (request) => {
      record("previewClosePosition", request);
      const previewId = id("close-preview");
      previews.set(previewId, {
        payload: JSON.stringify(closePreviewPayload(request.positionId, request.amount)),
        createdAt: clock.now(),
      });
      return {
        id: previewId,
        rows: [{ title: "Quantity", value: String(request.amount ?? openQuantity(request.positionId) ?? "") }],
        disclaimer: "Simulated outcome only.",
      };
    },
    disposeBroker: () => {
      alive = false;
      for (const [handle, resolve] of acknowledgements) {
        clock.clearTimeout(handle);
        resolve();
      }
      acknowledgements.clear();
      equityDemand.clear();
      marginDemand.clear();
      pipDemand.clear();
      feeds.destroy();
      for (const read of delayedReads.splice(0)) read.release();
    },
  };
  return {
    profile,
    clock,
    brokerConfig: config,
    brokerFactory: factory,
    marketData: feeds.marketData,
    extensions,
    controls: {
      patchCapabilities(patch: Partial<BrokerConfigFlags>) {
        const adapter = requireHost(),
          copied = structuredClone(patch);
        config.configFlags = { ...config.configFlags, ...copied };
        adapter.patchConfig(copied);
      },
      fill,
      /** Moves the scripted quote and, when the profile supports it, pushes broker P&L for open positions. */
      tick(symbol = "SIM:X"): number {
        const price = feeds.tick(symbol);
        if (!config.configFlags.supportPLUpdate) return price;
        for (const position of current().positions.values())
          if (position.symbol === symbol) {
            const pl = closedPL(position.side, position.avgPrice, price, position.qty);
            publish((adapter) => adapter.plUpdate(position.id, pl));
          }
        if (!config.configFlags.supportPositionNetting) return price;
        for (const position of current().individuals.values())
          if (position.symbol === symbol) {
            const pl = closedPL(position.side, position.price, price, position.qty);
            publish((adapter) => adapter.individualPositionPLUpdate(position.id, pl));
          }
        return price;
      },
      quote: feeds.setQuote,
      quoteError: feeds.quoteError,
      depth: feeds.setDepth,
      /** The next mutation rejects; with `brokerRejection` it throws the `BrokerRejection` shape a live adapter should use. */
      rejectNextOperation(message = "Simulated rejection", options: { brokerRejection?: boolean } = {}) {
        rejectNext = message;
        rejectAsBrokerRejection = !!options.brokerRejection;
      },
      delayNextAcknowledgement(milliseconds = 20000) {
        ackDelay = milliseconds;
      },
      delayNextSnapshot() {
        delayNext = true;
      },
      releaseSnapshots() {
        for (const read of delayedReads.splice(0)) read.release();
      },
      disconnect() {
        status = ConnectionStatus.Disconnected;
        requireHost().connectionStatusUpdate(status);
      },
      reconnect() {
        status = ConnectionStatus.Connected;
        requireHost().connectionStatusUpdate(status);
      },
      /** Changes when later mutations deliver their host updates relative to their promise. */
      updateOrdering(value: UpdateOrdering) {
        ordering = updateOrdering(value);
      },
      /** Chooses whether later protection edits modify surviving legs in place or replace every leg. */
      protectionEdits(value: ProtectionEdits) {
        protectionEdits = value;
      },
      /** Expires order previews older than `milliseconds` on the simulation clock; `undefined` keeps them until used. */
      previewTtl(milliseconds: number | undefined) {
        if (milliseconds !== undefined && (!Number.isFinite(milliseconds) || milliseconds < 0))
          throw new Error("A preview lifetime must be a nonnegative duration.");
        previewTtl = milliseconds;
      },
      factoryCalls: () => factoryCalls,
      snapshot: () =>
        structuredClone({
          accountId,
          orders: [...current().orders.values()],
          positions: [...current().positions.values()],
          individualPositions: [...current().individuals.values()],
          executions: [...current().executions.values()],
        }),
      calls: () => structuredClone(calls),
      subscriptionCounts: () => ({
        equity: equityDemand.size,
        margin: marginDemand.size,
        pip: pipDemand.size,
        ...feeds.counts(),
      }),
    },
  };
}
