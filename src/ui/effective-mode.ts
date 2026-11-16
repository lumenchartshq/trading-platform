import { createMemo } from "solid-js";
export interface ModeSelection<T> { readonly mode: T; readonly revision: number; }
export interface EffectiveMode<T> { readonly selection: ModeSelection<T>; readonly mode: T; }
/** A fallback stays selected until the next explicit choice, even if availability returns. */
export function resolveEffectiveMode<T>(
  previous: EffectiveMode<T> | undefined,
  selection: ModeSelection<T>,
  normalize: (mode: T) => T,
): EffectiveMode<T> {
  const requested = previous?.selection === selection ? previous.mode : selection.mode;
  return { selection, mode: normalize(requested) };
}
export function useEffectiveMode<T>(selection: () => ModeSelection<T>, normalize: (mode: T) => T): () => T {
  const effective = createMemo<EffectiveMode<T>>(previous => resolveEffectiveMode(previous, selection(), normalize));
  return () => effective().mode;
}
