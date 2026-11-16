import type { AccountMetainfo } from "../contracts/broker.js";

export type AccountKind = NonNullable<AccountMetainfo["type"]>;

/** `supportDemoLiveSwitcher`: offer Demo/Live only when the broker returns accounts of both types. */
export function accountTypeChoices(
  accounts: readonly Readonly<AccountMetainfo>[],
  enabled: boolean,
): readonly AccountKind[] {
  if (!enabled) return [];
  const kinds = new Set(accounts.map((account) => account.type));
  return kinds.has("demo") && kinds.has("live") ? ["demo", "live"] : [];
}

/** Accounts shown in the account picker: those of the selected type, or all without a switcher. */
export function accountsOfType(
  accounts: readonly Readonly<AccountMetainfo>[],
  type: AccountKind | undefined,
): readonly Readonly<AccountMetainfo>[] {
  if (!type) return accounts;
  return accounts.filter((account) => account.type === type);
}
