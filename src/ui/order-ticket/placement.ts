import type {
  TradingEnvironment,
  TradingFloatingBounds,
  TradingPresentationPort,
} from "../../contracts/ports.js";
import { ValueStore } from "../../core/value-store.js";
import { valueReader } from "../../core/readers.js";

interface Preferences {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}
interface DesiredPlacement {
  readonly mode: "docked" | "floating";
  readonly bounds?: TradingFloatingBounds;
}
export interface TicketPlacementState {
  readonly supported: boolean;
  readonly canFloat: boolean;
  readonly desiredFloating: boolean;
  readonly floating: boolean;
  readonly bounds: TradingFloatingBounds;
}
const preferenceKey = "ticket.placement";
function validBounds(value: unknown): value is TradingFloatingBounds {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Record<string, unknown>;
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    typeof bounds.width === "number" &&
    bounds.width > 0 &&
    typeof bounds.height === "number" &&
    bounds.height > 0
  );
}
export function fitTicketBounds(
  bounds: TradingFloatingBounds,
  environment: Pick<TradingEnvironment, "width" | "height">,
): TradingFloatingBounds {
  const availableWidth = Math.max(environment.width - 16, 1),
    availableHeight = Math.max(environment.height - 16, 1);
  const width = Math.min(
    Math.max(bounds.width, Math.min(280, availableWidth)),
    availableWidth,
  );
  const height = Math.min(
    Math.max(bounds.height, Math.min(360, availableHeight)),
    availableHeight,
  );
  const maximumX = Math.max(environment.width - width - 8, 0),
    maximumY = Math.max(environment.height - height - 8, 0);
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, Math.min(8, maximumX)), maximumX),
    y: Math.min(Math.max(bounds.y, Math.min(8, maximumY)), maximumY),
  };
}
function centeredBounds(
  environment: TradingEnvironment,
): TradingFloatingBounds {
  const width = 416,
    height = Math.min(840, Math.max(environment.height - 40, 1));
  return fitTicketBounds(
    {
      width,
      height,
      x: (environment.width - width) / 2,
      y: (environment.height - height) / 2,
    },
    environment,
  );
}
function readPlacement(preferences: Preferences): DesiredPlacement {
  try {
    const raw = preferences.get(preferenceKey);
    if (!raw || raw.length > 1000) return { mode: "docked" };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { mode: "docked" };
    const saved = value as Record<string, unknown>;
    if (
      saved.version !== 1 ||
      (saved.mode !== "docked" && saved.mode !== "floating")
    )
      return { mode: "docked" };
    if (saved.bounds !== undefined && !validBounds(saved.bounds))
      return { mode: "docked" };
    if (saved.mode === "floating" && !validBounds(saved.bounds))
      return { mode: "docked" };
    return {
      mode: saved.mode,
      bounds: saved.bounds as TradingFloatingBounds | undefined,
    };
  } catch {
    return { mode: "docked" };
  }
}
/** Requested geometry and completed user choices persist; viewport clamps and drag previews do not. */
export function createTicketPlacement(
  presentation: Pick<
    TradingPresentationPort,
    "environment" | "setTicketPlacement"
  >,
  preferences: Preferences,
  report: (cause: unknown) => void,
) {
  const supported = typeof presentation.setTicketPlacement === "function";
  let desired: DesiredPlacement = { mode: "docked" },
    disposed = false,
    failing = false;
  const describe = (value: DesiredPlacement): TicketPlacementState => {
    const environment = presentation.environment.get();
    const canFloat = supported && environment.width >= 900;
    return {
      supported,
      canFloat,
      desiredFloating: value.mode === "floating",
      floating: canFloat && value.mode === "floating",
      bounds: fitTicketBounds(
        value.bounds ?? centeredBounds(environment),
        environment,
      ),
    };
  };
  const state = new ValueStore(describe(desired));
  function apply(value: DesiredPlacement): boolean {
    if (disposed || !supported) return false;
    const next: DesiredPlacement = Object.freeze({
      ...value,
      bounds: value.bounds ? Object.freeze({ ...value.bounds }) : undefined,
    });
    try {
      if (next.mode === "floating" && next.bounds)
        presentation.setTicketPlacement!({
          mode: "floating",
          bounds: next.bounds,
        });
      else presentation.setTicketPlacement!({ mode: "docked" });
    } catch (cause) {
      if (!failing) report(cause);
      failing = true;
      return false;
    }
    failing = false;
    desired = next;
    state.set(describe(desired));
    return true;
  }
  function previewPosition(x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const rendered = fitTicketBounds(
      { ...state.get().bounds, x, y },
      presentation.environment.get(),
    );
    const requested = desired.bounds ?? state.get().bounds;
    return apply({
      ...desired,
      bounds: { ...requested, x: rendered.x, y: rendered.y },
    });
  }
  function save(): void {
    if (disposed || !supported) return;
    try {
      preferences.set(
        preferenceKey,
        JSON.stringify({ version: 1, ...desired }),
      );
    } catch (cause) {
      report(cause);
    }
  }
  if (supported) apply(readPlacement(preferences));
  const release = presentation.environment.subscribe(() => {
    if (supported) apply(desired);
    else state.set(describe(desired));
  });
  return {
    state: valueReader(state),
    toggle(): boolean {
      if (disposed || !supported) return false;
      if (desired.mode === "docked" && !state.get().canFloat) return false;
      const mode = desired.mode === "floating" ? "docked" : "floating";
      const bounds =
        desired.bounds ?? centeredBounds(presentation.environment.get());
      if (!apply({ mode, bounds })) return false;
      save();
      return true;
    },
    previewPosition,
    captureBounds(): TradingFloatingBounds {
      return Object.freeze({ ...(desired.bounds ?? state.get().bounds) });
    },
    previewBounds(bounds: TradingFloatingBounds): boolean {
      if (!validBounds(bounds)) return false;
      return apply({
        ...desired,
        bounds: fitTicketBounds(bounds, presentation.environment.get()),
      });
    },
    restoreBounds(bounds: TradingFloatingBounds): boolean {
      if (!validBounds(bounds)) return false;
      return apply({ ...desired, bounds });
    },
    center(): void {
      if (disposed || !state.get().floating) return;
      const environment = presentation.environment.get(),
        bounds = state.get().bounds;
      if (
        previewPosition(
          (environment.width - bounds.width) / 2,
          (environment.height - bounds.height) / 2,
        )
      )
        save();
    },
    save,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      release();
      state.destroy();
    },
  };
}
export type TicketPlacement = ReturnType<typeof createTicketPlacement>;
