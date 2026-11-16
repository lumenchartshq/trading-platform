/** Kinds whose commands serialize per entity. Matches bracket parent kinds. */
export type CommandEntityKind = "order" | "position" | "individualPosition";

/** The only place coordinator lock keys are spelled; commands sharing a key never run concurrently. */
export const commandKeys = {
  entity: (kind: CommandEntityKind, id: string) => `${kind}:${id}`,
  order: (id: string) => commandKeys.entity("order", id),
  position: (id: string, individual = false) => commandKeys.entity(individual ? "individualPosition" : "position", id),
  /** Account/symbol placements, including fallback closes that place an opposite order. */
  place: (accountId: string, symbol: string) => `place:${accountId}:${symbol}`,
  leverage: (accountId: string, symbol: string) => `leverage:${accountId}:${symbol}`,
};
