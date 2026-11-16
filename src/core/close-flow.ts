import { Side } from "../contracts/broker.js";
import type { InstrumentInfo } from "../contracts/broker.js";
import type { CloseRequest } from "./position-commands.js";
import type { TradingCommands } from "./trading-commands.js";
import type { TradingState } from "./trading-state.js";
import type { DialogCoordinator } from "./dialog-coordinator.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { entityStore, isLiveContext } from "./command-context.js";
import { activeProtectionChildren } from "./bracket-parent.js";
import { snapshot } from "./immutable.js";
import { TradingError } from "./errors.js";
/** Confirmation, partial amount and preview orchestration; commands retain broker write ownership. */
export function createCloseFlow(services: {
  readonly state: TradingState;
  readonly dialogs: DialogCoordinator;
  commands(): TradingCommands | undefined;
  symbolPolicy(symbol: string): CapabilityPolicy;
  symbolInfo(symbol: string): Promise<InstrumentInfo>;
}) {
  const { state, dialogs, symbolPolicy, symbolInfo } = services;
  return async (request: CloseRequest) => {
    request = snapshot(request);
    const commands = services.commands();
    if (!commands) throw TradingError.brokerUnavailable();
    const custom = await commands.confirmCustomClose(request);
    if (custom) return custom.approved ? commands.close({ ...request, previewToken: custom.token }) : undefined;
    const kind = request.individual ? "individualPosition" : "position";
    const position = entityStore(state, kind).get(request.id);
    if (!position) throw new TradingError("stale-context", "This position is no longer available.");
    const closePolicy = symbolPolicy(position.symbol);
    // Expectation only: the brackets disappear when the broker reports them cancelled.
    const cancelsBrackets =
      closePolicy.flags.closePositionCancelsOrders &&
      activeProtectionChildren(state.orders, kind, position.id).length > 0;
    const bracketNotice = cancelsBrackets ? ["Its take-profit and stop-loss orders will also be cancelled."] : [];
    const partial = request.individual
      ? closePolicy.flags.supportPartialCloseIndividualPosition
      : closePolicy.flags.supportPartialClosePosition;
    let amountApproved = false;
    if (request.amount === undefined && partial) {
      const instrument = await symbolInfo(position.symbol);
      const store = entityStore(state, kind);
      if (!isLiveContext(state, request.context) || store.revision(request.id) !== request.context.revision)
        throw TradingError.positionChanged();
      const amount = await dialogs.requestAmount({
        kind: "closeAmount",
        position: structuredClone(position),
        instrument,
        preview: closePolicy.flags.supportPreviewClosePosition,
        nativeFullClose: request.individual
          ? closePolicy.flags.supportCloseIndividualPosition
          : closePolicy.flags.supportClosePosition,
        cancelsBrackets,
      });
      if (amount === undefined) return undefined;
      request = { ...request, amount };
      amountApproved = true;
    }
    if (symbolPolicy(position.symbol).flags.supportPreviewClosePosition) {
      const lease = await commands.previewClose(request);
      const approved = await dialogs.request({
        kind: "closePreview",
        preview: lease.preview,
      });
      return approved
        ? commands.close({
            ...request,
            confirmId: lease.preview.id,
            previewToken: lease.token,
          })
        : undefined;
    }
    if (amountApproved) return commands.close(request);
    const approved = await dialogs.request({
      kind: "confirm",
      title: "Close position",
      content: [
        position.symbol,
        `${position.side === Side.Buy ? "Long" : "Short"} ${request.amount ?? position.qty}`,
        ...bracketNotice,
      ],
      mainButtonText: "Close position",
      cancelButtonText: "Keep position",
      symbol: { name: position.symbol, logo: "close" },
    });
    return approved ? commands.close(request) : undefined;
  };
}
