import type { EntityReader } from "./entity-store.js";
import type { PendingOperation } from "./command-coordinator.js";

/**
 * What an unconfirmed command has become: still `checking` with the broker, `unresolved` once reconciliation ended
 * without evidence, or a final broker outcome.
 */
export type CommandFollowState =
  | { readonly kind: "checking" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "confirmed"; readonly entityIds: readonly string[] }
  | { readonly kind: "changed"; readonly entityIds: readonly string[] }
  | { readonly kind: "rejected"; readonly error?: string };

export function commandFollowState(record: Readonly<PendingOperation> | undefined): CommandFollowState {
  if (!record) return { kind: "unresolved" };
  if (record.stage === "confirmed") return { kind: "confirmed", entityIds: record.entityIds };
  if (record.stage === "changed") return { kind: "changed", entityIds: record.entityIds };
  if (record.stage === "rejected") return { kind: "rejected", error: record.error };
  if (record.stage === "unconfirmed" && record.reconciling !== true) return { kind: "unresolved" };
  return { kind: "checking" };
}

/**
 * Reports an unconfirmed command's state now and on each change of its pending record, then stops by itself once the
 * state is final (anything but `checking`). The returned dispose stops it earlier; callers fence their own lifetime.
 */
export function followCommand(
  pending: EntityReader<PendingOperation>,
  commandId: string,
  listener: (state: CommandFollowState) => void,
): () => void {
  let active = true, previous: CommandFollowState["kind"] | undefined;
  let release: (() => void) | undefined;
  const stop = () => {
    active = false;
    release?.();
    release = undefined;
  };
  const report = () => {
    if (!active) return;
    const state = commandFollowState(pending.get(commandId));
    if (state.kind === "checking" && previous === "checking") return;
    previous = state.kind;
    if (state.kind !== "checking") stop();
    listener(state);
  };
  release = pending.subscribeChanges(change => {
    if (change.updated.includes(commandId) || change.removed.includes(commandId)) report();
  });
  report();
  return stop;
}

/**
 * Calls `onAccepted` once when the broker acknowledges a command holding `key` that was dispatched at or after
 * `since`. A key is held by one command at a time, so a caller that has not yet received its command ID can still
 * tell its own command from earlier ones. Acknowledgement is transport only: it never means confirmed.
 */
export function watchAcceptance(
  pending: EntityReader<PendingOperation>,
  key: string,
  since: number,
  onAccepted: () => void,
): () => void {
  let active = true;
  const check = (ids: readonly string[]) => {
    if (!active) return;
    for (const id of ids) {
      const record = pending.get(id);
      if (!record || record.dispatchedAt < since || !record.keys.includes(key) || record.stage !== "awaitingUpdate") continue;
      stop();
      onAccepted();
      return;
    }
  };
  const release = pending.subscribeChanges(change => check([...change.added, ...change.updated]));
  function stop() {
    active = false;
    release();
  }
  check(pending.ids());
  return stop;
}
