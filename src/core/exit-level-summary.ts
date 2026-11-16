import type {
  ExitLevel,
  InstrumentInfo,
  Side,
} from "../contracts/broker.js";

/** A dimensionless ratio: every level shares the same instrument and side value per price unit. */
export function exitLevelRewardRisk(
  levels: readonly Readonly<ExitLevel>[],
  entry: number | undefined,
  side: Side,
  instrument: Pick<InstrumentInfo, "pipSize" | "minTick">,
): number | undefined {
  if (entry === undefined || !Number.isFinite(entry) || !levels.length)
    return undefined;
  let reward = 0;
  let risk = 0;
  for (const level of levels) {
    if (
      !Number.isFinite(level.qty) ||
      level.qty <= 0 ||
      level.takeProfit === undefined
    )
      return undefined;
    const profitDistance = (level.takeProfit - entry) * side;
    const stop = level.stopLoss ?? level.guaranteedStop;
    let lossDistance: number;
    if (stop !== undefined) lossDistance = (entry - stop) * side;
    else if (level.trailingStopPips !== undefined)
      lossDistance =
        level.trailingStopPips * (instrument.pipSize ?? instrument.minTick);
    else return undefined;
    if (
      !Number.isFinite(profitDistance) ||
      profitDistance <= 0 ||
      !Number.isFinite(lossDistance) ||
      lossDistance <= 0
    )
      return undefined;
    reward += profitDistance * level.qty;
    risk += lossDistance * level.qty;
  }
  const result = reward / risk;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}
