import { ticketSkipsReview } from "../../core/review-policy.js";
import { Show, useContext } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import type { OrderType } from "../../contracts/broker.js";
import type { TradingSession } from "../../core/session.js";
import type { TradingChartPort } from "../../contracts/ports.js";
import type { TicketController } from "./controller.js";
import { TradingButton, useTradingValue } from "../primitives.js";
import { TradingSelect } from "../select.js";
import { sameBinding } from "../../core/identity.js";
import { ticketEditable, typeName } from "./rules.js";
import { TradingDialogPopupMount, TradingPopupMount } from "../popup-mount.js";
export function ChartDraftControls(props: {
  session: TradingSession;
  chart: TradingChartPort;
  ticket: TicketController;
}) {
  const state = useTradingValue(props.ticket.state);
  const popupMount = useContext(TradingPopupMount);
  let popoverContent: HTMLDivElement | undefined;
  const settings = useTradingValue(props.session.ticketSettings);
  const binding = useTradingValue(props.chart.binding);
  const active = () =>
    !("id" in state().order) && ticketEditable(state().phase) && sameBinding(state().binding, binding());
  // The settings subscription keeps the label reactive; the rule itself is shared with the controller.
  const submitLabel = () => {
    settings();
    return ticketSkipsReview(props.session, state().order.symbol, false) ? "Place projected order" : "Review projected order";
  };
  const types = () => props.session.symbolPolicy(state().order.symbol).orderTypes;
  return (
    <Show when={active()}>
      <Popover placement="bottom-start" gutter={4}>
        <Popover.Trigger class="trading-button trading-draft-trigger" data-ui="trading-draft-controls">
          Order draft
        </Popover.Trigger>
        <Popover.Portal mount={popupMount}>
          <Popover.Content ref={popoverContent} class="lumen-trading trading-draft-popover">
            <TradingDialogPopupMount.Provider value={() => popoverContent}>
              <Popover.Title class="trading-draft-title">Order draft</Popover.Title>
              <div role="group" aria-label="Projected order">
                <div style={{ width: "100px" }}>
                  <TradingSelect
                    label="Projected order type"
                    value={String(state().order.type)}
                    options={types().map((type) => ({
                      value: String(type),
                      label: typeName(type),
                    }))}
                    onChange={(value) => props.ticket.changeType(Number(value) as OrderType)}
                  />
                </div>
                <input
                  class="trading-input"
                  aria-label="Projected quantity"
                  type="number"
                  style={{ width: "64px" }}
                  value={state().order.qty}
                  min={state().instrument?.qty.min}
                  max={state().instrument?.qty.max}
                  step={state().instrument?.qty.step ?? 1}
                  onInput={(event) => props.ticket.patch({ qty: event.currentTarget.valueAsNumber })}
                />
                <TradingButton onClick={() => props.ticket.review()}>{submitLabel()}</TradingButton>
                <TradingButton onClick={() => props.ticket.close()}>Discard projected order</TradingButton>
              </div>
            </TradingDialogPopupMount.Provider>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  );
}
