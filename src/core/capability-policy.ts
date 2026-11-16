import type {
  BrokerConfigFlags,
  OrderDurationMetaInfo,
  SingleBrokerMetaInfo,
  SymbolSpecificTradingOptions,
} from "../contracts/broker.js";
import type { ReadonlyValue } from "../contracts/ports.js";
import {
  normalizeBrokerConfig,
  resolveCapabilities,
  type CapabilityContext,
  type CapabilityPolicy,
} from "./capabilities.js";
import { ValueStore } from "./value-store.js";

export interface CapabilityPolicyOptions {
  readonly config?: SingleBrokerMetaInfo;
  /** Live context: broker methods, extensions and market-data availability. */
  readonly context: () => CapabilityContext;
  /** Symbol options and their revision; a new revision invalidates per-symbol policies. */
  readonly catalog: {
    options(symbol: string): SymbolSpecificTradingOptions | undefined;
    readonly revision: ReadonlyValue<number>;
  };
  /** Injectable for work-count tests. */
  readonly resolve?: typeof resolveCapabilities;
}

/**
 * Owns broker config, runtime patches and the published account policy, and memoises per-symbol policies.
 * Policies are pure functions of config, patch, symbol options and broker context, so they are cached until one
 * of those changes (`update`, a patch, durations or a symbol-options revision).
 */
export function createCapabilityPolicy(options: CapabilityPolicyOptions) {
  const resolve = options.resolve ?? resolveCapabilities;
  let config: SingleBrokerMetaInfo = normalizeBrokerConfig(options.config);
  let patch: Partial<BrokerConfigFlags> = {};
  const cache = new Map<string, CapabilityPolicy>();
  const policy = new ValueStore(resolve(config));
  const releaseRevision = options.catalog.revision.subscribe(() => cache.clear());
  function symbolPolicy(symbol?: string): CapabilityPolicy {
    const key = symbol ?? "";
    const cached = cache.get(key);
    if (cached) return cached;
    const context = options.context();
    const value = resolve(config, patch, symbol ? options.catalog.options(symbol) : undefined, context);
    // Until the broker exists its method dependencies are unknown; do not keep that answer.
    if (context.broker) cache.set(key, value);
    return value;
  }
  return {
    policy,
    get config(): SingleBrokerMetaInfo {
      return config;
    },
    symbolPolicy,
    /** Re-resolves the account policy after a context change; the caller publishes it. */
    resolveAccount(): CapabilityPolicy {
      cache.clear();
      return resolve(config, patch, {}, options.context());
    },
    patchConfig(changes: Partial<BrokerConfigFlags>): void {
      patch = { ...patch, ...changes };
      cache.clear();
    },
    setDurations(durations: OrderDurationMetaInfo[]): void {
      config = { ...config, durations };
      cache.clear();
    },
    destroy(): void {
      releaseRevision();
      cache.clear();
      policy.destroy();
    },
  };
}
export type CapabilityPolicyOwner = ReturnType<typeof createCapabilityPolicy>;
