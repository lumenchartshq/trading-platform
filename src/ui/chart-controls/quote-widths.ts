import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

type QuotePart = "buy" | "sell" | "spread";
const emptyWidths = () => ({ buy: 0, sell: 0, spread: 0 });

/** One chart symbol owns the high-water marks, including while controls are hidden. */
export function useQuoteWidths(readSymbol: () => string) {
  const symbol = createMemo(readSymbol);
  const [widths, setWidths] = createSignal(emptyWidths());
  const [revision, setRevision] = createSignal(0);
  const elements = new Map<QuotePart, HTMLElement>();
  createEffect(on(symbol, () => setWidths(emptyWidths())));
  createEffect(() => {
    const identity = symbol();
    revision();
    if (typeof ResizeObserver === "undefined") return;
    let active = true;
    const targets = new Map([...elements].map(([part, element]) => [element, part]));
    const observer = new ResizeObserver((entries) => {
      if (!active || symbol() !== identity) return;
      setWidths((previous) => {
        const next = { ...previous };
        let changed = false;
        for (const entry of entries) {
          const part = targets.get(entry.target as HTMLElement);
          const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          if (!part || !Number.isFinite(width) || width <= next[part]) continue;
          next[part] = width;
          changed = true;
        }
        return changed ? next : previous;
      });
    });
    for (const element of targets.keys()) observer.observe(element, { box: "border-box" });
    onCleanup(() => {
      active = false;
      observer.disconnect();
    });
  });
  return {
    minimum: (part: QuotePart) => `${Math.max(part === "spread" ? 0 : 64, widths()[part])}px`,
    observe(part: QuotePart, element: HTMLElement) {
      elements.set(part, element);
      setRevision((value) => value + 1);
      onCleanup(() => {
        if (elements.get(part) !== element) return;
        elements.delete(part);
        setRevision((value) => value + 1);
      });
    },
  };
}

export type QuoteWidths = ReturnType<typeof useQuoteWidths>;
