import { CustomField } from "../order-ticket/custom-field.js";
import { positionCustomValues } from "../../core/position-custom-fields.js";
import { CloseIcon } from "../icons.js";
import { symbolLabel } from "../../core/features.js";
import { createResource, createSignal, onCleanup, Show, For } from "solid-js";
import { Side } from "../../contracts/broker.js";
import type {
  Brackets,
  IndividualPosition,
  Position,
} from "../../contracts/broker.js";
import type { TradingDialogRequest } from "../../core/dialog-coordinator.js";
import type { TradingSession } from "../../core/session.js";
import {
  TradingButton,
  useTradingEntity,
  useTradingValue,
} from "../primitives.js";
import { ProtectionEditor } from "../protection/editor.js";
import { protectionDirectionError } from "../../core/protection-rules.js";
import { entityEntryPrice, positionProtectionReference } from "../../core/financial-rules.js";
import { useTicketMarket } from "../order-ticket/market.js";
import { followCommand } from "../../core/command-follow.js";

/**
 * Position protection is a side pane (read-only position summary, exits, Position info, Confirm/Discard).
 * It pins its broker identity and revision; saving never retargets another position.
 */
export function PositionProtection(props: {
  session: TradingSession;
  request: Extract<TradingDialogRequest, { kind: "position" }>;
  complete(approved: boolean): void;
  busy(value: boolean): void;
}) {
  const [draft, setDraft] = createSignal<Brackets>(
    structuredClone(props.request.brackets),
  );
  const [customOverrides, setCustomOverrides] = createSignal<Record<string, unknown>>({});
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  const [unconfirmed, setUnconfirmed] = createSignal(false);
  const individual = "date" in props.request.position;
  const edit = props.session.chartEdits.state.get();
  const context = edit?.id === props.request.position.id ? edit.context : props.session.commands.context(
    props.request.position.id,
    individual ? "individualPosition" : "position",
  );
  const globalPolicy = useTradingValue(props.session.policy);
  const policy = () => {
    globalPolicy();
    return props.session.symbolPolicy(props.request.position.symbol);
  };
  const brokerPosition = useTradingEntity<Position | IndividualPosition>(
    individual
      ? props.session.state.individualPositions
      : props.session.state.positions,
    () => props.request.position.id,
  );
  const [metadata, { refetch }] = createResource(
    () => props.request.position.symbol,
    async (symbol) => {
      const [instrument, options, formatters] = await Promise.all([
        props.session.symbolInfo(symbol),
        props.session.positionDialogOptions(symbol),
        props.session.formatters(symbol),
      ]);
      return { instrument, options, formatters };
    },
  );
  const fields = () => individual ? [] : metadata()?.options?.customFields ?? [];
  const customValues = () => positionCustomValues(fields(), props.request.position.extra, customOverrides());
  const canEdit = () =>
    policy().symbol.supportModifyPositionBrackets !== false &&
    (individual
      ? policy().flags.supportIndividualPositionBrackets
      : policy().flags.supportPositionBrackets);
  const disabled = () => pending() || unconfirmed() || !canEdit();
  const entry = () => entityEntryPrice("position", props.request.position);
  // Exits are checked against the live closing price, so a stop can trail past the entry into profit.
  const market = useTicketMarket(props.session, () => props.request.position.symbol);
  const directionReference = () => ({
    price: positionProtectionReference(props.request.position, market.ready()),
    name: "current price",
  });
  const price = market.price;
  const directionError = () => {
    const reference = directionReference();
    return protectionDirectionError(draft(), props.request.position.side, reference.price, reference.name);
  };
  let active = true;
  let stopFollowing: (() => void) | undefined;
  onCleanup(() => {
    active = false;
    stopFollowing?.();
  });
  /** A late broker outcome still closes the dialog or explains what happened. */
  function follow(commandId: string) {
    stopFollowing = followCommand(props.session.pending, commandId, (outcome) => {
      if (!active) return;
      if (outcome.kind === "checking") return;
      if (outcome.kind === "confirmed") {
        props.complete(true);
        return;
      }
      if (outcome.kind === "unresolved") {
        setError("We could not confirm the result. Refresh to check the protection before making another change.");
        return;
      }
      setUnconfirmed(false);
      setError(
        outcome.kind === "changed"
          ? "The protection changed at the broker. Review its latest details."
          : outcome.error ?? "Protection could not be changed.",
      );
    });
  }
  async function submit() {
    if (disabled() || directionError() || metadata.loading || metadata.error || !metadata()) return;
    setPending(true);
    props.busy(true);
    setError(undefined);
    try {
      const result = await props.session.commands.editProtection({
        id: props.request.position.id,
        context,
        individual,
        brackets: draft(),
        ...(fields().length > 0 && { customFields: customValues() }),
      });
      if (active) {
        if (result.outcome === "confirmed") props.complete(true);
        else if (result.outcome === "unconfirmed") {
          setUnconfirmed(true);
          setError("Taking longer than expected. Checking with the broker…");
          follow(result.commandId);
        } else {
          setError("The protection changed at the broker. Review its latest details.");
        }
      }
    } catch (cause) {
      if (active)
        setError(
          cause instanceof Error
            ? cause.message
            : "Protection could not be changed.",
        );
    } finally {
      if (active) {
        setPending(false);
        props.busy(false);
      }
    }
  }
  const direction = () =>
    props.request.position.side === Side.Buy ? "Long" : "Short";
  return (
    <form
      class="trading-protection-pane"
      data-ui="position-protection"
      aria-label="Position protection"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending()) {
          event.preventDefault();
          props.complete(false);
        }
      }}
    >
      <header class="trading-panel-header trading-ticket-header">
        <strong>
          {symbolLabel(props.request.position.symbol, props.session.features)}
        </strong>
        <TradingButton
          aria-label="Close position protection"
          class="trading-icon-button"
          disabled={pending()}
          onClick={() => props.complete(false)}
        >
          <CloseIcon />
        </TradingButton>
      </header>
      <div class="trading-protection-content">
        <div class="trading-modify-summary" data-ui="modification-summary">
          <p>
            {direction()} {props.request.position.qty} @ {price(entry())}
          </p>
        </div>
        <Show
          when={!metadata.error}
          fallback={
            <>
              <p role="alert" class="trading-error">
                Trading information could not be loaded.
              </p>
              <TradingButton onClick={() => void refetch()}>Retry</TradingButton>
            </>
          }
        >
          <Show
            when={metadata()}
            fallback={<p role="status">Loading trading information…</p>}
          >
            {(info) => (<>
              <ProtectionEditor
                session={props.session}
                active={!pending() && !unconfirmed()}
                policy={policy()}
                symbol={props.request.position.symbol}
                side={props.request.position.side}
                instrument={info().instrument}
                quantity={props.request.position.qty}
                brackets={draft()}
                target="position"
                modifying
                disabled={disabled()}
                stopMoneyAllowed
                entry={entry()}
                directionReference={directionReference()}
                maximum={info().options?.maxExitLevelsCount}
                reportedTrailingPrice={brokerPosition()?.trailingStopPrice}
                price={price}
                update={(value) => {
                  const { stopType: _stopType, ...brackets } = value;
                  const next = { ...draft(), ...brackets };
                  setDraft(next);
                  props.session.chartEdits.syncPosition(next);
                }}
              />
              <For each={fields()}>{field => <CustomField field={field} value={customValues()[field.id]} disabled={disabled()} modifying
                update={value => setCustomOverrides(previous => ({ ...previous, [field.id]: value }))} />}</For>
            </>)}
          </Show>
        </Show>
        <section class="trading-position-info" aria-label="Position info">
          <h4>Position info</h4>
          <dl>
            <div>
              <dt>Quantity</dt>
              <dd>{props.request.position.qty}</dd>
            </div>
            <div>
              <dt>Average price</dt>
              <dd>{price(entry())}</dd>
            </div>
          </dl>
        </section>
        <Show when={!canEdit()}>
          <p role="status" class="trading-muted">
            Protection cannot be changed for this instrument.
          </p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="trading-error">
            {error()}
          </p>
        </Show>
      </div>
      <div class="trading-ticket-submit trading-modify-actions">
        <TradingButton
          type="submit"
          tone="primary"
          disabled={disabled() || !!directionError() || metadata.loading || !!metadata.error}
        >
          Confirm
        </TradingButton>
        <TradingButton
          disabled={pending()}
          onClick={() => props.complete(false)}
        >
          Discard
        </TradingButton>
      </div>
    </form>
  );
}
