import { Show } from "solid-js";
import { Side, StopType } from "../../contracts/broker.js";
import type { Order } from "../../contracts/broker.js";
import type { OrderEditability } from "../../core/order-modification.js";
import { NumberField } from "../primitives.js";

const ownerNames = {
  order: "order",
  position: "position",
  individualPosition: "position",
} as const;

/** Read-only identity of the order being modified; editable fields render separately. */
export function ModificationSummary(props: {
  order: Readonly<Order>;
  editability: OrderEditability;
  typeName: string;
  price: (value: number | undefined) => string;
}) {
  const side = () => (props.order.side === Side.Buy ? "Buy" : "Sell");
  const owner = () => {
    const kind = props.editability.protection;
    if (!kind || !("parentId" in props.order)) return undefined;
    return `Protects ${ownerNames[kind]} ${props.order.parentId}`;
  };
  const fixedPrice = () => {
    if (props.editability.price || props.order.stopType === StopType.TrailingStop)
      return "";
    const price = props.order.limitPrice ?? props.order.stopPrice;
    return price === undefined ? "" : ` @ ${props.price(price)}`;
  };
  return (
    <div class="trading-modify-summary" data-ui="modification-summary">
      <p>
        {side()} {props.typeName} {props.order.qty}
        {fixedPrice()}
      </p>
      <p class="trading-muted">
        Order {props.order.id}
        <Show when={owner()}>{(text) => ` · ${text()}`}</Show>
      </p>
    </div>
  );
}

/** A protection child's allocated quantity; risk-based sizing belongs to the parent ticket. */
export function ChildQuantityField(props: {
  qty: number;
  disabled: boolean;
  update: (qty: number | undefined) => void;
}) {
  return (
    <NumberField
      label="Protected quantity"
      value={props.qty}
      min={0}
      disabled={props.disabled}
      onChange={props.update}
    />
  );
}

/** A trailing child is edited by its distance; its price is broker-owned and shown read-only. */
export function TrailingDistanceField(props: {
  distance?: number;
  reportedPrice?: number;
  disabled: boolean;
  price: (value: number | undefined) => string;
  update: (distance: number | undefined) => void;
}) {
  return (
    <div class="trading-trailing-edit" data-ui="trailing-distance">
      <NumberField
        label="Trailing distance (pips)"
        value={props.distance}
        min={0}
        disabled={props.disabled}
        onChange={props.update}
      />
      <Show when={props.reportedPrice !== undefined}>
        <p class="trading-muted">
          Current stop price: {props.price(props.reportedPrice)}
        </p>
      </Show>
    </div>
  );
}
