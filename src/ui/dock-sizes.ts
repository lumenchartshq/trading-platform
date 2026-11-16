import { ValueStore } from "../core/value-store.js";

interface Preferences {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}
const defaults = { right: 320, accounts: 240 } as const;
export type DockKind = keyof typeof defaults;
const limits = { right: [280, 480], accounts: [160, 10000] } as const;

/** Only explicit completed resize gestures persist; temporary layout modes do not. */
export function createDockSizes(
  preferences: Preferences,
  report: (cause: unknown) => void,
) {
  function read(kind: DockKind): number {
    try {
      const saved = preferences.get(`dock.${kind}`);
      if (!saved || saved.length > 80) return defaults[kind];
      const value: unknown = JSON.parse(saved);
      if (
        value &&
        typeof value === "object" &&
        "version" in value &&
        value.version === 1 &&
        "pixels" in value &&
        typeof value.pixels === "number" &&
        Number.isFinite(value.pixels)
      ) {
        return clamp(kind, value.pixels);
      }
    } catch {
      /* Unavailable or invalid preferences use the default layout. */
    }
    return defaults[kind];
  }
  function clamp(kind: DockKind, pixels: number): number {
    return Math.round(
      Math.min(limits[kind][1], Math.max(limits[kind][0], pixels)),
    );
  }
  const right = new ValueStore(read("right"));
  const accounts = new ValueStore(read("accounts"));
  let disposed = false;
  return {
    right,
    accounts,
    resize(kind: DockKind, pixels: number): void {
      if (disposed || !Number.isFinite(pixels)) return;
      (kind === "right" ? right : accounts).set(clamp(kind, pixels));
    },
    save(kind: DockKind): void {
      if (disposed) return;
      try {
        preferences.set(
          `dock.${kind}`,
          JSON.stringify({
            version: 1,
            pixels: (kind === "right" ? right : accounts).get(),
          }),
        );
      } catch (cause) {
        report(cause);
      }
    },
    destroy(): void {
      disposed = true;
      right.destroy();
      accounts.destroy();
    },
  };
}
export type DockSizes = ReturnType<typeof createDockSizes>;
