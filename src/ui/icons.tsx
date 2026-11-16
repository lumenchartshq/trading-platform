export function SwapIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 8h14m-3-3 3 3-3 3M19 16H5m3-3-3 3 3 3" />
  </svg>;
}
export function CloseIcon(props: { inset?: 6 }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={props.inset === 6 ? "m6 6 12 12M18 6 6 18" : "m5 5 14 14M19 5 5 19"} />
  </svg>;
}
