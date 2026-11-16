/** Decimal places, including scientific notation, within the formatter's supported range. */
export function decimalPlaces(value: number): number {
  const [base, exponent = "0"] = String(value).split("e");
  return Math.min(
    20,
    Math.max(0, (base.split(".")[1]?.length ?? 0) - Number(exponent)),
  );
}

/** A percentage with two decimals ("62.50%"), or "—" when unknown. */
export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
