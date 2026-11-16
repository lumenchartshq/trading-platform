import { ProtectedSizeSummary } from "./protected-size.js";
import { bracketStopType } from "../../core/bracket-input.js";
import { CloseIcon } from "../icons.js";
import { symbolLabel } from "../../core/features.js";
import { createSignal, onCleanup, Show } from "solid-js";
import type {
  Brackets,
  ExitLevel,
} from "../../contracts/broker.js";
import { exitLevelRewardRisk } from "../../core/exit-level-summary.js";
import { normalizeProtection } from "../../core/protection-rules.js";
import { TradingButton } from "../primitives.js";
import { ProtectionEditor, type ProtectionEditorProps } from "./editor.js";

interface ExitDraft {
  readonly source: Readonly<Brackets>;
  readonly quantity: number;
  readonly symbol: string;
  readonly side: ProtectionEditorProps["side"];
  readonly levels: ExitLevel[];
}

/** Exit allocation is a separate transaction: only Confirm changes the order draft. */
export function TicketProtectionWorkspace(
  props: ProtectionEditorProps & {
    onEditingChange(editing: boolean): void;
    closeTicket?(): void;
    orderDescription?: string;
  },
) {
  let title: HTMLHeadingElement | undefined;
  onCleanup(() => props.onEditingChange(false));
  const [draft, setDraft] = createSignal<ExitDraft>();
  const [error, setError] = createSignal<string>();
  const current = () => {
    const value = draft();
    return (
      !!value &&
      value.source === props.brackets &&
      value.quantity === props.quantity &&
      value.symbol === props.symbol &&
      value.side === props.side
    );
  };
  const protectedQuantity = () =>
    draft()?.levels.reduce((sum, level) => sum + level.qty, 0) ?? 0;
  const ratio = () =>
    exitLevelRewardRisk(
      draft()?.levels ?? [],
      props.entry,
      props.side,
      props.instrument,
    );
  function close(): void {
    setDraft(undefined);
    setError(undefined);
    props.onEditingChange(false);
  }
  function open(levels: ExitLevel[]): void {
    if (props.disabled) return;
    setError(undefined);
    setDraft({
      source: props.brackets,
      quantity: props.quantity,
      symbol: props.symbol,
      side: props.side,
      levels: structuredClone(levels),
    });
    props.onEditingChange(true);
    queueMicrotask(() => {
      if (draft() && title?.isConnected) title.focus();
    });
  }
  function confirm(): void {
    if (!current() || props.disabled) return;
    try {
      const result = normalizeProtection(
        { exitLevels: draft()!.levels },
        props.quantity,
        props.instrument,
        props.policy,
        props.maximum,
        "order",
      );
      const stopType = bracketStopType(result);
      props.update({ ...result, stopType });
      close();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Exit levels could not be saved.",
      );
    }
  }
  return (
    <Show
      when={draft()}
      fallback={<ProtectionEditor {...props} editLevels={open} />}
    >
      <section
        class="trading-exit-workspace"
        aria-label="Exit levels"
        on:keydown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <header class="trading-panel-header">
          <TradingButton
            class="trading-icon-button"
            aria-label="Back to order"
            onClick={close}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14.5 6-6 6 6 6" />
            </svg>
          </TradingButton>
          <h2 ref={title} tabIndex={-1}>
            Exit levels
          </h2>
          <Show when={props.closeTicket}>
            <TradingButton
              class="trading-icon-button"
              aria-label="Close order ticket"
              onClick={() => props.closeTicket?.()}
            >
              <CloseIcon />
            </TradingButton>
          </Show>
        </header>
        <p class="trading-muted">
          <strong>{symbolLabel(props.symbol, props.session.features)}</strong>
          <br />
          {props.orderDescription ??
            `${props.quantity} ${props.instrument.units ?? "units"}`}
        </p>
        <div class="trading-exit-summaries">
          <ProtectedSizeSummary protectedQuantity={protectedQuantity()} quantity={props.quantity} />
        </div>
        <div class="trading-risk-reward">
          <span>Risk / Reward</span>
          <strong>
            {ratio()?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ??
              "—"}
          </strong>
        </div>
        <ProtectionEditor
          {...props}
          brackets={{ exitLevels: draft()!.levels }}
          editLevels={undefined}
          workspace
          disabled={props.disabled || !current()}
          update={(value) => {
            setError(undefined);
            setDraft(
              (previous) =>
                previous && { ...previous, levels: value.exitLevels ?? [] },
            );
          }}
        />
        <Show when={!current()}>
          <p role="alert" class="trading-error">
            The order changed. Discard these edits and open exit levels again.
          </p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="trading-error">
            {error()}
          </p>
        </Show>
        <footer class="trading-actions trading-exit-workspace-actions">
          <TradingButton
            tone="primary"
            disabled={!current() || props.disabled}
            onClick={confirm}
          >
            Confirm
          </TradingButton>
          <TradingButton onClick={close}>Discard</TradingButton>
        </footer>
      </section>
    </Show>
  );
}
