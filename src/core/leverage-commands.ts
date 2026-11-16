import { commandKeys } from "./command-keys.js";
import { sameAccountGeneration } from "./identity.js";
import { PreviewLeases } from "./preview-leases.js";
import type {
  IBrokerTerminal,
  LeverageInfo,
  LeverageInfoParams,
  LeveragePreviewResult,
  LeverageSetParams,
  LeverageSetResult,
} from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import type { TradingCommandContext } from "./trading-commands.js";
import type {
  CommandCoordinator,
  TradingCommandResult,
} from "./command-coordinator.js";
import { alignedFrom } from "./trading-rules.js";
import { equalData, snapshot } from "./immutable.js";
import { TradingError } from "./errors.js";
export interface LeverageRequest {
  readonly context: TradingCommandContext;
  readonly params: LeverageInfoParams;
}
export interface LeverageChangeRequest {
  readonly context: TradingCommandContext;
  readonly params: LeverageSetParams;
  readonly previewToken?: string;
}
export interface LeverageReview {
  readonly token: string;
  readonly info: Readonly<LeverageInfo>;
  readonly preview?: Readonly<LeveragePreviewResult>;
}
interface Services {
  readonly broker: IBrokerTerminal;
  readonly coordinator: CommandCoordinator;
  readonly policy: (symbol?: string) => CapabilityPolicy;
  readonly validateContext: (context: TradingCommandContext) => void;
  readonly read: <T>(load: () => T | Promise<T>) => Promise<T>;
  readonly refreshDependencies: (symbol: string) => Promise<void>;
  readonly invalidatePreviews: (symbol: string) => void;
  readonly refresh: () => void;
}
interface ReviewLease {
  readonly request: LeverageChangeRequest;
  readonly info: Readonly<LeverageInfo>;
  readonly preview?: Readonly<LeveragePreviewResult>;
}
/** No leverage push exists in the pinned host; confirm with an explicit broker information read. */
export class LeverageCommands {
  private readonly reviews = new PreviewLeases<ReviewLease>("leverage");
  constructor(private readonly services: Services) {}
  clearReviews(): void {
    this.reviews.clear();
  }
  private assert(request: LeverageRequest, change = false): void {
    this.services.validateContext(request.context);
    const policy = this.services.policy(request.params.symbol);
    if (
      !request.params.symbol ||
      !policy.orderTypes.includes(request.params.orderType) ||
      ![1, -1].includes(request.params.side)
    )
      throw new TradingError(
        "invalid-input",
        "Choose a supported symbol, side and order type.",
      );
    if (
      !policy.flags.supportLeverage ||
      (change && !policy.flags.supportLeverageButton)
    )
      throw new TradingError(
        "unsupported",
        "Leverage changes are unavailable.",
      );
  }
  async info(input: LeverageRequest): Promise<Readonly<LeverageInfo>> {
    const request = snapshot(input);
    this.assert(request);
    const method = this.services.broker.leverageInfo;
    if (!method)
      throw new TradingError(
        "configuration",
        "The broker does not provide leverage information.",
      );
    const params: LeverageInfoParams = {
      symbol: request.params.symbol,
      orderType: request.params.orderType,
      side: request.params.side,
    };
    if (request.params.customFields !== undefined)
      params.customFields = structuredClone(request.params.customFields);
    const info = snapshot(
      await this.services.read(() => method.call(this.services.broker, params)),
    );
    this.assert(request);
    if (
      ![info.leverage, info.min, info.max, info.step].every(Number.isFinite) ||
      info.min <= 0 ||
      info.max < info.min ||
      info.step <= 0 ||
      info.leverage < info.min ||
      info.leverage > info.max
    )
      throw new TradingError(
        "configuration",
        "The broker returned invalid leverage limits.",
      );
    return info;
  }
  private validateValue(value: number, info: Readonly<LeverageInfo>): void {
    if (
      !Number.isFinite(value) ||
      value < info.min ||
      value > info.max ||
      !alignedFrom(value, info.min, info.step)
    )
      throw new TradingError(
        "invalid-input",
        "Choose leverage within the broker limits and step.",
      );
  }
  async review(input: LeverageChangeRequest): Promise<LeverageReview> {
    const request = snapshot(input);
    this.assert(request, true);
    const info = await this.info(request);
    this.validateValue(request.params.leverage, info);
    if (request.params.leverage === info.leverage)
      throw new TradingError(
        "invalid-input",
        "Choose a different leverage value.",
      );
    const method = this.services.broker.previewLeverage;
    const preview = method
      ? snapshot(
          await this.services.read(() =>
            method.call(this.services.broker, structuredClone(request.params)),
          ),
        )
      : undefined;
    this.assert(request, true);
    for (const messages of [preview?.infos, preview?.warnings, preview?.errors])
      if (
        messages !== undefined &&
        (!Array.isArray(messages) ||
          messages.some((message) => typeof message !== "string"))
      )
        throw new TradingError(
          "configuration",
          "The broker returned invalid leverage messages.",
        );
    const token = this.reviews.issue({ request, info, preview });
    return Object.freeze({ token, info, preview });
  }
  private async confirm(request: LeverageChangeRequest): Promise<Readonly<LeverageInfo> | undefined> {
    try {
      this.services.validateContext(request.context);
      this.services.invalidatePreviews(request.params.symbol);
      const value = await this.info(request);
      // Metadata and finance refresh follow the change without holding up its confirmation.
      void Promise.resolve()
        .then(() => this.services.refreshDependencies(request.params.symbol))
        .catch(() => {});
      return value;
    } catch {
      return undefined;
    }
  }
  async set(input: LeverageChangeRequest): Promise<TradingCommandResult> {
    const request = snapshot(input);
    this.assert(request, true);
    const lease = this.reviews.claim(request.previewToken, lease =>
      equalData(lease.request.params, request.params) &&
      sameAccountGeneration(lease.request.context, request.context) &&
      !lease.preview?.errors?.length,
      false,
    );
    if (!lease)
      throw new TradingError(
        "invalid-input",
        "Review the current leverage before applying it.",
      );
    const before = await this.info(request);
    this.assert(request, true);
    this.validateValue(request.params.leverage, before);
    if (!equalData(before, lease.info))
      throw new TradingError(
        "stale-context",
        "Leverage changed. Review its current value.",
      );
    const method = this.services.broker.setLeverage;
    if (!method)
      throw new TradingError(
        "configuration",
        "The broker does not support leverage changes.",
      );
    let actual: Readonly<LeverageInfo> | undefined;
    let active = true;
    let confirming: Promise<void> | undefined;
    const confirm = (): Promise<void> => {
      if (!active) return Promise.resolve();
      return confirming ??= this.confirm(request).then(value => {
        if (!active) return;
        actual = value;
        this.services.coordinator.changed();
      }).finally(() => { confirming = undefined; });
    };
    return this.services.coordinator.execute<LeverageSetResult>({
      keys: [commandKeys.leverage(request.context.accountId, request.params.symbol)],
      dispatch: async () => {
        this.assert(request, true);
        if (!this.reviews.claim(request.previewToken, candidate => candidate === lease))
          throw new TradingError(
            "stale-context",
            "Review the current leverage before applying it.",
          );
        const response = await method.call(
          this.services.broker,
          structuredClone(request.params),
        );
        // The broker accepted the change. Confirmation reads are a side effect: their failure leaves the
        // outcome unconfirmed (with one refresh at the deadline), never rejected.
        void confirm();
        return response;
      },
      match: (response) => {
        try {
          this.services.validateContext(request.context);
        } catch {
          return undefined;
        }
        if (!actual || !response || !Number.isFinite(response.leverage))
          return undefined;
        const expected = request.params.leverage;
        if (actual.leverage === expected && response.leverage === expected)
          return { outcome: "confirmed", entityIds: [request.params.symbol] };
        return { outcome: "changed", entityIds: [request.params.symbol] };
      },
      refresh: () => {
        // Account snapshots have no leverage confirmation channel; retry its explicit read as well.
        // Read before hydration temporarily makes the command context unavailable.
        void confirm().then(() => { if (active) this.services.refresh(); });
      },
      dispose: () => { active = false; },
    });
  }
}
