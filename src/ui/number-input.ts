/** Empty native number inputs have no value; callers choose their domain's missing sentinel. */
export function parseNumberInput(value: string): number | undefined {
  if (value === "") return undefined;
  return Number(value);
}
