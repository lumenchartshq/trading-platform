import { hasStop } from "../../core/bracket-input.js";
import { Show } from "solid-js";
import type {
  Brackets,
  InstrumentInfo,
  Side,
  StopType,
} from "../../contracts/broker.js";
import type { CapabilityPolicy } from "../../core/capabilities.js";
import type { TradingSession } from "../../core/session.js";
import { ExitInput } from "../order-ticket/exit-input.js";
import { StopProtectionInput } from "../order-ticket/stop-input.js";

export interface ProtectionFieldsProps {
  active: boolean;
  session: TradingSession;
  policy: CapabilityPolicy;
  symbol: string;
  side: Side;
  quantity: number;
  brackets: Readonly<Brackets>;
  instrument: InstrumentInfo;
  entry?: number;
  /** Price TP/SL must sit around when it is not the entry (positions use the current price). */
  directionReference?: { readonly price: number | undefined; readonly name: string };
  disabled: boolean;
  modifying: boolean;
  stopMoneyAllowed: boolean;
  paired?: boolean;
  reportedTrailingPrice?: number;
  price(value: number | undefined): string;
  update(value: Brackets & { stopType?: StopType }): void;
}
/** Ticket and position editors share canonical price, currency and stop-style controls. */
export function ProtectionFields(props: ProtectionFieldsProps) {
  const money = () => props.policy.symbol.supportRiskControlsAndInfo !== false;
  const stopShown = () => hasStop(props.brackets);
  return (
    <>
      <ExitInput
        active={props.active}
        session={props.session}
        symbol={props.symbol}
        quantity={props.quantity}
        inInstrumentCurrency={props.policy.flags.showRiskInInstrumentCurrency}
        allowMoney={money()}
        label="Take profit"
        profit
        side={props.side}
        value={props.brackets.takeProfit}
        entry={props.entry}
        directionReference={props.directionReference}
        instrument={props.instrument}
        disabled={props.disabled}
        toggleDisabled={props.paired && props.brackets.takeProfit !== undefined}
        allowDistance={props.policy.symbol.supportBracketsInPips !== false}
        price={props.price}
        update={(takeProfit) => props.update({ takeProfit })}
      />
      <Show
        when={
          props.policy.flags.supportStopLoss ||
          props.policy.flags.supportGuaranteedStop ||
          props.policy.flags.supportTrailingStop
        }
      >
        <StopProtectionInput
          active={props.active}
          session={props.session}
          symbol={props.symbol}
          quantity={props.quantity}
          inInstrumentCurrency={props.policy.flags.showRiskInInstrumentCurrency}
          allowMoney={money() && props.stopMoneyAllowed}
          side={props.side}
          order={props.brackets}
          policy={props.policy}
          modifying={props.modifying}
          reportedTrailingPrice={props.reportedTrailingPrice}
          entry={props.entry}
          directionReference={props.directionReference}
          instrument={props.instrument}
          disabled={props.disabled}
          toggleDisabled={props.paired && stopShown()}
          allowDistance={props.policy.symbol.supportBracketsInPips !== false}
          price={props.price}
          updateProtection={props.update}
        />
      </Show>
    </>
  );
}
