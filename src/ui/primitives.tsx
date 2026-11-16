import { parseNumberInput } from "./number-input.js";
import type { IWatchedValueReadonly } from "../contracts/broker.js";
import type { EntityReader } from "../core/entity-store.js";
import type { TradingSession } from "../core/session.js";
import { Button } from "@kobalte/core/button";
import { createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { ReadonlyValue } from "../contracts/ports.js";
export function useTradingValue<T>(
  reader: ReadonlyValue<T>,
  beforeChange?: (previous: T, next: T) => void,
): () => T {
  let previous = reader.get();
  const [value, setValue] = createSignal(previous);
  const release = reader.subscribe((next) => {
    beforeChange?.(previous, next);
    previous = next;
    setValue(() => next);
  });
  setValue(() => reader.get());
  onCleanup(release);
  return value;
}
/** Bridge broker watched values into Solid; release only this consumer's listener. */
export function useWatchedValue<T>(reader: IWatchedValueReadonly<T>): () => T {
  const [value, setValue] = createSignal(reader.value());
  const changed = (next: T) => setValue(() => next);
  reader.subscribe(changed);
  setValue(() => reader.value());
  onCleanup(() => reader.unsubscribe(changed));
  return value;
}
/** Track only the selected entity's changes, not the full collection. */
/** The selected account's metadata, following account changes. */
export function useCurrentAccount(session: TradingSession) {
  const accounts = useTradingValue(session.accounts);
  const connection = useTradingValue(session.state.connection);
  return createMemo(() => accounts().find((account) => account.id === connection().accountId));
}
/** The selected account's currency; the one lookup every money display uses. */
export function useAccountCurrency(session: TradingSession) {
  const account = useCurrentAccount(session);
  return createMemo(() => account()?.currency);
}
export function useTradingEntity<T extends { id: string }>(
  reader: EntityReader<T>,
  key: () => string,
) {
  const [revision, setRevision] = createSignal(0);
  onCleanup(
    reader.subscribeChanges((change) => {
      const id = key();
      if (
        change.added.includes(id) ||
        change.updated.includes(id) ||
        change.removed.includes(id)
      )
        setRevision((value) => value + 1);
    }),
  );
  return createMemo(() => {
    revision();
    return reader.get(key());
  });
}
export function TradingButton(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    tone?: "buy" | "sell" | "primary";
  },
) {
  return (
    <Button
      {...props}
      class={`trading-button ${props.class ?? ""}`}
      data-tone={props.tone}
    >
      {props.children}
    </Button>
  );
}
export function NumberField(props: {
  label: string;
  value?: number;
  disabled?: boolean;
  step?: number;
  min?: number;
  max?: number;
  onChange(value: number | undefined): void;
  help?: string;
}) {
  return (
    <label class="trading-field">
      <span>{props.label}</span>
      <input
        type="number"
        inputmode="decimal"
        value={Number.isFinite(props.value) ? props.value : ""}
        step={props.step ?? "any"}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        onInput={(event) =>
          props.onChange(
            parseNumberInput(event.currentTarget.value),
          )
        }
      />
      <small>{props.help}</small>
    </label>
  );
}
