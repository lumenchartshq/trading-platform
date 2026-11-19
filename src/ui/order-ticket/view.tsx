import { useEffectiveMode, type ModeSelection } from "../effective-mode.js";
import { effectiveQuantityMode } from "./mode-rules.js";
import { CustomField } from "./custom-field.js";
import { UntradableNotice } from "./untradable-notice.js";
import { SubmitBar } from "./submit-bar.js";
import { ReviewPanel } from "./review-panel.js";
import { OrderSent } from "./order-sent.js";
import { locked as ticketLocked, bracketsAllowed as ticketBracketsAllowed, riskAllowed as ticketRiskAllowed,
  phaseText as ticketPhaseText, ticketCanStartNext, submitAction as ticketSubmitAction, priceSuffix, typeName } from "./rules.js";
import { CloseIcon } from "../icons.js";
import { TradingTabs } from "../tabs.js";
import { TicketSymbolSearch } from "./symbol-search.js";
import type { TradingSymbolSearchResult } from "../../contracts/ports.js";

import { symbolLabel } from "../../core/features.js";

import { TicketMoveHandle } from "./move-handle.js";
import {
  isRiskQuantityMode,
  type QuantityInputMode,
} from "../../core/quantity-input.js";
import { defaultBracketPrice } from "../../core/bracket-input.js";
import { OrderTicketMenu } from "./menu.js";
import { TicketPriceInput } from "./price-input.js";
import { TicketQuantityInput } from "./quantity-input.js";
import { TicketFinancialControls } from "./financial-controls.js";
import { TicketProtectionWorkspace } from "../protection/ticket-workspace.js";
import { orderEntryPrice } from "../../core/financial-rules.js";
import { ticketShowsPreview } from "../../core/review-policy.js";
import { protectionDirectionError } from "../../core/protection-rules.js";
import { useTicketMarket } from "./market.js";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import type { Tradability } from "../../core/tradability.js";
import {
  OrderType,
  Side,
  StopType,
} from "../../contracts/broker.js";

