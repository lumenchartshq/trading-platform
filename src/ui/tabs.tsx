import { Tabs } from "@kobalte/core/tabs";
import { For, type JSX } from "solid-js";

export interface TradingTab<T extends string | number> {
  readonly value: T;
  readonly label: JSX.Element;
  readonly disabled?: boolean;
}

/**
 * Tab row on Kobalte Tabs: arrow keys move between tabs and select them; panels stay with the caller.
 * Triggers keep the `trading-button` look so existing density styles apply.
 */
export function TradingTabs<T extends string | number>(props: {
  label: string;
  value: T;
  tabs: readonly TradingTab<T>[];
  class: string;
  disabled?: boolean;
  hidden?: boolean;
  onChange(value: T): void;
}) {
  const find = (key: string) =>
    props.tabs.find((tab) => String(tab.value) === key);
  return (
    <Tabs
      value={String(props.value)}
      onChange={(key) => {
        const tab = find(key);
        if (tab && tab.value !== props.value) props.onChange(tab.value);
      }}
      disabled={props.disabled}
      hidden={props.hidden}
    >
      <Tabs.List class={props.class} aria-label={props.label}>
        <For each={props.tabs}>
          {(tab) => (
            <Tabs.Trigger
              class="trading-button"
              value={String(tab.value)}
              disabled={tab.disabled}
            >
              {tab.label}
            </Tabs.Trigger>
          )}
        </For>
      </Tabs.List>
    </Tabs>
  );
}
