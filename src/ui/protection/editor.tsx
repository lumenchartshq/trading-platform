import { ProtectedSizeSummary } from "./protected-size.js";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { StopType } from "../../contracts/broker.js";
import type {
  Brackets,
  ExitLevel,
} from "../../contracts/broker.js";
import {
  appendExitLevel,
  legacyExitLevel,
  minimumExitQuantity,
  removeExitLevel,
} from "../../core/exit-level-draft.js";
import { defaultBracketPrice, defaultExitDistance, hasStop, bracketStopType } from "../../core/bracket-input.js";
import { TradingError } from "../../core/errors.js";
import { ProtectionFields } from "./fields.js";
import type { ProtectionFieldsProps } from "./fields.js";
import { ExitLevelEditor } from "./level.js";
import { TradingButton } from "../primitives.js";

type Fields = Omit<
  ProtectionFieldsProps,
  "brackets" | "quantity" | "paired" | "update"
>;
export type ProtectionEditorProps = Fields & {
  brackets: Readonly<Brackets>;
  quantity: number;
  target: "order" | "position";
  maximum?: number;
  update(value: Brackets & { stopType?: StopType }): void;
  /** Summary mode opens a staged ticket workspace instead of changing the parent draft. */
  editLevels?(levels: ExitLevel[]): void;
  workspace?: boolean;
};
export function ProtectionEditor(props: ProtectionEditorProps) {
  const prefix = createUniqueId();
  let sequence = 0;
  const id = () => `${prefix}-exit-${++sequence}`;
  const rootId = id();
  const [expanded, setExpanded] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const levels = () => props.brackets.exitLevels ?? [];
  const multiple = () => levels().length > 0;
  const byId = createMemo(
    () => new Map(levels().map((level) => [level.id, level])),
  );
  const ids = createMemo(() => levels().map((level) => level.id), undefined, {
    equals: (previous, next) =>
      previous.length === next.length &&
      previous.every((value, index) => value === next[index]),
  });
  const disabled = () =>
    props.disabled ||
    (multiple() && !props.policy.flags.supportMultipleExitLevels);
  const pairOnlyRoot = () =>
    props.target === "position"
      ? props.policy.flags.supportOnlyPairPositionBrackets
      : props.policy.flags.supportOnlyPairOrderBrackets;
  const paired = () =>
    props.target === "position" ||
    !props.policy.flags.supportUnpairedExitLevels ||
    pairOnlyRoot();
  const count = () => (multiple() ? levels().length : 1);
  const canAdd = () =>
    props.policy.flags.supportMultipleExitLevels &&
    !disabled() &&
    (props.maximum === undefined || count() < props.maximum);
  function write(next: ExitLevel[]): void {
    setError(undefined);
    props.update({
      exitLevels: next.length ? next : undefined,
      takeProfit: undefined,
      stopLoss: undefined,
      guaranteedStop: undefined,
      trailingStopPips: undefined,
      stopType: undefined,
    });
  }
  function patch(key: string, value: Partial<ExitLevel>): void {
    write(
      levels().map((level) =>
        level.id === key ? { ...level, ...value, id: level.id } : level,
      ),
    );
  }
  /** New legs start a default distance from the validation reference (current price for positions). */
  function defaultPair(source: Readonly<Brackets>): Brackets {
    const price = (profit: boolean) =>
      defaultBracketPrice(profit, {
        entry: props.directionReference?.price ?? props.entry,
        side: props.side,
        instrument: props.instrument,
      });
    const takeProfit = source.takeProfit ?? price(true);
    const stop =
      source.stopLoss ?? source.guaranteedStop ?? source.trailingStopPips;
    const result: Brackets = {
      takeProfit,
      stopLoss: source.stopLoss,
      guaranteedStop: source.guaranteedStop,
      trailingStopPips: source.trailingStopPips,
    };
    if (stop === undefined) {
      if (props.policy.flags.supportStopLoss)
        result.stopLoss = price(false);
      else if (props.policy.flags.supportGuaranteedStop)
        result.guaranteedStop = price(false);
      else if (props.policy.flags.supportTrailingStop)
        result.trailingStopPips = defaultExitDistance(false);
    }
    if (
      result.takeProfit === undefined ||
      !hasStop(result)
    )
      throw new TradingError(
        "invalid-input",
        "A current entry price is needed to add exit levels.",
      );
    return result;
  }
  function updateRoot(value: Brackets & { stopType?: StopType }): void {
    setError(undefined);
    if (!pairOnlyRoot()) {
      props.update(value);
      return;
    }
    try {
      props.update({
        ...value,
        ...defaultPair({ ...props.brackets, ...value }),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Exit protection could not be changed.",
      );
    }
  }
  function add(): void {
    if (!canAdd()) return;
    try {
      const current = multiple()
        ? levels()
        : [
            legacyExitLevel(
              defaultPair(props.brackets),
              props.quantity,
              rootId,
            ),
          ];
      const candidate: ExitLevel = {
        ...defaultPair(current.at(-1) ?? {}),
        id: id(),
        qty: minimumExitQuantity(props.instrument.qty),
        isExisting: false,
      };
      const next = appendExitLevel(
        current,
        candidate,
        props.quantity,
        props.instrument.qty,
        props.maximum,
      );
      if (props.editLevels) props.editLevels(next);
      else {
        write(next);
        setExpanded(candidate.id);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Another exit level could not be added.",
      );
    }
  }
  function useSingle(): void {
    const level = levels()[0];
    if (
      !level ||
      levels().length !== 1 ||
      level.qty !== props.quantity ||
      disabled()
    )
      return;
    const stopType = bracketStopType(level);
    setError(undefined);
    props.update({
      exitLevels: undefined,
      takeProfit: level.takeProfit,
      stopLoss: level.stopLoss,
      guaranteedStop: level.guaranteedStop,
      trailingStopPips: level.trailingStopPips,
      stopType,
    });
  }
  return (
    <details class="trading-protection trading-exits" open>
      <summary>Exits</summary>
      <Show
        when={multiple()}
        fallback={
          <>
            <ProtectionFields
              {...props}
              brackets={props.brackets}
              quantity={props.quantity}
              paired={pairOnlyRoot()}
              update={updateRoot}
            />
            <Show
              when={
                pairOnlyRoot() &&
                (props.brackets.takeProfit !== undefined || hasStop(props.brackets))
              }
            >
              <TradingButton disabled={disabled()} onClick={() => write([])}>
                Remove exits
              </TradingButton>
            </Show>
          </>
        }
      >
        <Show
          when={!props.editLevels}
          fallback={
            <div class="trading-exit-summaries">
              <ProtectedSizeSummary
                protectedQuantity={levels().reduce((sum, level) => sum + level.qty, 0)}
                quantity={props.quantity}
              />
              <For each={levels()}>
                {(level, index) => (
                  <div class="trading-exit-summary">
                    <span>
                      Level {index() + 1} · {level.qty}{" "}
                      {props.instrument.units ?? "units"}
                    </span>
                    <span>Take profit {props.price(level.takeProfit)}</span>
                    <span>
                      Stop loss{" "}
                      {props.price(level.stopLoss ?? level.guaranteedStop)}
                    </span>
                  </div>
                )}
              </For>
              <TradingButton
                disabled={disabled()}
                onClick={() =>
                  props.editLevels?.(structuredClone([...levels()]))
                }
              >
                Edit exit levels
              </TradingButton>
            </div>
          }
        >
          <For each={ids()}>
            {(key, index) => {
              const level = () => byId().get(key)!;
              return (
                <ExitLevelEditor
                  {...props}
                  level={level()}
                  index={index()}
                  parentQuantity={props.quantity}
                  workspace={props.workspace === true}
                  expanded={
                    !props.workspace ||
                    (expanded() ?? levels().at(-1)?.id) === key
                  }
                  toggle={() =>
                    setExpanded((current) => ((current ?? levels().at(-1)?.id) === key ? "" : key))
                  }
                  paired={paired()}
                  disabled={disabled()}
                  update={(value) => patch(key, value)}
                  remove={() => {
                    write(removeExitLevel(levels(), key));
                    if (expanded() === key) setExpanded(undefined);
                  }}
                />
              );
            }}
          </For>
          <Show when={levels().length === 1 && !props.workspace}>
            <Show
              when={levels()[0].qty !== props.quantity}
              fallback={
                <TradingButton disabled={disabled()} onClick={useSingle}>
                  Use single-level exits
                </TradingButton>
              }
            >
              <p role="status" class="trading-muted">
                This level protects {levels()[0].qty} of {props.quantity} units.
              </p>
            </Show>
          </Show>
        </Show>
      </Show>
      <Show when={props.policy.flags.supportMultipleExitLevels}>
        <TradingButton class="trading-add-level" aria-label="Add level" disabled={!canAdd()} onClick={add}>
          Add level
        </TradingButton>
      </Show>
      <Show when={error()}>
        <p role="alert" class="trading-error">
          {error()}
        </p>
      </Show>
    </details>
  );
}
