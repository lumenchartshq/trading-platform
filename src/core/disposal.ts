import type { Dispose } from '../contracts/ports.js';
/** Reverse acquisition order; a failing disposer never prevents the remaining cleanup. */
export class DisposalScope {
  private readonly disposers = new Set<Dispose>();
  private disposed = false;
  own(dispose: Dispose): Dispose {
    let active = true;
    const once = () => { if (active) { active = false; this.disposers.delete(once); dispose(); } };
    if (this.disposed) once();
    else this.disposers.add(once);
    return once;
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    let error: unknown;
    let failed = false;
    const disposers = [...this.disposers].reverse();
    this.disposers.clear();
    for (const dispose of disposers) {
      try { dispose(); } catch (cause) { if (!failed) error = cause; failed = true; }
    }
    if (failed) throw error;
  }
}
