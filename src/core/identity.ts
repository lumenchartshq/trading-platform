import type { TradingChartBinding } from "../contracts/ports.js";

export interface AccountGeneration { readonly accountId?: string; readonly generation: number; }
export function sameAccountGeneration(left: AccountGeneration, right: AccountGeneration): boolean {
  return left.generation === right.generation && left.accountId === right.accountId;
}
/** Chart lifetime identity; validate the symbol separately when a command captures it. */
export function sameBinding(left: Pick<TradingChartBinding, "id" | "generation"> | undefined, right: Pick<TradingChartBinding, "id" | "generation">): boolean {
  return left?.id === right.id && left.generation === right.generation;
}
export function bindingKey(binding: Pick<TradingChartBinding, "id" | "generation">): string {
  return `${binding.id}:${binding.generation}`;
}
/** Currency of an account in the broker's account list; undefined while unknown. */
export function accountCurrency(
  accounts: readonly { readonly id: string; readonly currency?: string }[] | undefined,
  accountId: string | undefined,
): string | undefined {
  return accounts?.find((account) => account.id === accountId)?.currency;
}
