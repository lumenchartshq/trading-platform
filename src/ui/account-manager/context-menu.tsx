import { ContextMenu } from "@kobalte/core/context-menu";
import {
  For,
  Show,
  createSignal,
  onCleanup,
  useContext,
  type JSX,
} from "solid-js";
import { TradingPopupMount } from "../popup-mount.js";
import type {
  ActionDescription,
  ActionMetaInfo,
} from "../../contracts/broker.js";

/** Keep only well-formed provider items; callbacks are retained, everything else is read once. */
export function normalizeMenuItems(value: unknown): ActionMetaInfo[] {
  if (!Array.isArray(value)) return [];
  const items: ActionMetaInfo[] = [];
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<ActionMetaInfo & { action: unknown }>;
    if (entry.separator === true || entry.text === "-") {
      items.push({ separator: true });
      continue;
    }
    if (typeof entry.action !== "function" || typeof entry.text !== "string")
      continue;
    items.push({
      text: entry.text,
      tooltip: typeof entry.tooltip === "string" ? entry.tooltip : undefined,
      shortcut: typeof entry.shortcut === "string" ? entry.shortcut : undefined,
      checkable: entry.checkable === true,
      checked:
        typeof entry.checkedStateSource === "function"
          ? safeChecked(entry.checkedStateSource)
          : entry.checked === true,
      enabled: entry.enabled !== false,
      externalLink: entry.externalLink === true,
      icon:
        typeof entry.icon === "string" && /^\s*<svg[\s>]/i.test(entry.icon)
          ? entry.icon.slice(0, 20000)
          : undefined,
      action: entry.action as (description?: ActionDescription) => void,
    });
  }
  return items;
}
function safeChecked(source: () => boolean): boolean {
  try {
    return source() === true;
  } catch {
    return false;
  }
}

/** Row context menu on Kobalte ContextMenu: items come from the row under the pointer and may load asynchronously. */
export function RowContextMenu(props: {
  /** Undefined when the target is not an actionable row (the menu stays closed). */
  items(
    rowId: string,
    event: MouseEvent,
  ): { initial?: readonly ActionMetaInfo[]; load?: Promise<readonly ActionMetaInfo[]> } | undefined;
  children: JSX.Element;
}) {
  const popupMount = useContext(TradingPopupMount);
  const [items, setItems] = createSignal<readonly ActionMetaInfo[]>();
  let sequence = 0;
  onCleanup(() => sequence++);
  const run = (item: ActionMetaInfo) => {
    if (item.separator || item.enabled === false || !("action" in item)) return;
    try {
      item.action({ ...item });
    } catch {
      /* Provider actions own their own failure reporting. */
    }
  };
  /** Stage the event row's items; false when the target is not an actionable row. */
  const prepare = (event: MouseEvent): boolean => {
    const row = (event.target as Element | null)?.closest<HTMLElement>(
      "tr[data-row-id]",
    );
    const request = row?.dataset.rowId
      ? props.items(row.dataset.rowId, event)
      : undefined;
    const current = ++sequence;
    setItems(request?.initial);
    if (!request) return false;
    void request.load?.then(
      (loaded) => {
        if (current === sequence) setItems(loaded);
      },
      () => {
        if (current === sequence) setItems(request.initial);
      },
    );
    return true;
  };
  return (
    <ContextMenu
      onOpenChange={(open) => {
        // A late provider result must not repopulate a closed menu, and a closed menu keeps no row.
        if (open) return;
        sequence++;
        setItems(undefined);
      }}
    >
      <ContextMenu.Trigger
        as="div"
        class="trading-context-target"
        onContextMenu={(event: MouseEvent) => {
          if (!prepare(event)) event.preventDefault();
        }}
        // Touch long-press opens from pointerdown without a contextmenu event (iOS Safari),
        // so the pressed row's items are staged here too.
        onPointerDown={(event: PointerEvent) => {
          if (event.pointerType !== "mouse") prepare(event);
        }}
      >
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal mount={popupMount}>
        <ContextMenu.Content
          class="lumen-trading trading-context-menu"
          aria-label="Row actions"
        >
          <Show
            when={items()}
            fallback={
              <ContextMenu.Item class="trading-menu-row" disabled>
                Loading actions…
              </ContextMenu.Item>
            }
          >
            <Show when={items()?.length === 0}>
              <ContextMenu.Item class="trading-menu-row" disabled>
                No actions available
              </ContextMenu.Item>
            </Show>
            <For each={items()}>
              {(item) => (
                <Show
                  when={!item.separator}
                  fallback={
                    <ContextMenu.Separator class="trading-menu-separator" />
                  }
                >
                  <Show
                    when={item.checkable}
                    fallback={
                      <ContextMenu.Item
                        class="trading-menu-row"
                        disabled={item.enabled === false}
                        title={item.tooltip}
                        onSelect={() => run(item)}
                      >
                        <Show when={item.icon}>
                          {(icon) => (
                            // An <img> renders broker SVG without executing any script it contains.
                            <img
                              class="trading-menu-icon"
                              alt=""
                              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon())}`}
                            />
                          )}
                        </Show>
                        <span>{item.text}</span>
                        <Show when={item.externalLink}>
                          <span class="trading-menu-external" aria-label="Opens an external link">
                            ↗
                          </span>
                        </Show>
                        <Show when={item.shortcut}>
                          <kbd>{item.shortcut}</kbd>
                        </Show>
                      </ContextMenu.Item>
                    }
                  >
                    <ContextMenu.CheckboxItem
                      class="trading-menu-row"
                      checked={item.checked === true}
                      disabled={item.enabled === false}
                      title={item.tooltip}
                      onChange={() => run(item)}
                    >
                      <span>{item.text}</span>
                    </ContextMenu.CheckboxItem>
                  </Show>
                </Show>
              )}
            </For>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  );
}
