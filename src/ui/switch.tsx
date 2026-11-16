import { Switch } from "@kobalte/core/switch";

/** On/off control on Kobalte Switch; its hidden input keeps native checkbox semantics for forms and tests. */
export function TradingSwitch(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <Switch
      class="trading-switch-root"
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onChange}
    >
      <Switch.Input aria-label={props.label} />
      <Switch.Control class="trading-switch">
        <Switch.Thumb class="trading-switch-thumb" />
      </Switch.Control>
    </Switch>
  );
}
