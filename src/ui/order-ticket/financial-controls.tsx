import { useFinancialLease } from "../financial-lease.js";
import { cryptoTicketMode } from "../../core/capabilities.js";
import type { TradingQuoteSnapshot } from "../../contracts/ports.js";
import type { LeverageInfo } from "../../contracts/broker.js";
import type { LeverageRequest } from "../../core/leverage-commands.js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  on,
  Show,
} from "solid-js";
import type { TradingSession } from "../../core/session.js";
import type { TicketController } from "./controller.js";
import {
  cryptoBaseQuantity,
  cryptoQuoteAmount,
  instrumentTickValue,
  marginRequired,
  orderEntryPrice,
  orderNotional,
} from "../../core/financial-rules.js";
import { NumberField,
  TradingButton,
  useTradingValue,
  useTradingEntity, useAccountCurrency } from "../primitives.js";
export function TicketFinancialControls(props: {
  active: boolean;
  session: TradingSession;
  controller: TicketController;
  locale?: string;
  quote(): TradingQuoteSnapshot;
}) {
  const state = useTradingValue(props.controller.state),
    globalPolicy = useTradingValue(props.session.policy),
    connection = useTradingValue(props.session.state.connection);
  const availableMargin = useTradingValue(props.session.state.marginAvailable);
  const instrument = () => state().instrument,
    order = () => state().order;
  const policy = () => {
    globalPolicy();
    return props.session.symbolPolicy(order().symbol);
  };
  const informationVisible = () =>
    props.active &&
    props.session.features.order_info &&
    !!instrument() &&
    instrument()?.pipValue !== 0;
  const accountCurrency = useAccountCurrency(props.session);
  const quote = () => props.quote();
  const pipValues = useTradingEntity(
    props.session.state.pipValues,
    () => order().symbol,
  );
  const baseBalance = useTradingEntity(
      props.session.state.balances,
      () => instrument()?.baseCurrency ?? "",
    ),
    quoteBalance = useTradingEntity(
      props.session.state.balances,
      () => instrument()?.quoteCurrency ?? "",
    );
  const [quoteQuantity, setQuoteQuantity] = createSignal<number>();
  const [leverage, setLeverage] = createSignal<Readonly<LeverageInfo>>(),
    [leverageError, setLeverageError] = createSignal<string>(),
    [changingLeverage, setChangingLeverage] = createSignal(false),
    [leverageRevision, setLeverageRevision] = createSignal(0);
  const leverageLifetime = new AbortController();
  let pendingLeverage: AbortController | undefined;
  onCleanup(() => {
    leverageLifetime.abort();
    pendingLeverage?.abort();
  });
  const leverageRequest = createMemo<LeverageRequest | undefined>(
    () => {
      const current = state();
      if (
        !current.context ||
        !informationVisible() ||
        !policy().flags.supportLeverage
      )
        return undefined;
      return {
        context: current.context,
        params: {
          symbol: order().symbol,
          orderType: order().type,
          side: order().side,
          customFields: order().customFields,
        },
      };
    },
    undefined,
    {
      equals: (before, after) =>
        JSON.stringify(before) === JSON.stringify(after),
    },
  );
  createEffect(on(leverageRequest, () => pendingLeverage?.abort()));
  createEffect(
    on(
      () => [leverageRequest(), leverageRevision()] as const,
      ([request]) => {
        let active = true;
        onCleanup(() => {
          active = false;
        });
        setLeverage(undefined);
        setLeverageError(undefined);
        if (!request) return;
        void props.session.commands.leverageInfo(request).then(
          (info) => {
            if (active) setLeverage(info);
          },
          () => {
            if (active) setLeverageError("Leverage is unavailable.");
          },
        );
      },
    ),
  );
  async function changeLeverage(): Promise<void> {
    const request = leverageRequest();
    if (!request || changingLeverage()) return;
    const operation = new AbortController();
    pendingLeverage = operation;
    setChangingLeverage(true);
    setLeverageError(undefined);
    try {
      await props.session.requestLeverage(request, operation.signal);
      if (operation.signal.aborted || leverageRequest() !== request) return;
      await props.controller.refreshInstrument();
      setLeverageRevision((value) => value + 1);
    } catch {
      if (!operation.signal.aborted)
        setLeverageError("Leverage could not be opened. Try again.");
    } finally {
      if (!leverageLifetime.signal.aborted) setChangingLeverage(false);
    }
  }
  const crypto = () => cryptoTicketMode(policy(), instrument()?.type);
  const entry = () =>
    orderEntryPrice(
      order(),
      quote().status === "ready" ? quote().value : undefined,
    );
  const convertedQuantity = () => {
    const info = instrument();
    return info
      ? cryptoBaseQuantity(quoteQuantity() ?? NaN, entry(), info.qty)
      : undefined;
  };
  const notional = () => {
    const info = instrument();
    return info ? orderNotional(order().qty, entry(), info) : undefined;
  };
  const margin = () =>
    marginRequired(
      notional(),
      instrument()?.marginRate,
      instrument()?.currency,
      accountCurrency(),
    );
  const valueText = (value: number | undefined, currency?: string) =>
    value === undefined
      ? "Unavailable"
      : `${value.toLocaleString(props.locale ?? "en", { maximumFractionDigits: 8 })}${currency ? ` ${currency}` : ""}`;
  function financialDemand(
    kind: "margin" | "pip",
    enabled: () => boolean,
  ): void {
    const symbol = createMemo(() => {
      if (!instrument() || connection().phase !== "ready" || !enabled())
        return undefined;
      return order().symbol;
    });
    useFinancialLease(props.session, kind, symbol);
  }
  financialDemand(
    "margin",
    () => informationVisible() && policy().flags.supportMargin,
  );
  financialDemand("pip", () => informationVisible());
  const tickValue = () => {
    const info = instrument();
    return info
      ? instrumentTickValue(order().side, info, pipValues())
      : undefined;
  };
  const canMeter = () =>
    margin() !== undefined &&
    availableMargin() !== undefined &&
    availableMargin()! > 0;
  const overMargin = () =>
    margin() !== undefined &&
    availableMargin() !== undefined &&
    margin()! > availableMargin()!;

  return (
    <>
      <Show when={crypto()}>
        <section class="trading-protection" aria-label="Crypto quantity">
          <h3>Quote currency amount</h3>
          <NumberField
            label={`Amount in ${instrument()?.quoteCurrency ?? "quote currency"}`}
            value={quoteQuantity()}
            min={0}
            onChange={setQuoteQuantity}
          />
          <TradingButton
            disabled={convertedQuantity() === undefined}
            onClick={() => {
              const qty = convertedQuantity();
              if (qty !== undefined) props.controller.patch({ qty });
            }}
          >
            Apply quote amount
          </TradingButton>
          <p>
            {convertedQuantity() === undefined
              ? "A valid price and amount are needed."
              : `Base quantity: ${convertedQuantity()} ${instrument()?.baseCurrency ?? ""}`}
          </p>
          <p>
            Current quote value:{" "}
            {valueText(
              cryptoQuoteAmount(order().qty, entry()),
              instrument()?.quoteCurrency,
            )}
          </p>
          <Show when={policy().flags.supportBalances}>
            <dl class="trading-financial-summary">
              <For
                each={[
                  {
                    name: instrument()?.baseCurrency ?? "Base",
                    balance: baseBalance(),
                  },
                  {
                    name: instrument()?.quoteCurrency ?? "Quote",
                    balance: quoteBalance(),
                  },
                ]}
              >
                {(item) => (
                  <div title={item.balance?.longName}>
                    <dt>{item.name} available</dt>
                    <dd>{valueText(item.balance?.available)}</dd>
                    <dt>{item.name} total</dt>
                    <dd>{valueText(item.balance?.total)}</dd>
                    <Show when={item.balance?.reserved !== undefined}>
                      <dt>{item.name} reserved</dt>
                      <dd>{valueText(item.balance?.reserved)}</dd>
                    </Show>
                    <Show when={item.balance?.value !== undefined}>
                      <dt>{item.name} value</dt>
                      <dd>
                        {valueText(item.balance?.value, item.balance?.valueCurrency)}
                      </dd>
                    </Show>
                    <Show when={item.balance?.btcValue !== undefined}>
                      <dt>{item.name} BTC value</dt>
                      <dd>{valueText(item.balance?.btcValue, "BTC")}</dd>
                    </Show>
                  </div>
                )}
              </For>
            </dl>
          </Show>
        </section>
      </Show>
      <Show when={informationVisible()}>
        <section
          class="trading-protection trading-order-info"
          aria-label="Order information"
        >
          <h3>Order info</h3>
          <dl class="trading-financial-summary">
            <Show when={policy().flags.supportMargin}>
              <div class="trading-margin-summary">
                <dt>Margin used</dt>
                <dd>
                  {valueText(margin())} /{" "}
                  {valueText(availableMargin(), accountCurrency())}
                </dd>
                <Show when={canMeter()}>
                  <progress
                    class="trading-margin-meter"
                    aria-label="Estimated margin used"
                    aria-valuetext={`${valueText(margin(), accountCurrency())} of ${valueText(availableMargin(), accountCurrency())}`}
                    max={availableMargin()}
                    value={Math.min(margin()!, availableMargin()!)}
                    data-over-budget={overMargin()}
                  />
                </Show>
              </div>
            </Show>
            <Show when={policy().flags.supportLeverage}>
              <div>
                <dt>Leverage</dt>
                <dd>
                  <Show
                    when={policy().flags.supportLeverageButton}
                    fallback={
                      leverage() ? `1:${leverage()!.leverage}` : "Unavailable"
                    }
                  >
                    <TradingButton
                      disabled={
                        !leverage() || changingLeverage() || state().refreshing
                      }
                      onClick={() => {
                        void changeLeverage();
                      }}
                    >
                      {leverage() ? `1:${leverage()!.leverage}` : "Unavailable"}
                    </TradingButton>
                  </Show>
                </dd>
              </div>
            </Show>
            <div>
              <dt>Tick value</dt>
              <dd>{valueText(tickValue(), accountCurrency())}</dd>
            </div>
            <div>
              <dt>{state().options?.showTotal ? "Total" : "Trade value"}</dt>
              <dd>{valueText(notional(), instrument()?.currency)}</dd>
            </div>
          </dl>
          <Show when={leverageError()}>
            <p role="alert">{leverageError()}</p>
          </Show>
          <Show when={policy().flags.supportMargin && overMargin()}>
            <p class="trading-warning" role="status">
              The estimated margin exceeds the available amount.
            </p>
          </Show>
        </section>
      </Show>
    </>
  );
}
