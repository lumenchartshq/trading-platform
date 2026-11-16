import { userMessage } from "./errors.js";
import { ConnectionStatus } from "../contracts/broker.js";
import type { AccountMetainfo, AccountManagerInfo, IBrokerTerminal, IBrokerConnectionAdapterHost } from "../contracts/broker.js";
import type { TradingClock } from "../contracts/ports.js";
import type { CapabilityFlags } from "./capabilities.js";
import type { ValueStore } from "./value-store.js";
import { connectionNotice, type TradingState, type ConnectionPhase } from "./trading-state.js";
import { deferred } from "./deferred.js";
import { TradingError } from "./errors.js";
interface Services {
  readonly state: TradingState;
  readonly accounts: ValueStore<readonly AccountMetainfo[]>;
  readonly clock: TradingClock;
  /** Milliseconds to wait for `currentAccountUpdate` after the setter. */
  readonly switchDeadline: number;
  /** Read deadline in milliseconds: a repeated Connected inside it is coalesced; after it the account is re-read. */
  readonly readDeadline: number;
  readonly completion: ReturnType<typeof deferred<void>>;
  readonly brokerReady: ReturnType<typeof deferred<IBrokerTerminal>>;
  broker(): IBrokerTerminal;
  read<T>(load: () => T | Promise<T>, epoch?: number): Promise<T>;
  phase(phase: Exclude<ConnectionPhase, "initializing">, status?: ConnectionStatus, error?: string): void;
  flags(): CapabilityFlags;
  updatePolicy(): void;
  managerInfo(value: AccountManagerInfo): void;
  beginSnapshots(flags: CapabilityFlags): Promise<unknown>[];
  resume(): void;
  suspend(clear: boolean): void;
  invalidateReads(): void;
  invalidateState(clear: boolean): void;
  changed(): void;
  disposeResources(): void;
}
/** Bound for pushes buffered before identity is established; the oldest are dropped first. */
export const EARLY_PUSH_LIMIT = 1000;
/** Owns account identity, hydration, switch deadlines and constructor-push replay. */
export class AccountLifecycle {
  private aliveState = true;
  private constructing = true;
  private switching = false;
  private identityEstablished = false;
  private generationState = 0;
  private hydration: Promise<void> | undefined;
  private switchOperation: ReturnType<typeof deferred<void>> | undefined;
  private switchTimer: unknown;
  private switchTarget: string | undefined;
  private readonly early: (() => void)[] = [];
  /** Last connection status seen, to coalesce repeated Connected notifications. */
  private lastStatus: ConnectionStatus | undefined;
  /** When the current Connected was announced, on the session clock. */
  private connectedAt = 0;
  constructor(private readonly services: Services) {}
  get alive(): boolean { return this.aliveState; }
  get generation(): number { return this.generationState; }
  private clearSwitchTimer(): void {
    if (this.switchTimer !== undefined) this.services.clock.clearTimeout(this.switchTimer);
    this.switchTimer = undefined;
  }
  private invalidateHydration(clear: boolean): void {
    this.services.suspend(clear);
    this.generationState++;
    this.services.invalidateReads();
    this.identityEstablished = false;
    // Pushes received before this point belong to the old connection or account.
    if (!this.constructing) this.early.length = 0;
    this.services.invalidateState(clear);
    this.hydration = undefined;
  }
  readonly requestRefresh = (): void => { void this.refresh().catch(() => {}); };
  readonly applyUpdate = (apply: () => void): void => {
    if (!this.aliveState || this.switching) return;
    if (this.constructing || !this.identityEstablished) {
      // Buffer only for constructor replay or an in-flight hydration; a later snapshot is authoritative otherwise.
      if (!this.constructing && this.hydration === undefined) return;
      if (this.early.length >= EARLY_PUSH_LIMIT) this.early.shift();
      this.early.push(apply);
      return;
    }
    apply();
    this.services.changed();
  };
  start(): void {
    this.constructing = false;
    this.lastStatus = this.services.broker().connectionStatus();
    this.connectedAt = this.services.clock.now();
    this.services.updatePolicy();
    if (this.lastStatus === ConnectionStatus.Connected) {
      void this.hydrate().catch(() => { /* Ready/state exposes read errors for explicit retry. */ });
    } else if (this.lastStatus !== ConnectionStatus.Connecting) {
      this.services.phase("disconnected", this.lastStatus);
    }
  }
  constructionFailed(cause: unknown): void {
    this.constructing = false;
    this.services.completion.reject(cause);
    this.services.brokerReady.reject(cause);
    this.services.phase("error", ConnectionStatus.Error, userMessage(cause, "The broker is unavailable."));
    this.aliveState = false;
    this.services.disposeResources();
  }
  readonly hydrate = async (): Promise<void> => {
    if (
      !this.aliveState ||
      this.switching ||
      this.status() !== ConnectionStatus.Connected
    )
      return;
    if (this.hydration) return this.hydration;
    const epoch = this.generationState;
    this.services.phase("hydrating", ConnectionStatus.Connected);
    const operation = (async () => {
      const id = this.services.broker().currentAccount();
      const metadata = await this.services.read(() => this.services.broker().accountsMetainfo(), epoch);
      if (!metadata.some((account) => account.id === id))
        throw new TradingError(
          "configuration",
          "The current account is unavailable.",
        );
      if (metadata.length > 1 && !this.services.broker().setCurrentAccount)
        throw new TradingError(
          "configuration",
          "Account selection is unavailable.",
        );
      if (epoch !== this.generationState || !this.aliveState) return;
      const previous = this.services.state.connection.get().accountId;
      if (previous && previous !== id) this.services.state.clearAccount();
      this.identityEstablished = true;
      this.services.accounts.set(metadata);
      this.services.managerInfo(this.services.broker().accountManagerInfo());
      this.services.state.connection.set({
        status: ConnectionStatus.Connected,
        phase: "hydrating",
        generation: this.generationState,
        accountId: id,
      });
      this.services.updatePolicy();
      const reads = this.services.beginSnapshots(this.services.flags());
      // Snapshot buffers now exist. Constructor pushes must replay after the returned snapshots.
      for (const apply of this.early.splice(0)) apply();
      await Promise.all(reads);
      if (!this.aliveState || epoch !== this.generationState) return;
      this.services.resume();
      this.services.phase("ready", ConnectionStatus.Connected);
    })();
    this.hydration = operation;
    try {
      await operation;
      if (
        this.aliveState &&
        epoch === this.generationState &&
        this.services.state.connection.get().phase === "ready"
      )
        this.services.completion.resolve();
    } catch (cause) {
      // Pushes buffered for this hydration pre-date the snapshot a retry will read; they must not replay.
      this.early.length = 0;
      if (epoch === this.generationState && this.aliveState) {
        this.services.phase(
          "error",
          ConnectionStatus.Error,
          userMessage(cause, "Account information is unavailable."),
        );
        // `ready` rejects once; the session stays alive so `refresh()` can retry the hydration.
        this.services.completion.reject(cause);
      }
      throw cause;
    } finally {
      if (this.hydration === operation) this.hydration = undefined;
    }
  };
  readonly refresh = (): Promise<void> => {
    if (!this.aliveState)
      return Promise.reject(
        TradingError.disposed(),
      );
    if (!this.switching && this.status() !== ConnectionStatus.Connected)
      return Promise.reject(TradingError.disconnected());
    return this.hydrate();
  };
  private settleAccountSwitch(operation: ReturnType<typeof deferred<void>>, cause?: unknown): void {
    if (this.switchOperation !== operation) return;
    this.clearSwitchTimer();
    this.switchOperation = undefined;
    this.switchTarget = undefined;
    this.switching = false;
    if (cause !== undefined) operation.reject(cause);
    else operation.resolve();
  };
  readonly selectAccount = async (accountId: string): Promise<void> => {
    if (!this.aliveState)
      throw TradingError.disposed();
    if (this.switchOperation)
      throw new TradingError(
        "operation-pending",
        "An account change is pending.",
      );
    const target = this.services.accounts.get().find((account) => account.id === accountId);
    if (!target)
      throw new TradingError("invalid-input", "Choose an available account.");
    const method = this.services.broker().setCurrentAccount;
    if (!method)
      throw new TradingError(
        "unsupported",
        "Account selection is unavailable.",
      );
    const operation = deferred<void>();
    this.switchOperation = operation;
    this.switchTarget = target.id;
    this.switching = true;
    this.invalidateHydration(true);
    this.services.phase("switching");
    this.switchTimer = this.services.clock.setTimeout(() => {
      if (this.switchOperation !== operation) return;
      const error = new TradingError(
        "broker-unavailable",
        "The account change is unconfirmed.",
      );
      this.settleAccountSwitch(operation, error);
      this.services.phase(
        "error",
        ConnectionStatus.Connected,
        "The account change is unconfirmed. Refresh to check the current account.",
      );
    }, this.services.switchDeadline);
    const failed = (cause: unknown) => {
      if (this.switchOperation !== operation) return;
      this.settleAccountSwitch(
        operation,
        cause ??
          new TradingError(
            "broker-rejected",
            "The account could not be changed.",
          ),
      );
      this.invalidateHydration(false);
      this.services.phase(
        "error",
        undefined,
        userMessage(cause, "The account could not be changed."),
      );
      // Re-read the account the broker still has selected, so its tables return.
      this.requestRefresh();
    };
    try {
      // The pinned setter returns void. Also contain runtime Promise rejections,
      // without treating their resolution as an account-change confirmation.
      Promise.resolve(method.call(this.services.broker(), target.id)).catch(failed);
    } catch (cause) {
      failed(cause);
    }
    return operation.promise;
  };
  readonly accountChanged = (): void => {
    if (!this.aliveState) return;
    if (this.constructing) {
      this.early.push(this.accountChanged);
      return;
    }
    const operation = this.switchOperation;
    if (operation && this.services.broker().currentAccount() !== this.switchTarget)
      this.settleAccountSwitch(
        operation,
        new TradingError(
          "stale-context",
          "The broker selected a different account.",
        ),
      );
    this.clearSwitchTimer();
    // Stop waiting for notification, but retain the operation until hydration
    // finishes. Duplicate notifications supersede only the old hydration.
    this.switching = false;
    this.invalidateHydration(true);
    const epoch = this.generationState;
    void this.hydrate().then(
      () => {
        if (
          operation &&
          epoch === this.generationState &&
          this.services.state.connection.get().phase === "ready"
        )
          this.settleAccountSwitch(operation);
      },
      (cause) => {
        if (operation && epoch === this.generationState)
          this.settleAccountSwitch(operation, cause);
      },
    );
  };
  readonly destroy = (): void => {
    if (!this.aliveState) return;
    this.aliveState = false;
    this.generationState++;
    this.services.phase("disposed");
    this.services.completion.reject(
      TradingError.disposed(),
    );
    this.services.brokerReady.reject(
      TradingError.disposed(),
    );
    this.clearSwitchTimer();
    this.switchOperation?.reject(
      TradingError.disposed(),
    );
    this.switchOperation = undefined;
    this.early.length = 0;
    this.services.disposeResources();
  };
  /** The last announced connection status; the broker's getter until the first announcement. */
  private status(): ConnectionStatus {
    return this.lastStatus ?? this.services.broker().connectionStatus();
  }
  readonly connectionChanged: IBrokerConnectionAdapterHost["connectionStatusUpdate"] = (announced, info) => {
      if (!this.aliveState || this.constructing) return;
      // The notification's own status is authoritative: an adapter may notify before its getter changes.
      const status = validStatus(announced) ? announced : this.services.broker().connectionStatus();
      if (this.switchOperation)
        this.settleAccountSwitch(
          this.switchOperation,
          new TradingError(
            "disconnected",
            "The connection changed while selecting an account.",
          ),
        );
      if (status === ConnectionStatus.Connected) {
        // A repeated Connected with no disconnect in between keeps the current (or in-flight) hydration while
        // inside the read deadline. Later, it is a resync request (adapters re-announce after a transparent
        // socket reconnect), so the account is re-read.
        const phase = this.services.state.connection.get().phase;
        const now = this.services.clock.now();
        if (
          this.lastStatus === ConnectionStatus.Connected &&
          (this.hydration || phase === "ready") &&
          now - this.connectedAt < this.services.readDeadline
        )
          return;
        this.lastStatus = status;
        this.connectedAt = now;
        this.invalidateHydration(false);
        this.requestRefresh();
      } else {
        this.lastStatus = status;
        this.invalidateHydration(false);
        this.services.phase("disconnected", status);
        this.services.state.connection.set({
          ...this.services.state.connection.get(),
          notice: connectionNotice(info),
        });
      }
  };
}
const connectionStatuses: ReadonlySet<unknown> = new Set([
  ConnectionStatus.Connected,
  ConnectionStatus.Connecting,
  ConnectionStatus.Disconnected,
  ConnectionStatus.Error,
]);
function validStatus(value: unknown): value is ConnectionStatus {
  return connectionStatuses.has(value);
}
