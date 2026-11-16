/** Stable persisted namespace; callers retain ownership of suffix encoding and schema names. */
export function preferencesKey(namespace: string, suffix: string): string {
  return `lumen.trading.v1.${namespace}.${suffix}`;
}
