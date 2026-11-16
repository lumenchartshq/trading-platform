export type TradingErrorCode = 'invalid-input' | 'unsupported' | 'configuration' | 'disconnected' | 'stale-context' | 'operation-pending' | 'broker-rejected' | 'broker-unavailable' | 'asset-unavailable' | 'abi-mismatch' | 'disposed';
export class TradingError extends Error {
  static disposed(message = 'This trading session is closed.'): TradingError {
    return new TradingError('disposed', message);
  }
  static accountChanged(): TradingError {
    return new TradingError('stale-context', 'The trading account changed.');
  }
  static disconnected(): TradingError {
    return new TradingError('disconnected', 'Reconnect before trading.');
  }
  static brokerUnavailable(): TradingError {
    return new TradingError('broker-unavailable', 'The broker is unavailable.');
  }
  static positionChanged(): TradingError {
    return new TradingError('stale-context', 'This position changed. Review its current details.');
  }
  constructor(readonly code: TradingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TradingError';
  }
}

const rejectionCodes: Readonly<Record<string, TradingErrorCode>> = {
  rejected: 'broker-rejected',
  unavailable: 'broker-unavailable',
  invalid: 'invalid-input',
  unsupported: 'unsupported',
};
/**
 * Maps what an adapter threw to a `TradingError`. A `BrokerRejection` shape (`{ code, message }`, as a plain
 * object or on an Error) keeps the adapter's user-safe message; anything else gets the generic fallback wording.
 */
export function brokerRejectionError(cause: unknown, fallback: string): TradingError {
  if (cause instanceof TradingError) return cause;
  if (cause && typeof cause === 'object') {
    const code = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
    const message = Object.getOwnPropertyDescriptor(cause, 'message')?.value;
    const mapped = typeof code === 'string' ? rejectionCodes[code] : undefined;
    const bounded = typeof message === 'string' ? boundMessage(message) : '';
    if (mapped && bounded) return new TradingError(mapped, bounded, { cause });
  }
  return new TradingError('broker-rejected', fallback, { cause });
}

/** Most characters of a broker-supplied message shown to users. */
export const MAX_BROKER_MESSAGE = 240;
/** One line of plain text: control characters and line breaks become spaces, and long text is cut with an ellipsis. */
export function boundMessage(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > MAX_BROKER_MESSAGE ? `${line.slice(0, MAX_BROKER_MESSAGE - 1).trimEnd()}…` : line;
}
/**
 * The text a user may see for a failure: the platform's own wording for a `TradingError`, the broker's bounded
 * message for a `BrokerRejection`, and `fallback` for anything else (raw provider errors never reach the UI).
 */
export function userMessage(cause: unknown, fallback: string): string {
  if (cause instanceof TradingError) return cause.message;
  if (cause && typeof cause === 'object') {
    const code = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
    const message = Object.getOwnPropertyDescriptor(cause, 'message')?.value;
    if (typeof code === 'string' && code in rejectionCodes && typeof message === 'string') {
      const bounded = boundMessage(message);
      if (bounded) return bounded;
    }
  }
  return fallback;
}
