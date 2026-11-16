/** Entry for the optional trading asset that the chart widget loads; the chart build bundles it. */
import { createTradingModule } from "./asset.js";
declare const __LUMEN_TRADING_BUILD_ID__: string;
export const abi = 1;
export const buildId =
  typeof __LUMEN_TRADING_BUILD_ID__ === "string"
    ? __LUMEN_TRADING_BUILD_ID__
    : "source";
export const mount = createTradingModule(buildId).mount;
