import type { TradingDialogRequest } from "../../core/dialog-coordinator.js";
import type { TradingSession } from "../../core/session.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { MessageDialog } from "./message-dialog.js";
import { PropertiesDialog } from "./properties-dialog.js";
import { ClosePreviewDialog } from "./close-preview-dialog.js";
import { CloseAmountForm } from "./close-amount-form.js";
import { LeverageForm } from "./leverage-form.js";
/** Mounted beneath a keyed dialog entry, so narrowing retains the immutable request identity. */
export function DialogBody(props: {
  request: TradingDialogRequest;
  session: TradingSession;
  document: Document;
  complete(approved: boolean): void;
  approveAmount(amount: number): void;
  busy(value: boolean): void;
}) {
  const request = props.request;
  switch (request.kind) {
    case "confirm": return <ConfirmDialog request={request} session={props.session} complete={props.complete} />;
    case "message": return <MessageDialog request={request} document={props.document} complete={props.complete} />;
    case "properties": return <PropertiesDialog session={props.session} complete={props.complete} />;
    case "closePreview": return <ClosePreviewDialog request={request} complete={props.complete} />;
    case "closeAmount": return <CloseAmountForm request={request} approve={props.approveAmount} cancel={() => props.complete(false)} />;
    case "leverage": return <LeverageForm request={request} session={props.session} complete={props.complete} busy={props.busy} />;
    case "order":
    case "position": return null;
  }
}
