import { formatPercent } from "../../core/number-precision.js";

/** "Protected size 62.50%" with its progress bar: the share of the quantity covered by exits. */
export function ProtectedSizeSummary(props: { readonly protectedQuantity: number; readonly quantity: number }) {
  const percentage = () => (props.quantity > 0 ? (props.protectedQuantity / props.quantity) * 100 : undefined);
  return (
    <>
      <label>
        Protected size <strong>{formatPercent(percentage())}</strong>
      </label>
      <progress aria-label="Protected size" max={props.quantity} value={props.protectedQuantity} />
    </>
  );
}
