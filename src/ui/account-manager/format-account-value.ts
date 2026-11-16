import type { CustomTableElementFormatter, StandardFormatterName, TableFormatterInputs } from "../../contracts/broker.js";
import { formatStandard, type FormattedCell, type TableFormatContext } from "../../compat/formatters.js";
import { TradingError } from "../../core/errors.js";

/** One text formatting path for summary values, table cells and exported cells. */
export function formatAccountValue(
  formatter: string | undefined,
  values: readonly unknown[],
  options: {
    custom?: Pick<CustomTableElementFormatter, "formatText"> & Partial<Pick<CustomTableElementFormatter, "formatElement">>;
    customInput?: TableFormatterInputs & { priceFormatter?: TableFormatContext["price"] };
    element?: boolean;
    context?: TableFormatContext;
    showZeroValues?: boolean;
  },
): FormattedCell {
  let result: FormattedCell;
  if (options.custom) {
    const text = options.element && options.custom.formatElement
      ? ""
      : options.custom.formatText(options.customInput ?? { values: [...values] });
    result = { text };
  } else {
    if (!options.context) throw new TradingError("configuration", "Formatting is unavailable.");
    result = formatStandard(formatter as StandardFormatterName | undefined, values, options.context, options.showZeroValues);
  }
  if (typeof result.text !== "string")
    throw new TradingError("invalid-input", "A table formatter returned an invalid value.");
  return result;
}
