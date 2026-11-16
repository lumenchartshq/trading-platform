import { userMessage } from "../../core/errors.js";
import { sameAccountGeneration, type AccountGeneration } from "../../core/identity.js";

/** Pending/error ownership shared by order and position row commands. */
export function createRowActionTracker(options: {
  current(): AccountGeneration;
  pending(value: ReadonlySet<string>): void;
  error(value: string | undefined): void;
  status(value: string | undefined): void;
}) {
  const pending = new Set<string>();
  let active = true;
  const current = (context: AccountGeneration) => active && sameAccountGeneration(options.current(), context);
  return {
    reset() {
      pending.clear();
      options.pending(new Set());
      options.error(undefined);
      options.status(undefined);
    },
    async run(
      id: string,
      context: AccountGeneration,
      work: (status: (text: string) => void) => Promise<unknown>,
      fallback: string,
    ): Promise<void> {
      options.error(undefined);
      options.status(undefined);
      pending.add(id);
      options.pending(new Set(pending));
      try {
        await work(text => { if (current(context)) options.status(text); });
      } catch (cause) {
        if (current(context)) options.error(userMessage(cause, fallback));
      } finally {
        if (current(context)) {
          pending.delete(id);
          options.pending(new Set(pending));
        }
      }
    },
    destroy() { active = false; pending.clear(); },
  };
}
