import type { TradingChartBinding } from "../contracts/ports.js";
import type { ClosePositionPreviewResult, InstrumentInfo, LeverageInfo, LeverageInfoParams } from "../contracts/broker.js";
import type { TradingCommandContext } from "./trading-commands.js";
import type {
  Brackets,
  IndividualPosition,
  OrderTicketFocusControl,
  Position,
  PreOrder,
} from "../contracts/broker.js";
import { deferred } from "./deferred.js";
import { snapshot } from "./immutable.js";
import { TradingError } from "./errors.js";
import { validateQuantity } from "./trading-rules.js";
import { ValueStore } from "./value-store.js";
export type TradingDialogRequest =
  | {
      kind: "confirm";
      title: string;
      content: string | string[];
      mainButtonText?: string;
      cancelButtonText?: string;
      showDisableConfirmationsCheckbox?: boolean;
      /** Symbol shown with its logo when the matching show_symbol_logo_in_* feature is enabled. */
      symbol?: { readonly name: string; readonly logo: "cancel" | "close" };
    }
  | { kind: "message"; title: string; content: string; html: boolean }
  | {
      kind: "order";
      order: PreOrder;
      focus?: OrderTicketFocusControl;
      binding?: TradingChartBinding;
    }
  | {
      kind: "position";
      position: Position | IndividualPosition;
      brackets: Brackets;
      focus?: OrderTicketFocusControl;
    }
  | { kind: "properties" }
  | {
      kind: "closeAmount";
      position: Position | IndividualPosition;
      instrument: InstrumentInfo;
      preview: boolean;
      nativeFullClose?: boolean;
      /** `closePositionCancelsOrders`: the broker also cancels this position's working brackets. */
      cancelsBrackets?: boolean;
    }
  | {
      kind: "leverage";
      context: TradingCommandContext;
      params: LeverageInfoParams;
      info: LeverageInfo;
    }
  | {
      kind: "closePreview";
      preview: ClosePositionPreviewResult;
    };
interface Entry {
  readonly id: number;
  readonly request: TradingDialogRequest;
  readonly completion: ReturnType<
    typeof deferred<boolean | number | undefined>
  >;
}
/** Presentation settles a dialog once; broker operation ownership stays with the invoking path. */
export class DialogCoordinator {
  readonly current = new ValueStore<
    { readonly id: number; readonly request: TradingDialogRequest } | undefined
  >(undefined);
  private readonly queue: Entry[] = [];
  private sequence = 0;
  private disposed = false;
  request(
    request: Exclude<TradingDialogRequest, { kind: "closeAmount" }>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.enqueue(request, signal).then((value) => value === true);
  }
  requestAmount(
    request: Extract<TradingDialogRequest, { kind: "closeAmount" }>,
  ): Promise<number | undefined> {
    return this.enqueue(request).then((value) =>
      typeof value === "number" ? value : undefined,
    );
  }
  private enqueue(
    request: TradingDialogRequest,
    signal?: AbortSignal,
  ): Promise<boolean | number | undefined> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.disposed)
      return Promise.reject(
        TradingError.disposed(),
      );
    const entry = {
      id: ++this.sequence,
      request: snapshot(request),
      completion: deferred<boolean | number | undefined>(),
    };
    const abort = () => {
      const index = this.queue.indexOf(entry);
      if (index < 0) return;
      this.queue.splice(index, 1);
      entry.completion.resolve(false);
      this.publish();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // An order request stays pending for the lifetime of its ticket. A dialog
    // opened from that ticket must run above it, then resume the same request.
    if (this.queue[0]?.request.kind === "order" && request.kind !== "order")
      this.queue.unshift(entry);
    else this.queue.push(entry);
    this.publish();
    return entry.completion.promise.finally(() =>
      signal?.removeEventListener("abort", abort),
    );
  }
  respond(id: number, approved: boolean): void {
    const entry = this.queue[0];
    if (entry?.id !== id) return;
    if (entry.request.kind === "closeAmount") {
      if (approved) this.respondAmount(id, entry.request.position.qty);
      else {
        this.queue.shift()?.completion.resolve(undefined);
        this.publish();
      }
      return;
    }
    this.queue.shift()?.completion.resolve(approved);
    this.publish();
  }
  respondAmount(id: number, amount: number): void {
    const entry = this.queue[0];
    if (entry?.id !== id || entry.request.kind !== "closeAmount") return;
    validateQuantity(amount, entry.request.instrument.qty);
    if (amount > entry.request.position.qty)
      throw new TradingError(
        "invalid-input",
        "The close quantity exceeds this position.",
      );
    this.queue.shift()?.completion.resolve(amount);
    this.publish();
  }
  cancelAll(): void {
    for (const entry of this.queue.splice(0)) entry.completion.resolve(false);
    this.publish();
  }
  private publish(): void {
    const entry = this.queue[0];
    this.current.set(
      entry ? { id: entry.id, request: entry.request } : undefined,
    );
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.current.destroy();
  }
}
