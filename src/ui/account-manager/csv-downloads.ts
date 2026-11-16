import { TradingError } from "../../core/errors.js";
/** Owns temporary browser URLs; removing a table releases any outstanding download resources. */
export function createCsvDownloads() {
  const releases = new Set<() => void>();
  let disposed = false;
  return {
    download(owner: HTMLElement, csv: string, filename: string): void {
      if (disposed) throw TradingError.disposed("This table is closed.");
      const document = owner.ownerDocument,
        window = document.defaultView;
      if (!window?.URL.createObjectURL)
        throw new TradingError(
          "unsupported",
          "Downloads are unavailable in this browser.",
        );
      const url = window.URL.createObjectURL(
        new window.Blob([csv], { type: "text/csv;charset=utf-8" }),
      );
      let timer: number | undefined,
        active = true;
      const release = () => {
        if (!active) return;
        active = false;
        if (timer !== undefined) window.clearTimeout(timer);
        window.URL.revokeObjectURL(url);
        releases.delete(release);
      };
      releases.add(release);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      owner.appendChild(anchor);
      try {
        anchor.click();
        timer = window.setTimeout(release, 1000);
      } catch (cause) {
        release();
        throw cause;
      } finally {
        anchor.remove();
      }
    },
    destroy(): void {
      disposed = true;
      for (const release of [...releases]) release();
    },
  };
}
