import { bracketProfitInMoney, effectiveDisplay } from "../core/trading-settings.js";
import { oppositeSide, orderEntryPrice } from "../core/financial-rules.js";
import { exitProfitText, exitTooltip } from "./exit-profit.js";
import { accountCurrency, bindingKey } from "../core/identity.js";
import {
  overlayKindVisible,
  overlaySpecPatch,
  overlayKey,
  projectOverlay,
  type OverlayEntityKind,
  type Projection,
  type OverlayProjectionContext,
} from "./overlay-projection.js";
import { createContextActions } from "./context-actions.js";
import { modificationParentAvailable } from "../core/modification-context.js";
import type { ReadonlyValue, TradingLineLayout } from "../contracts/ports.js";
import { createBracketLinks } from "./bracket-links.js";
import { reviewActions } from "./review-lock.js";
import { childProtectionField } from "../core/protection-legs.js";
import { bracketParent } from "../core/bracket-parent.js";
import { createChartPositionProfit } from "./position-profit.js";
import { OverlayIndex } from "./overlay-index.js";
import { createEditPresentation } from "./edit-presentation.js";
import { createOverlayGestures } from "./overlay-gesture.js";
import type { Overlay, OverlayAction, Owner } from "./overlay-types.js";
import { createParentLinks } from "./parent-links.js";
import { createFrameBatch, immediateFrames, type FrameScheduler } from "./frame-batch.js";
import type { InstrumentInfo, Order, Side } from "../contracts/broker.js";
import type {
  TradingChartBinding,
  TradingChartPort,
  TradingCollectionPort,
  TradingOverlayHandle,
  TradingOverlayPatch,
} from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
import { DisposalScope } from "../core/disposal.js";
import { equalData, snapshot } from "../core/immutable.js";
export type { OverlayAction } from "./overlay-types.js";
/** Converts immutable broker state into chart-owned transient overlays; never owns geometry or pointer capture. */
export function createOverlayCoordinator(
  session: TradingSession,
  collection: TradingCollectionPort,
  onAction: (action: OverlayAction) => void | Promise<unknown>,
  onError: (error: unknown) => void = () => {},
  /** Narrow viewport; with adaptive trading lines, position lines drop their TP/SL button and P&L text. */
  narrow?: ReadonlyValue<boolean>,
  /** Quote-driven re-projection (P&L text, market-parent exits) waits for this frame; immediate by default. */
  frames: FrameScheduler = immediateFrames,
  /** Work-count probes for tests; never part of the presentation contract. */
  probes: { readonly financialSync?: () => void } = {},
) {
  const compactLines = () => session.adaptiveTradingLines && narrow?.get() === true;
  const scope = new DisposalScope();
  const owners = new Map<string, Owner>();
  const instruments = new Map<string, InstrumentInfo>();
  const index = new OverlayIndex();
  const exitFinance = new Map<string, { generation: number; release?: () => void }>();
  scope.own(() => {
    for (const lease of exitFinance.values()) lease.release?.();
    exitFinance.clear();
  });
  const keyFor = overlayKey;
  const links = createBracketLinks();
  // Store writes stay synchronous; the chart catches up once per frame however many quotes arrived.
  const quoteWork = createFrameBatch<readonly [OverlayEntityKind, string]>(frames, (entries) => {
    for (const [kind, id] of entries) safely(() => refreshEntity(kind, id));
  });
  scope.own(() => quoteWork.destroy());
  const queueQuoteWork = (kind: OverlayEntityKind, id: string) => quoteWork.queue(keyFor(kind, id), [kind, id]);
  const profitPresentation = createChartPositionProfit(
    session,
    (kind, id) => queueQuoteWork(kind, id),
    (symbol) => safely(() => refreshFinancialSymbol(symbol)),
    onError,
  );
  scope.own(() => profitPresentation.destroy());
  const tradedSources = session.host.tradedSourcesVisibility?.();
  /** "Extended price lines" and "Order and position alignment", shared by every chart. */
  const lineLayoutFrom = (display: Parameters<typeof effectiveDisplay>[0]): TradingLineLayout => {
    const effective = effectiveDisplay(display);
    return { extendLeft: effective.extendLines, alignment: effective.lineAlignment };
  };
  let lineLayout = lineLayoutFrom(session.displaySettings.get());
  let disposed = false;
  // Per-symbol reversing (symbol options may override the account flag); the session memoises symbol policies.
  const reversible = (symbol: string) => session.symbolPolicy(symbol).flags.supportReversePosition;
  const ownerKey = bindingKey;
  const stores = {
    order: session.state.orders,
    position: session.state.positions,
    individualPosition: session.state.individualPositions,
    execution: session.state.executions,
  };
  const safely = (work: () => void) => {
    try {
      work();
    } catch (cause) {
      onError(cause);
    }
  };
  function exitText(
    symbol: string,
    side: Side,
    qty: number,
    entry: number | undefined,
    exit: number,
    currency?: string,
  ): string {
    const text = exitProfitText({
      instrument: instruments.get(symbol),
      side,
      qty,
      entry,
      exit,
      display: session.displaySettings.get(),
      pipValues: session.state.pipValues.get(symbol),
      inInstrumentCurrency: session.symbolPolicy(symbol).flags.positionPLInInstrumentCurrency,
      accountCurrency: currency,
    });
    return text ?? "—";
  }
  /** A confirmed exit's hover text; an exit leg the broker does not name keeps its order label. */
  function bracketTooltip(order: Readonly<Order>, entry: number | undefined): string | undefined {
    const field = childProtectionField(order);
    const price = orderEntryPrice(order);
    if (!field || price === undefined) return undefined;
    return exitTooltip({ field, side: oppositeSide(order.side), entry, exit: price, instrument: instruments.get(order.symbol) });
  }
  function currentAccountCurrency() {
    return accountCurrency(session.accounts.get(), session.state.connection.get().accountId);
  }
  const editPresentation = createEditPresentation({
    edits: session.chartEdits.state,
    owners,
    ownerKey,
    groupKeys: (group) => [group, ...links.children(group).map((id) => keyFor("order", id))],
    keyFor,
    updateOverlay: (handle, patch) => updateOverlay(handle, patch),
    updateProtectionPreview: (owner, overlay, point, gestureId) => updateProtectionPreview(owner, overlay, point, gestureId),
  });
  scope.own(() => editPresentation.destroy());
  const { lockFor, shownProtection } = editPresentation;
  scope.own(
    session.state.pipValues.subscribeChanges((change) => {
      const symbols = [...change.added, ...change.updated, ...change.removed];
      for (const symbol of symbols) for (const id of [...index.exitIds(symbol)]) refreshEntity("order", id);
      const editSymbol = editPresentation.symbol();
      if (editSymbol !== undefined && symbols.includes(editSymbol)) editPresentation.refreshPreview();
    }),
  );

  function updateOverlay(handle: TradingOverlayHandle, patch: TradingOverlayPatch): void {
    handle.update(snapshot(patch));
  }
  const parentLinks = createParentLinks({ stores, quotes: session.state.quotes, links, keyFor });
  const { completedParent, exitEntryPrice, childLegs } = parentLinks;
  const confirmedExitParent = (overlay: Overlay, kind: OverlayEntityKind, id: string) =>
    parentLinks.confirmedExitParent(overlay.projection.spec, kind, id);
  /** Exits are added as allocated levels when the user enabled them and the symbol supports them. */
  const multipleExitLevels = (symbol: string) =>
    session.displaySettings.get().multipleExitLevels === true &&
    session.symbolPolicy(symbol).flags.supportMultipleExitLevels;
  const parentAvailable = (order: Readonly<Order>) => modificationParentAvailable(session.state, order);
  const priceEditable = (order: Readonly<Order>) => session.orderEditability(order).price;
  const profitLabel: OverlayProjectionContext["profitLabel"] = (kind, id, position) =>
    profitPresentation.label(kind, id, position);
  const gestures = createOverlayGestures({
    session,
    onAction,
    onError,
    safely,
    instrument: (symbol) => instruments.get(symbol),
    exitText,
    currentAccountCurrency,
    lockFor,
    shownProtection,
    releaseEdit: editPresentation.releaseEdit,
    displayOn: editPresentation.displayOn,
    updateOverlay,
    multipleExitLevels,
    pipFinanceNeeded,
    completedParent,
    confirmedExitParent,
  });
  const { gestureEligible, updateProtectionPreview, cancelGesture } = gestures;
  function project(kind: OverlayEntityKind, id: string): Projection | undefined {
    if (tradedSources?.value() === false) return undefined;
    const display = effectiveDisplay(session.displaySettings.get());
    if (!overlayKindVisible(kind, display)) return undefined;
    const store = stores[kind];
    const value = store.get(id);
    if (!value) return undefined;
    const parent = kind === "order" ? bracketParent(value as Readonly<Order>) : undefined;
    const parentEntity = parent ? stores[parent.kind].get(parent.id) : undefined;
    const parentEntryPrice = parent && parentEntity ? exitEntryPrice(parent.kind, parentEntity) : undefined;
    return projectOverlay(kind, value, store.revision(id), {
      visible: true,
      multiple: multipleExitLevels(value.symbol),
      ready: session.state.connection.get().phase === "ready",
      compact: compactLines(),
      flags: session.policy.get().flags,
      features: session.features,
      parentRevision: parent ? stores[parent.kind].revision(parent.id) : undefined,
      parentEntryPrice,
      childLegs: kind === "order" ? undefined : childLegs(keyFor(kind, id)),
      bracketText:
        parent && kind === "order"
          ? exitText(
              value.symbol,
              oppositeSide(value.side),
              value.qty,
              parentEntryPrice,
              orderEntryPrice(value as Order) ?? 0,
              currentAccountCurrency(),
            )
          : undefined,
      bracketTooltip: parent && kind === "order" ? bracketTooltip(value as Order, parentEntryPrice) : undefined,
      parentAvailable,
      priceEditable,
      protectionEditable: (order) => session.orderEditability(order).brackets,
      positionProtectionEditable: (kind, symbol) => {
        const policy = session.symbolPolicy(symbol);
        return (
          policy.symbol.supportModifyPositionBrackets !== false &&
          (kind === "position" ? policy.flags.supportPositionBrackets : policy.flags.supportIndividualPositionBrackets)
        );
      },
      reversible,
      reverseButton: display.showReverse,
      executionLabels: display.showExecutionLabels,
      profitTone: profitPresentation.tone,
      profitLabel,
    });
  }
  function removeOverlay(owner: Owner, key: string): void {
    const overlay = owner.overlays.get(key);
    if (!overlay) return;
    owner.overlays.delete(key);
    safely(() => overlay.scope.destroy());
  }
  function reconcile(owner: Owner, projection: Projection | undefined, key: string): void {
    if (!projection || projection.spec.symbol !== owner.binding.symbol) {
      removeOverlay(owner, key);
      return;
    }
    let existing = owner.overlays.get(key);
    if (existing && (existing.projection.spec.group !== projection.spec.group || existing.projection.spec.side !== projection.spec.side)) {
      removeOverlay(owner, key);
      existing = undefined;
    }
    if (existing) {
      const old = existing.projection;
      existing.projection = projection;
      if (
        existing.gestureId &&
        (old.revision !== projection.revision ||
          old.parentRevision !== projection.parentRevision ||
          !gestureEligible(projection, existing.gestureLeg))
      ) {
        cancelGesture(owner, existing);
      }
      const patch: { -readonly [Field in keyof TradingOverlayPatch]: TradingOverlayPatch[Field] } = overlaySpecPatch(old.spec, projection.spec);
      if ("protection" in patch) patch.protection = shownProtection(owner, projection, existing.proposedProtection);
      if (patch.actions) patch.actions = reviewActions(key, patch.actions, lockFor(owner, projection));
      if (Object.keys(patch).length) updateOverlay(existing.handle, patch);
      return;
    }
    const lock = lockFor(owner, projection);
    const handle = owner.chart.createOverlay(lock ? {
      ...projection.spec,
      protection: shownProtection(owner, projection),
      actions: reviewActions(key, projection.spec.actions, lock),
    } : projection.spec);
    const overlayScope = new DisposalScope();
    const overlay: Overlay = { handle, scope: overlayScope, projection };
    let active = true;
    overlayScope.own(() => {
      overlay.releaseFinance?.();
      overlay.releaseFinance = undefined;
      // An overlay removed mid-gesture takes its unsent edit with it.
      if (overlay.gestureId) session.chartEdits.clearIf(overlay.editToken);
    });
    overlayScope.own(() => handle.remove());
    overlayScope.own(() => handle.cancelInteraction());
    overlayScope.own(() => {
      active = false;
    });
    const handleOverlayEvent = gestures.handler(owner, overlay, key, () => active && !disposed && owners.get(ownerKey(owner.binding)) === owner && owner.overlays.get(key) === overlay);
    overlayScope.own(handle.subscribe(handleOverlayEvent));
    owner.overlays.set(key, overlay);
  }
  function refreshEntity(kind: OverlayEntityKind, id: string): void {
    quoteWork.take(keyFor(kind, id));
    const key = keyFor(kind, id),
      candidate = project(kind, id),
      projection = candidate ? snapshot(candidate) : undefined;
    const oldSymbol = index.set(kind, id, key, projection);
    for (const owner of owners.values())
      if (owner.binding.symbol === oldSymbol || owner.binding.symbol === projection?.spec.symbol)
        safely(() => reconcile(owner, projection, key));
  }
  /** Re-projects the entity behind a parent key (`kind:id`; IDs may contain colons). */
  function refreshParent(parentKey: string): void {
    const separator = parentKey.indexOf(":");
    const kind = parentKey.slice(0, separator) as OverlayEntityKind;
    if (kind === "position" || kind === "individualPosition" || kind === "order") refreshEntity(kind, parentKey.slice(separator + 1));
  }
  function refreshFinancialSymbol(symbol: string): void {
    const projections = [...index.projections(symbol).values()];
    for (const projection of projections)
      if (
        projection.kind === "position" ||
        projection.kind === "individualPosition" ||
        projection.spec.kind === "bracket"
      )
        refreshEntity(projection.kind, projection.id);
  }
  /** Bracket money needs broker pip values: money display, account-currency P&L and a pip-value stream. */
  function pipFinanceNeeded(symbol: string): boolean {
    if (!bracketProfitInMoney(session.displaySettings.get()) || !session.policy.get().pipValues) return false;
    return !session.symbolPolicy(symbol).flags.positionPLInInstrumentCurrency;
  }
  /** Inputs of the last financial synchronization; unchanged inputs mean no lease or estimate work. */
  let financialInputs: readonly unknown[] | undefined;
  function synchronizeFinancial(): void {
    if (disposed) return;
    const symbols = [...new Set([...owners.values()].map((owner) => owner.binding.symbol))];
    const withPositions = symbols.filter((symbol) => index.hasPositions(symbol));
    const display = session.displaySettings.get(),
      connection = session.state.connection.get(),
      policy = session.policy.get();
    const withExits = symbols.filter((symbol) => index.hasExits(symbol));
    const inputs = [
      symbols.join("\n"),
      withPositions.join("\n"),
      withExits.join("\n"),
      connection.phase,
      connection.generation,
      display,
      policy,
      session.symbolOptionsRevision?.get(),
    ];
    if (financialInputs && inputs.every((value, index) => Object.is(value, financialInputs![index]))) return;
    financialInputs = inputs;
    probes.financialSync?.();
    profitPresentation.synchronize(symbols, withPositions);
    const needed = new Set(
      withExits.filter((symbol) => connection.phase === "ready" && pipFinanceNeeded(symbol)),
    );
    for (const [symbol, lease] of exitFinance)
      if (!needed.has(symbol) || lease.generation !== connection.generation) {
        exitFinance.delete(symbol);
        lease.release?.();
      }
    for (const symbol of needed)
      if (!exitFinance.has(symbol)) {
        const lease: { generation: number; release?: () => void } = { generation: connection.generation };
        exitFinance.set(symbol, lease);
        safely(() => {
          lease.release = session.acquireFinancial("pip", symbol);
        });
      }
  }
  function removeChart(binding: TradingChartBinding): void {
    const key = ownerKey(binding),
      owner = owners.get(key);
    if (!owner) return;
    owners.delete(key);
    for (const key of [...owner.overlays.keys()]) removeOverlay(owner, key);
    safely(() => owner.scope.destroy());
    synchronizeFinancial();
  }
  function addChart(chart: TradingChartPort): void {
    const binding = chart.binding.get(),
      key = ownerKey(binding);
    if (owners.has(key)) return;
    const owner: Owner = {
      chart,
      binding,
      overlays: new Map(),
      scope: new DisposalScope(),
    };
    owners.set(key, owner);
    // Layout first, so this chart's first lines already sit where the user put them.
    safely(() => chart.setLineLayout?.(lineLayout));
    owner.scope.own(
      chart.binding.subscribe((next) => {
        if (!equalData(next, owner.binding)) {
          removeChart(owner.binding);
          addChart(chart);
        }
      }),
    );
    owner.scope.own(session.acquireQuotes(binding.symbol, "fast", () => {}));
    // Context-menu prices snap to the instrument tick once its metadata is known.
    // Symbol-specific options arrive with it too (per-symbol reversing), so re-project once loaded.
    void session.symbolInfo(binding.symbol).then(
      (info) => {
        instruments.set(binding.symbol, info);
        if (disposed || owners.get(ownerKey(binding)) !== owner) return;
        for (const key of [...index.projections(binding.symbol).keys()]) {
          const separator = key.indexOf(":");
          safely(() => refreshEntity(key.slice(0, separator) as OverlayEntityKind, key.slice(separator + 1)));
        }
      },
      () => {},
    );
    owner.scope.own(session.acquireExecutions(binding.symbol));
    owner.scope.own(
      chart.registerContextActions(createContextActions(session, (symbol) => instruments.get(symbol), onError)),
    );
    for (const [entityKey, projection] of index.projections(binding.symbol))
      safely(() => reconcile(owner, projection, entityKey));
    synchronizeFinancial();
  }
  function rebuild(): void {
    links.clear();
    index.clearMarketParents();
    for (const id of stores.order.ids()) {
      const order = stores.order.get(id);
      links.update(id, order);
      index.indexMarketParent(id, order);
    }
    for (const [kind, store] of Object.entries(stores)) {
      const keys = new Set([...store.ids(), ...index.indexedIds(kind as OverlayEntityKind)]);
      for (const id of keys) refreshEntity(kind as OverlayEntityKind, id);
    }
    synchronizeFinancial();
  }
  if (narrow) scope.own(narrow.subscribe(() => rebuild()));
  if (tradedSources) {
    const sourcesChanged = () => rebuild();
    tradedSources.subscribe(sourcesChanged);
    scope.own(() => tradedSources.unsubscribe(sourcesChanged));
  }
  for (const [kind, store] of Object.entries(stores))
    scope.own(
      store.subscribeChanges((change) => {
        for (const id of [...change.added, ...change.updated, ...change.removed]) {
          if (kind === "order") {
            // A child joining, changing or leaving a parent can change the parent's TP/SL handles.
            const before = links.parentOf(id);
            links.update(id, stores.order.get(id));
            index.indexMarketParent(id, stores.order.get(id));
            for (const parentKey of new Set([before, links.parentOf(id)])) if (parentKey) refreshParent(parentKey);
          }
          refreshEntity(kind as OverlayEntityKind, id);
          for (const child of links.children(keyFor(kind as OverlayEntityKind, id))) refreshEntity("order", child);
        }
        synchronizeFinancial();
      }),
    );
  // Exits under a waiting market order measure from the price it would fill at now: re-project only those.
  scope.own(
    session.state.quotes.subscribeChanges((change) => {
      for (const symbol of [...change.added, ...change.updated, ...change.removed])
        for (const parent of [...index.marketParents(symbol)])
          for (const child of links.children(keyFor("order", parent))) queueQuoteWork("order", child);
    }),
  );
  // Symbol options (for example instrument-currency P&L) feed finance decisions; resync when they load.
  if (session.symbolOptionsRevision) scope.own(session.symbolOptionsRevision.subscribe(() => synchronizeFinancial()));
  // Projection reads only readiness, generation and account from the connection; notices and errors do not rebuild.
  const connectionKey = () => {
    const connection = session.state.connection.get();
    return `${connection.phase === "ready"}:${connection.generation}:${connection.accountId ?? ""}`;
  };
  let lastConnectionKey = connectionKey();
  scope.own(
    session.state.connection.subscribe(() => {
      const key = connectionKey();
      if (key === lastConnectionKey) {
        synchronizeFinancial();
        return;
      }
      lastConnectionKey = key;
      rebuild();
    }),
  );
  scope.own(
    session.policy.subscribe(() => rebuild()),
  );
  scope.own(
    session.displaySettings.subscribe(() => {
      const next = lineLayoutFrom(session.displaySettings.get());
      if (next.extendLeft !== lineLayout.extendLeft || next.alignment !== lineLayout.alignment) {
        lineLayout = next;
        for (const owner of owners.values()) safely(() => owner.chart.setLineLayout?.(lineLayout));
      }
      rebuild();
      editPresentation.refreshPreview();
    }),
  );
  rebuild();
  for (const chart of collection.charts()) addChart(chart);
  scope.own(
    collection.subscribe((event) => {
      if (event.type === "added") addChart(event.chart);
      else if (event.type === "removed") removeChart(event.binding);
      else if (event.type === "bindingChanged") {
        removeChart(event.previous);
        const chart = collection
          .charts()
          .find((candidate) => ownerKey(candidate.binding.get()) === ownerKey(event.binding));
        if (chart) addChart(chart);
      }
    }),
  );
  return {
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const owner of [...owners.values()]) removeChart(owner.binding);
      scope.destroy();
      index.clear();
      links.clear();
    },
  };
}
