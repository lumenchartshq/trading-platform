import type {
  TradingChartBinding,
  TradingChartPort,
  TradingOverlayEvent,
  TradingOverlayHandle,
  TradingProtectionLeg,
  TradingProtectionView,
} from "../contracts/ports.js";
import type { DisposalScope } from "../core/disposal.js";
import type { ProfitAccount } from "../core/position-profit-currency.js";
import type { OverlayEntityKind, Projection } from "./overlay-projection.js";

export interface OverlayAction {
  readonly binding: TradingChartBinding;
  readonly entityId: string;
  readonly kind: OverlayEntityKind;
  readonly revision: number;
  readonly event: TradingOverlayEvent;
}
/** One chart overlay and the state of its active gesture. */
export interface Overlay {
  readonly handle: TradingOverlayHandle;
  readonly scope: DisposalScope;
  projection: Projection;
  proposedProtection?: TradingProtectionView;
  gestureRevision?: number;
  editToken?: number;
  gestureId?: string;
  /** The protection leg the active gesture drags; undefined for a body move. */
  gestureLeg?: TradingProtectionLeg;
  releaseFinance?: () => void;
  /** The account a drag's money preview reads, fixed when the gesture starts. */
  moneyAccount?: ProfitAccount;
  previewEvent?: Extract<TradingOverlayEvent, { gestureId: string }>;
  /** A confirmed exit dragged by its body edits its parent's protection leg instead of the exit order. */
  parentEdit?: {
    readonly kind: "order" | "position" | "individualPosition";
    readonly id: string;
    readonly leg: TradingProtectionLeg;
    /** Broker level of an allocated exit; that level's leg moves instead of a new level being added. */
    readonly level?: string;
  };
}
/** One chart's overlays. */
export interface Owner {
  readonly chart: TradingChartPort;
  readonly binding: TradingChartBinding;
  readonly overlays: Map<string, Overlay>;
  readonly scope: DisposalScope;
}
