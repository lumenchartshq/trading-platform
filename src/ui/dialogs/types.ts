import type { TradingDialogRequest } from "../../core/dialog-coordinator.js";
export type DialogRequest<K extends TradingDialogRequest["kind"]> = Extract<TradingDialogRequest, { kind: K }>;
export function dialogTitle(request: TradingDialogRequest | undefined): string {
  if (!request) return "";
  switch (request.kind) {
    case "leverage": return request.info.title;
    case "properties": return "Trading settings";
    case "closeAmount": return "Close position";
    case "closePreview": return "Review position close";
    case "order": return "Order ticket";
    case "position": return "Position protection";
    case "confirm":
    case "message": return request.title;
  }
}