import type { TradingSession } from "../../core/session.js";
import type { TicketController } from "./controller.js";
import { durationOptions as availableDurations } from "../../core/order-duration.js";
import { DurationInput } from "./duration-input.js";
import {
  ChildQuantityField,
  ModificationSummary,
  TrailingDistanceField,
} from "./modification-fields.js";
import {
  TradingButton,
  useTradingValue,
  useTradingEntity,
} from "../primitives.js";
export function OrderTicketView(props: {
  active?: boolean;
  session: TradingSession;
  controller: TicketController;
  locale?: string;
  timezone?: string;
  /** Show another symbol on the ticket's chart (a broker "change symbol" solution). */
  requestSymbol?: (symbol: string) => void;
  /** `supportSymbolSearch`: datafeed search and reopening this ticket for the chosen symbol. */
  searchSymbolsPage?: import("../../contracts/ports.js").TradingPresentationPort["searchSymbolsPage"];
  searchSymbols?: (query: string) => Promise<readonly TradingSymbolSearchResult[]>;
  changeSymbol?: (symbol: string) => void;
}) {
  const [editingExits, setEditingExits] = createSignal(false);
  let draftForm!: HTMLFormElement;
  let reviewTitle!: HTMLHeadingElement;
  const [quantitySelection, setQuantitySelection] = createSignal<ModeSelection<QuantityInputMode>>({ mode: "units", revision: 0 });
  const setQuantityMode = (mode: QuantityInputMode) => setQuantitySelection(previous => ({ mode, revision: previous.revision + 1 }));
  const settings = useTradingValue(props.session.ticketSettings);
  const state = useTradingValue(props.controller.state);
  const connection = useTradingValue(props.session.state.connection);
  const globalPolicy = useTradingValue(props.session.policy);
  const order = () => state().order;
  const directionError = () => protectionDirectionError(order(), order().side, orderEntryPrice(order(), market.ready()));
  const market = useTicketMarket(
    props.session,
    () => order().symbol,
    () => props.active !== false,
  );
  const policy = () => {
    globalPolicy();
    return props.session.symbolPolicy(order().symbol);
  };
  const busy = () =>
    state().refreshing ||
    state().phase === "loading" ||
    state().phase === "sending" ||
    state().phase === "previewing";
  const formVisible = () =>
    props.active !== false &&
    !["confirming", "sending", "confirmed", "unconfirmed"].includes(
      state().phase,
    );
  const canFocusTicket = () => {
    const current = props.session.dialogs.current.get();
    return !current || current.request.kind === "order";
  };
  createEffect(
    on(
      () => state().phase,
      (phase) => {
        if (phase !== "confirming") return;
        queueMicrotask(() => {
          if (
            state().phase === "confirming" &&
            reviewTitle?.isConnected &&
            canFocusTicket()
          )
            reviewTitle.focus();
        });
      },
    ),
  );
  const editOrder = () => {
    props.controller.patch({});
    queueMicrotask(() => {
      if (!formVisible() || !draftForm?.isConnected || !canFocusTicket())
        return;
      const target =
        draftForm.querySelector<HTMLElement>(
          '[aria-label="Quantity type"]:not(:disabled)',
        ) ??
        draftForm.querySelector<HTMLElement>(
          'input:not(:disabled), button[type="submit"]:not(:disabled)',
        );
      target?.focus();
    });
  };
  const unavailable = () => connection().phase !== "ready";
  const limit = () =>
    order().type === OrderType.Limit || order().type === OrderType.StopLimit;
  const stop = () =>
    order().type === OrderType.Stop || order().type === OrderType.StopLimit;
  const modifying = () => "id" in order();
  const bracketsAllowed = () => ticketBracketsAllowed(policy(), order(), state().instrument?.type);
  const bracketsDisabled = () => locked("brackets");
  const riskAllowed = () => ticketRiskAllowed(policy(), order(), state().instrument, props.session.features.order_info);
  const quantityMode = useEffectiveMode(quantitySelection, mode => effectiveQuantityMode(mode, riskAllowed(), order().stopLoss ?? order().guaranteedStop));
  const updateStopLoss = props.controller.setStopLoss;
  const suggestedStopLoss = () => {
    if (!riskAllowed() || !policy().flags.supportStopLoss || bracketsDisabled())
      return undefined;
    return (
      props.controller.rememberedStopLoss() ??
      defaultBracketPrice(false, {
        entry: orderEntryPrice(order(), market.ready()),
        side: order().side,
        instrument: state().instrument!,
      })
    );
  };
  const brokerOrder = useTradingEntity(props.session.state.orders, () => {
    const current = order();
    return "id" in current ? current.id : "";
  });
  /** Broker-metadata editability of the order being modified; undefined for a new order. */
  const editability = () => {
    globalPolicy();
    const current = brokerOrder();
    if (!modifying() || !current) return undefined;
    return props.session.orderEditability(current);
  };
  const locked = (field: "price" | "qty" | "type" | "duration" | "brackets") =>
    ticketLocked(modifying(), editability(), field);
  const protectionChild = () => !!editability()?.protection;
  const trailingChild = () =>
    protectionChild() && brokerOrder()?.stopType === StopType.TrailingStop;
  const reportedTrailingPrice = () => {
    const price =
      brokerOrder()?.trailingStopPrice ??
      (trailingChild() ? brokerOrder()?.stopPrice : undefined);
    return price !== undefined && Number.isFinite(price) ? price : undefined;
  };
  const durationOptions = () =>
    availableDurations(policy(), order().type, state().instrument);
  const custom = (id: string, value: unknown) =>
    props.controller.patch({
      customFields: { ...order().customFields, [id]: value },
    });
  const toggleRelativePrice = () => {
    void props.session.host
      .setOrderTicketSetting(
        "showRelativePriceControl",
        !settings().showRelativePriceControl,
      )
      .catch(() =>
        props.session.host.showNotification(
          "Order ticket",
          "Your display choice could not be saved.",
        ),
      );
  };
  const [tradability] = createResource(
    () => (props.active !== false && !modifying() ? order().symbol : undefined),
    (symbol) => props.session.tradability(symbol),
  );
  /** Commands still enforce tradability; an unreadable status leaves the form usable. */
  const untradable = (): Tradability | undefined => {
    if (tradability.state !== "ready") return undefined;
    const value = tradability();
    return value.tradable ? undefined : value;
  };
  const [solutionError, setSolutionError] = createSignal<string>();
  function solve(value: Tradability): void {
    setSolutionError(undefined);
    const solution = value.solution;
    if (!solution) {
      props.controller.close();
      return;
    }
    if (solution.kind === "account") {
      void props.session.commands
        .selectAccount(solution.accountId)
        .catch(() => setSolutionError("The account could not be changed."));
    } else if (solution.kind === "symbol") props.requestSymbol?.(solution.symbol);
    else
      draftForm.ownerDocument.defaultView?.open(
        solution.url,
        "_blank",
        "noopener,noreferrer",
      );
  }
  const solutionLabel = (value: Tradability) => {
    const solution = value.solution;
    if (!solution) return value.buttonText ?? "OK";
    if (solution.kind === "account") return "Change account";
    if (solution.kind === "symbol") return `Show ${solution.symbol}`;
    return solution.text;
  };
  const symbolSearch = () => {
    const search = props.searchSymbols, choose = props.changeSymbol;
    if (!search || !choose || modifying()) return undefined;
    if (!policy().flags.supportSymbolSearch) return undefined;
    return { search, choose };
  };
  const title = () => ("id" in order() ? "Modify order" : "Order ticket");
  const displaySymbol = () =>
    symbolLabel(order().symbol, props.session.features, state().instrument?.brokerSymbol);
  const phaseText = () => ticketPhaseText(state().phase, modifying(), state().checking === true, state().accepted === true);
  // Reading the settings and policy subscriptions keeps the label reactive; the rule is shared with the controller.
  const submitAction = () => {
    settings();
    globalPolicy();
    return ticketSubmitAction(
      ticketShowsPreview(props.session, order().symbol, modifying()),
      props.session.confirmationRequired,
      modifying(),
    );
  };
  const sideName = () => (order().side === Side.Buy ? "Buy" : "Sell");
  const orderDescription = () => {
    const suffix = priceSuffix(order(), market.price);
    return `${sideName()} ${typeName(order().type)} ${order().qty}${suffix}`;
  };
  const submitSummary = () => {
    const suffix = priceSuffix(order(), market.price);
    return `${order().qty} ${displaySymbol()}${suffix} ${typeName(order().type).toUpperCase()}`;
  };
  return (
    <section data-ui="trading-ticket" aria-label={title()}>
      <header
        hidden={editingExits()}
        class="trading-panel-header trading-ticket-header"
      >
        <TicketMoveHandle
          symbol={displaySymbol()}
          description={state().instrument?.description}
        />
        <span class="trading-visually-hidden">{title()}</span>
        <div class="trading-ticket-header-actions">
          <OrderTicketMenu
            session={props.session}
            previewAvailable={
              policy().flags.supportPlaceOrderPreview ||
              policy().flags.supportModifyOrderPreview
            }
          />
          <Show when={props.session.features.order_panel_close_button}>
            <TradingButton
              aria-label="Close order ticket"
              class="trading-icon-button"
              onClick={() => props.controller.close()}
            >
              <CloseIcon />
              <span class="trading-visually-hidden">Close</span>
            </TradingButton>
          </Show>
        </div>
      </header>
      <Show when={symbolSearch()}>
        {(search) => (
          <TicketSymbolSearch
            clock={props.session.clock}
            search={search().search}
            searchPage={props.searchSymbolsPage}
            choose={search().choose}
            disabled={busy()}
          />
        )}
      </Show>
      {/* The ticket's own rules validate every field, so a zero quantity and an empty one get the same kind of message. */}
      <form
        ref={draftForm}
        hidden={!formVisible()}
        class="trading-ticket-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!editingExits()) void props.controller.review();
        }}
      >
        <fieldset disabled={busy() || unavailable()}>
          <legend class="trading-visually-hidden">Order details</legend>
          <div class="trading-ticket-main-fields" hidden={editingExits()}>
            <Show when={modifying() && brokerOrder() && editability()}>
              <ModificationSummary
                order={brokerOrder()!}
                editability={editability()!}
                typeName={typeName(brokerOrder()!.type)}
                symbol={displaySymbol()}
                price={market.price}
              />
            </Show>
            <Show when={untradable()}>
              {(value) => (
                <UntradableNotice value={value()} canChangeSymbol={!!props.requestSymbol}
                  error={solutionError()} label={solutionLabel(value())} solve={() => solve(value())} />
              )}
            </Show>
            <Show when={policy().symbol.warningMessage}>
              {(message) => (
                <p role="note" class="trading-warning">
                  {message()}
                </p>
              )}
            </Show>
            <div class="trading-side-controls" hidden={modifying()}>
              <TradingButton
                tone="sell"
                aria-pressed={order().side === Side.Sell}
                aria-label="Sell"
                onClick={() => props.controller.patch({ side: Side.Sell })}
              >
                <span>Sell</span>
                <strong>{market.price(market.ready()?.bid)}</strong>
              </TradingButton>
              <TradingButton
                tone="buy"
                aria-pressed={order().side === Side.Buy}
                aria-label="Buy"
                onClick={() => props.controller.patch({ side: Side.Buy })}
              >
                <span>Buy</span>
                <strong>{market.price(market.ready()?.ask)}</strong>
              </TradingButton>
              <span class="trading-quote-spread">
                <span class="trading-visually-hidden">Spread </span>
                {market.spread()}
              </span>
            </div>
            <TradingTabs
              class="trading-type-tabs"
              label="Order type"
              hidden={locked("type")}
              disabled={locked("type")}
              value={order().type}
              tabs={policy().orderTypes.map((type) => ({
                value: type,
                label: typeName(type),
              }))}
              onChange={(type) => props.controller.changeType(type)}
            />
            <Show when={state().instrument}>
              <Show when={limit() && !locked("price")}>
                <TicketPriceInput
                  relative={settings().showRelativePriceControl}
                  toggleRelative={toggleRelativePrice}
                  kind="limit"
                  label={stop() ? "Limit price" : "Price"}
                  value={order().limitPrice}
                  instrument={state().instrument!}
                  side={order().side}
                  quotes={market.ready()}
                  price={market.price}
                  disabled={locked("price")}
                  update={(limitPrice) =>
                    props.controller.patch({ limitPrice })
                  }
                />
              </Show>
              <Show when={stop() && !locked("price") && !trailingChild()}>
                <TicketPriceInput
                  relative={settings().showRelativePriceControl}
                  toggleRelative={toggleRelativePrice}
                  kind="stop"
                  label={limit() ? "Stop price" : "Price"}
                  value={order().stopPrice}
                  instrument={state().instrument!}
                  side={order().side}
                  quotes={market.ready()}
                  price={market.price}
                  disabled={locked("price")}
                  update={(stopPrice) => props.controller.patch({ stopPrice })}
                />
              </Show>
              <Show when={trailingChild()}>
                <TrailingDistanceField
                  distance={order().trailingStopPips}
                  reportedPrice={reportedTrailingPrice()}
                  disabled={!editability()?.trailingDistance || busy()}
                  price={market.price}
                  update={(trailingStopPips) =>
                    props.controller.patch({
                      trailingStopPips: trailingStopPips ?? NaN,
                    })
                  }
                />
              </Show>
              <Show when={protectionChild() && !locked("qty")}>
                <ChildQuantityField
                  qty={order().qty}
                  disabled={busy()}
                  update={(qty) => props.controller.patch({ qty: qty ?? NaN })}
                />
              </Show>
              <Show when={!protectionChild() && !locked("qty")}>
              <TicketQuantityInput
                session={props.session}
                active={formVisible() && !editingExits()}
                symbol={order().symbol}
                side={order().side}
                stop={order().stopLoss ?? order().guaranteedStop}
                riskAllowed={riskAllowed()}
                multipleExits={!!order().exitLevels?.length}
                suggestedStop={suggestedStopLoss()}
                enableStop={updateStopLoss}
                updateSizing={props.controller.patchSizedQuantity}
                onManualQuantityChange={props.controller.onManualQuantityChange}
                mode={quantityMode()}
                fallbackMode={quantitySelection().mode !== quantityMode() ? quantitySelection().mode : undefined}
                onModeChange={setQuantityMode}
                label={
                  policy().flags.showQuantityInsteadOfAmount
                    ? "Quantity"
                    : "Amount"
                }
                qty={order().qty}
                instrument={state().instrument!}
                locale={props.locale}
                entry={orderEntryPrice(order(), market.ready())}
                disabled={
                  !formVisible() ||
                  editingExits() ||
                  busy() ||
                  unavailable() ||
                  locked("qty")
                }
                update={(qty) => props.controller.patch({ qty })}
              />
              </Show>
            </Show>
          </div>
          <Show
            when={bracketsAllowed() && !protectionChild() && state().instrument}
          >
            <TicketProtectionWorkspace
              onEditingChange={setEditingExits}
              orderDescription={orderDescription()}
              closeTicket={
                props.session.features.order_panel_close_button
                  ? props.controller.close
                  : undefined
              }
              active={formVisible()}
              session={props.session}
              policy={policy()}
              brackets={order()}
              quantity={order().qty}
              target="order"
              symbol={order().symbol}
              side={order().side}
              instrument={state().instrument!}
              entry={orderEntryPrice(order(), market.ready())}
              disabled={bracketsDisabled() || busy() || !formVisible()}
              modifying={modifying()}
              stopMoneyAllowed={!isRiskQuantityMode(quantityMode())}
              reportedTrailingPrice={reportedTrailingPrice()}
              maximum={state().options?.maxExitLevelsCount}
              price={market.price}
              update={props.controller.patchProtection}
            />
          </Show>
          <div class="trading-ticket-main-fields" hidden={editingExits()}>
            <Show when={!protectionChild()}>
            <DurationInput
              options={durationOptions()}
              value={order().duration}
              timezone={props.timezone ?? "UTC"}
              now={props.session.clock.now}
              disabled={locked("duration")}
              update={(duration) => props.controller.patch({ duration })}
            />
            </Show>
            <TicketFinancialControls
              active={formVisible()}
              session={props.session}
              controller={props.controller}
              locale={props.locale}
              quote={market.quote}
            />
            <For each={state().options?.customFields}>
              {(field) => (
                <CustomField
                  field={field}
                  disabled={busy()}
                  modifying={modifying()}
                  value={order().customFields?.[field.id]}
                  update={(value) => custom(field.id, value)}
                />
              )}
            </For>
          </div>
        </fieldset>
        <SubmitBar modifying={modifying()} hidden={editingExits()} busy={busy()}
          unavailable={unavailable() || !!directionError()} untradable={!!untradable()} hasBrokerOrder={!!brokerOrder()}
          side={order().side} action={submitAction()} summary={submitSummary()} discard={props.controller.close} />
      </form>
      <Show when={state().phase === "confirming"}>
        <ReviewPanel order={order()} displaySymbol={displaySymbol()} preview={state().preview}
          unavailable={unavailable()} titleRef={(element) => { reviewTitle = element; }}
          edit={editOrder} send={props.controller.send} />
      </Show>
      <Show when={state().phase === "confirmed" && !modifying()}>
        <OrderSent summary={submitSummary()} startNext={props.controller.startNext} />
      </Show>
      <Show when={unavailable()}>
        <p role="status">Reconnect to trade with this account.</p>
      </Show>
      <Show when={state().error}>
        <p role="alert" class="trading-error">
          {state().error}
        </p>
      </Show>
      <p role="status" aria-live="polite">
        {phaseText()}
      </p>
      <Show when={ticketCanStartNext(state()) && (modifying() || state().phase === "unconfirmed")}>
        <div class="trading-next-order" data-ui="start-next-order">
          <TradingButton tone="primary" onClick={() => props.controller.startNext()}>
            Start creating order
          </TradingButton>
        </div>
      </Show>
    </section>
  );
}
