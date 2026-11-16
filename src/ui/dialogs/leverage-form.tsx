import { userMessage } from "../../core/errors.js";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { followCommand } from "../../core/command-follow.js";
import type { LeverageInfo } from "../../contracts/broker.js";
import type { LeverageReview } from "../../core/leverage-commands.js";
import type { TradingSession } from "../../core/session.js";
import type { TradingDialogRequest } from "../../core/dialog-coordinator.js";
import { NumberField, TradingButton } from "../primitives.js";
export function LeverageForm(props: {
  session: TradingSession;
  request: Extract<TradingDialogRequest, { kind: "leverage" }>;
  complete(approved: boolean): void;
  busy(value: boolean): void;
}) {
  const [info, setInfo] = createSignal<Readonly<LeverageInfo>>(
    props.request.info,
  );
  const [input, setInput] = createSignal<number>(),
    [review, setReview] = createSignal<LeverageReview>();
  const [stage, setStage] = createSignal<
      "editing" | "reviewing" | "sending" | "unconfirmed"
    >("editing"),
    [error, setError] = createSignal<string>();
  let active = true,
    sequence = 0;
  let stopFollowing: (() => void) | undefined;
  onCleanup(() => {
    active = false;
    sequence++;
    stopFollowing?.();
  });
  /** A late broker outcome still completes the change or explains what happened. */
  function follow(epoch: number, commandId: string) {
    stopFollowing = followCommand(props.session.pending, commandId, (outcome) => {
      if (!active || epoch !== sequence || outcome.kind === "checking") return;
      if (outcome.kind === "confirmed") {
        props.complete(true);
        return;
      }
      if (outcome.kind === "unresolved") {
        setError("We could not confirm the result. Check the current leverage before another change.");
        return;
      }
      setStage("editing");
      setError(
        outcome.kind === "changed"
          ? "The broker reported a different leverage. Check its current value."
          : outcome.error ?? "Leverage could not be changed.",
      );
    });
  }
  const value = () => input() ?? info().leverage;
  const pending = () => stage() === "reviewing" || stage() === "sending";
  async function refresh(): Promise<void> {
    if (pending()) return;
    const epoch = ++sequence;
    setStage("reviewing");
    setReview(undefined);
    setError(undefined);
    try {
      const result = await props.session.commands.leverageInfo(props.request);
      if (active && epoch === sequence) setInfo(result);
    } catch (cause) {
      if (active && epoch === sequence)
        setError(
          userMessage(cause, "Leverage is unavailable."),
        );
    } finally {
      if (active && epoch === sequence) setStage("editing");
    }
  }
  async function preview(): Promise<void> {
    if (pending()) return;
    const epoch = ++sequence;
    setStage("reviewing");
    setError(undefined);
    setReview(undefined);
    try {
      const result = await props.session.commands.previewLeverage({
        context: props.request.context,
        params: { ...props.request.params, leverage: value() },
      });
      if (active && epoch === sequence) {
        setInfo(result.info);
        setReview(result);
      }
    } catch (cause) {
      if (active && epoch === sequence)
        setError(
          cause instanceof Error
            ? cause.message
            : "Leverage could not be reviewed.",
        );
    } finally {
      if (active && epoch === sequence) setStage("editing");
    }
  }
  async function apply(): Promise<void> {
    const approved = review();
    if (!approved || pending() || approved.preview?.errors?.length) return;
    const epoch = ++sequence;
    setStage("sending");
    props.busy(true);
    setError(undefined);
    try {
      const result = await props.session.commands.setLeverage({
        context: props.request.context,
        params: { ...props.request.params, leverage: value() },
        previewToken: approved.token,
      });
      if (!active || epoch !== sequence) return;
      setReview(undefined);
      if (result.outcome === "confirmed") {
        props.complete(true);
        return;
      }
      if (result.outcome === "unconfirmed") {
        setStage("unconfirmed");
        setError("Taking longer than expected. Checking with the broker…");
        follow(epoch, result.commandId);
      } else {
        setStage("editing");
        setError(
          "The broker reported a different leverage. Check its current value.",
        );
      }
    } catch (cause) {
      if (active && epoch === sequence) {
        setStage("editing");
        setReview(undefined);
        setError(
          cause instanceof Error
            ? cause.message
            : "Leverage could not be changed.",
        );
      }
    } finally {
      if (active && epoch === sequence) props.busy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void preview();
      }}
    >
      <p>
        {props.request.params.symbol} · current leverage 1:{info().leverage}
      </p>
      <NumberField
        label="Leverage"
        value={value()}
        min={info().min}
        max={info().max}
        step={info().step}
        disabled={pending()}
        onChange={(next) => {
          sequence++;
          setInput(next ?? NaN);
          setReview(undefined);
          setError(undefined);
        }}
      />
      <p>
        Choose from {info().min} to {info().max}, in steps of {info().step}.
      </p>
      <Show when={review()}>
        {(approved) => (
          <div aria-label="Leverage review">
            <p>
              Change leverage from 1:{approved().info.leverage} to 1:{value()}?
            </p>
            <For each={approved().preview?.infos}>
              {(message) => <p>{message}</p>}
            </For>
            <For each={approved().preview?.warnings}>
              {(message) => <p data-tone="warning">{message}</p>}
            </For>
            <For each={approved().preview?.errors}>
              {(message) => <p role="alert">{message}</p>}
            </For>
          </div>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert" class="trading-error">
          {error()}
        </p>
      </Show>
      <div class="trading-actions">
        <TradingButton
          disabled={stage() === "sending"}
          onClick={() => props.complete(false)}
        >
          Cancel
        </TradingButton>
        <Show
          when={!review()}
          fallback={
            <TradingButton
              tone="primary"
              disabled={pending() || !!review()?.preview?.errors?.length}
              onClick={() => {
                void apply();
              }}
            >
              Apply leverage
            </TradingButton>
          }
        >
          <TradingButton
            type="submit"
            tone="primary"
            disabled={pending() || stage() === "unconfirmed"}
          >
            Review leverage
          </TradingButton>
        </Show>
        <TradingButton
          disabled={pending()}
          onClick={() => {
            void refresh();
          }}
        >
          Check current leverage
        </TradingButton>
      </div>
    </form>
  );
}
