import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual";
import { createEffect, createMemo, For, on, type Accessor, type JSX } from "solid-js";

export interface VirtualListProps {
  count: number;
  residentCount?: number;
  rowHeight: number;
  itemKey(index: number): string;
  render(index: Accessor<number>): JSX.Element;
  class?: string;
  style?: JSX.CSSProperties;
  label: string;
  role?: JSX.HTMLAttributes<HTMLDivElement>["role"];
  dataId?: string;
  resetKey?: string;
  selectedIndex?: number;
  followSelection?: boolean;
  canLoadMore?: boolean;
  onEndReached?(): void;
  onRange?(start: number, end: number, indices: readonly number[]): void;
}

/** One bounded viewport shared by chart and standalone trading UI. No provider/state ownership. */
export function VirtualList(props: VirtualListProps) {
  let scroll: HTMLDivElement | undefined;
  const virtual = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() { return props.count; },
    getScrollElement: () => scroll ?? null,
    get estimateSize() { return () => props.rowHeight; },
    getItemKey: index => props.itemKey(index),
    overscan: 6,
    initialRect: { width: 0, height: 480 },
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      const focused = scroll?.querySelector<HTMLElement>("[data-virtual-index]:focus-within");
      const index = Number(focused?.dataset.virtualIndex);
      if (focused && index >= 0 && index < props.count && !indexes.includes(index)) indexes.push(index);
      return indexes.sort((a, b) => a - b);
    },
  });
  // Host snapshots change on hover/restoration without changing the search.
  const resetKey = createMemo(() => props.resetKey);
  const selection = createMemo(() => props.followSelection ? props.selectedIndex : undefined);
  createEffect(on(resetKey, () => {
    if (scroll) scroll.scrollTop = 0;
    if (scroll?.ownerDocument.defaultView?.requestAnimationFrame) virtual.scrollToOffset(0);
  }, { defer: true }));
  createEffect(on(selection, index => {
    if (scroll?.ownerDocument.defaultView?.requestAnimationFrame && index !== undefined && index < props.count)
      virtual.scrollToIndex(index, { align: "auto" });
  }));
  createEffect(() => {
    const items = virtual.getVirtualItems();
    if (!items.length) return;
    props.onRange?.(items[0]!.index, items[items.length - 1]!.index, items.map(item => item.index));
    if (props.canLoadMore && items[items.length - 1]!.index >= props.count - 1 - Math.ceil(72 / props.rowHeight))
      props.onEndReached?.();
  });
  return <div ref={scroll} class={props.class} style={{ ...props.style, overflow: "auto", position: "relative", "overflow-anchor": "none" }}
    role={props.role ?? "listbox"} aria-label={props.label} data-id={props.dataId} data-logical-count={props.count} data-resident-count={props.residentCount}
    onScroll={() => {
      if (scroll && props.canLoadMore && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 72) props.onEndReached?.();
    }}>
    <div style={{ height: `${virtual.getTotalSize()}px`, position: "relative", width: "100%" }}>
      <For each={virtual.getVirtualItems()}>{item => <div data-virtual-index={item.index} data-virtual-key={String(item.key)}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${props.rowHeight}px`, transform: `translateY(${item.start}px)` }}>
        {props.render(() => item.index)}
      </div>}</For>
    </div>
  </div>;
}
