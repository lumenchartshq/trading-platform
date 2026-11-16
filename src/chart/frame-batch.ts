/** Runs a callback on the next presentation frame; returns a cancel function. */
export type FrameScheduler = (callback: () => void) => () => void;

/** Runs work at once: the default for headless consumers and deterministic tests. */
export const immediateFrames: FrameScheduler = (callback) => {
  callback();
  return () => {};
};

/** Browser animation frames when available; otherwise immediate. */
export function animationFrames(): FrameScheduler {
  if (typeof requestAnimationFrame !== "function") return immediateFrames;
  return (callback) => {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  };
}

/**
 * Collapses bursts of keyed work into one flush per frame. A key queued several times in one frame flushes once;
 * `take` lets a synchronous owner do the work now and drop the queued copy.
 */
export function createFrameBatch<V>(schedule: FrameScheduler, flush: (values: readonly V[]) => void) {
  const pending = new Map<string, V>();
  let cancel: (() => void) | undefined;
  let scheduled = false;
  let disposed = false;
  return {
    queue(key: string, value: V): void {
      if (disposed) return;
      pending.set(key, value);
      if (scheduled) return;
      scheduled = true;
      const cancelFrame = schedule(() => {
        scheduled = false;
        cancel = undefined;
        if (disposed) return;
        const values = [...pending.values()];
        pending.clear();
        flush(values);
      });
      if (scheduled) cancel = cancelFrame;
    },
    take(key: string): void {
      pending.delete(key);
    },
    destroy(): void {
      disposed = true;
      cancel?.();
      cancel = undefined;
      pending.clear();
    },
  };
}
