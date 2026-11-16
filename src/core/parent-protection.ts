import { childProtectionField, childProtectionValue, type ProtectionField } from "./protection-legs.js";
import type {
  Brackets,
  ExitLevel,
  Order,
} from "../contracts/broker.js";
import { TradingError } from "./errors.js";
import { PROTECTION_FIELDS } from "./protection-rules.js";

/** The five protection fields of an order or position, without the rest of the entity. */
export function protectionFields(source: Readonly<Brackets>): Brackets {
  const fields: Brackets = {};
  for (const field of PROTECTION_FIELDS) Object.assign(fields, { [field]: source[field] });
  return fields;
}
function hasProtectionFields(parent: Readonly<Brackets>): boolean {
  return (
    !!parent.exitLevels?.length ||
    parent.takeProfit !== undefined ||
    parent.stopLoss !== undefined ||
    parent.guaranteedStop !== undefined ||
    parent.trailingStopPips !== undefined
  );
}

type ChildGroups = Map<string | undefined, { qty: number; brackets: Brackets }>;
const stopFields = ["stopLoss", "guaranteedStop", "trailingStopPips"] as const;

function stale(message: string): never {
  throw new TradingError("stale-context", message);
}

/** Group active child legs by broker level ID; a leg may appear once per level. */
function childGroups(children: readonly Readonly<Order>[]): ChildGroups {
  const groups: ChildGroups = new Map();
  for (const child of children) {
    if (!("parentId" in child)) continue;
    let group = groups.get(child.exitLevelId);
    if (!group) {
      group = { qty: child.qty, brackets: {} };
      groups.set(child.exitLevelId, group);
    }
    if (group.qty !== child.qty)
      stale("Protection quantities changed. Review the trade again.");
    const field = childProtectionField(child);
    if (!field)
      throw new TradingError(
        "unsupported",
        "This protection order type cannot be edited.",
      );
    const value = childProtectionValue(child, field);
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      group.brackets[field] !== undefined
    )
      stale("Protection details are incomplete. Review the trade again.");
    group.brackets[field] = value;
  }
  return groups;
}

/** Fill legs the parent omitted; a leg the parent and its child disagree on is stale, never overwritten. */
function mergeLegs<T extends Brackets>(target: Readonly<T>, legs: Brackets): T {
  const merged = { ...target } as T;
  const targetStop = stopFields.find((field) => target[field] !== undefined);
  for (const field of Object.keys(legs) as ProtectionField[]) {
    const value = legs[field];
    if (
      targetStop &&
      field !== targetStop &&
      (stopFields as readonly string[]).includes(field)
    )
      stale("The stop style changed. Review the trade again.");
    if (target[field] === undefined) merged[field] = value;
    else if (target[field] !== value)
      stale("Protection prices changed. Review the trade again.");
  }
  return merged;
}

/**
 * Some providers report protection only as child orders, or report the parent's aggregate fields partially.
 * Retain broker IDs and allocation, never invent either, and never drop a leg that an active child proves exists.
 */
export function completeParentProtection<T extends Brackets & { qty: number }>(
  parent: Readonly<T>,
  children: readonly Readonly<Order>[],
): Readonly<T> {
  const groups = childGroups(children);
  if (hasProtectionFields(parent)) return reconcileParent(parent, groups);
  if (!groups.size) stale("Protection details are unavailable.");
  const unnamed = groups.get(undefined);
  if (unnamed) {
    if (groups.size !== 1 || unnamed.qty !== parent.qty)
      stale("Allocated protection needs a broker level ID.");
    return { ...parent, ...unnamed.brackets };
  }
  const levels: ExitLevel[] = [...groups].map(([id, group]) => ({
    id: id!,
    qty: group.qty,
    ...group.brackets,
    isExisting: true,
  }));
  return { ...parent, exitLevels: levels };
}

function reconcileParent<T extends Brackets & { qty: number }>(
  parent: Readonly<T>,
  groups: ChildGroups,
): Readonly<T> {
  if (!groups.size) return parent;
  const levels = parent.exitLevels;
  if (!levels?.length) {
    const [[, group], ...rest] = [...groups];
    if (rest.length || group.qty !== parent.qty)
      stale("Allocated protection needs current parent levels.");
    return mergeLegs(parent, group.brackets);
  }
  const ids = new Set(levels.map((level) => level.id));
  for (const id of groups.keys())
    if (id === undefined || !ids.has(id))
      stale("Protection levels changed. Review the trade again.");
  return {
    ...parent,
    exitLevels: levels.map((level) => {
      const group = groups.get(level.id);
      if (!group) return level;
      if (group.qty !== level.qty)
        stale("Protection quantities changed. Review the trade again.");
      return mergeLegs(level, group.brackets);
    }),
  };
}
