import type { AccountId, ClosePositionPreviewResult } from "../contracts/broker.js";
import { assertLiveContext, assertRevision, entityStore } from "./command-context.js";
import type { TradingCommandResult } from "./command-coordinator.js";
import { TradingError } from "./errors.js";
import { equalData, snapshot } from "./immutable.js";
import { closeTradingPosition, type CloseRequest, type PositionCommandServices } from "./position-commands.js";
import { PreviewLeases } from "./preview-leases.js";
import type { TradingCommandServices } from "./trading-commands.js";

/** What closing uses: position commands plus the broker close-preview extension and custom close dialog. */
export type CloseCommandServices = PositionCommandServices &
  Pick<TradingCommandServices, "closePreview" | "customClose">;

/** Close reviews (broker extension or custom dialog) and the close command that consumes them. */
export class CloseCommands {
  private readonly closePreviews: PreviewLeases<{ request: CloseRequest; id?: string }>;
  constructor(
    private readonly services: CloseCommandServices,
    nextSequence: () => number,
  ) {
    this.closePreviews = new PreviewLeases("close-preview", 200, nextSequence);
  }
  clear(): void {
    this.closePreviews.clear();
  }
  private rememberClose(request: CloseRequest, id?: string): string {
    return this.closePreviews.issue({ request: structuredClone(request), id });
  }
  private validateCloseContext(request: CloseRequest) {
    assertLiveContext(this.services.state, request.context);
    const kind = request.individual ? "individualPosition" : "position";
    const position = entityStore(this.services.state, kind).get(request.id);
    if (!position) throw TradingError.positionChanged();
    assertRevision(this.services.state, kind, request.id, request.context.revision);
    return position;
  }
  async previewClose(request: CloseRequest): Promise<{
    token: string;
    preview: Readonly<ClosePositionPreviewResult>;
  }> {
    this.validateCloseContext(request);
    const method = this.services.closePreview;
    if (!method) throw new TradingError("configuration", "Closing previews need a broker extension.");
    const preview = snapshot(
      await method({
        accountId: request.context.accountId as AccountId,
        positionId: request.id,
        individual: !!request.individual,
        amount: request.amount,
      }),
    );
    this.validateCloseContext(request);
    return Object.freeze({ token: this.rememberClose(request, preview.id), preview });
  }
  async confirmCustomClose(request: CloseRequest): Promise<{ approved: boolean; token?: string } | undefined> {
    const method = this.services.customClose;
    if (!method) return undefined;
    const position = this.validateCloseContext(request);
    const approved = await method(structuredClone(position));
    this.validateCloseContext(request);
    return { approved, token: approved ? this.rememberClose(request) : undefined };
  }
  close(request: CloseRequest): Promise<TradingCommandResult> {
    const previewApproved = !!this.closePreviews.claim(
      request.previewToken,
      (lease) =>
        lease.request.id === request.id &&
        !!lease.request.individual === !!request.individual &&
        lease.request.amount === request.amount &&
        equalData(lease.request.context, request.context) &&
        lease.id === request.confirmId,
      false,
    );
    // The review is consumed only when the close is actually sent; failed checks keep it available.
    const consumePreview = () => {
      if (previewApproved) this.closePreviews.claim(request.previewToken, () => true);
    };
    return closeTradingPosition(this.services, request, previewApproved, consumePreview);
  }
}
