import { DelegatedEvents, clearDelegatedEvents, delegateEvents } from "solid-js/web";

/** Solid keeps its delegated event names on the document under this key, shared by every Solid copy. */
const DELEGATED_EVENTS_KEY = "_$DX_DELEGATE";
const adopted = new WeakMap<Document, { count: number; ownsDelegation: boolean }>();

export interface AdoptedSurfaceDocument {
  /** Popups for this surface's subtree; set when the surface lives in another document. */
  readonly popupMount?: HTMLElement;
  release(): void;
}

/**
 * A host may place a surface in its own document, outside the chart frame (`trading_panels`). Solid listens for
 * delegated events on the document it runs in, so the surface's document needs the same listeners, and popups need
 * a layer there so they position against the surface rather than the chart frame. Delegation is reference-counted
 * per document and only removed when this module added it.
 */
export function adoptSurfaceDocument(element: HTMLElement, own: Document): AdoptedSurfaceDocument {
  const document = element.ownerDocument;
  if (document === own) return { release() {} };
  let entry = adopted.get(document);
  if (!entry) {
    entry = { count: 0, ownsDelegation: !(DELEGATED_EVENTS_KEY in document) };
    adopted.set(document, entry);
    delegateEvents([...DelegatedEvents], document);
  }
  entry.count++;
  const popupMount = document.createElement("div");
  popupMount.className = "lumen-trading";
  popupMount.dataset.ui = "trading-popups";
  document.body.appendChild(popupMount);
  let released = false;
  return {
    popupMount,
    release() {
      if (released) return;
      released = true;
      popupMount.remove();
      const current = adopted.get(document);
      if (!current || --current.count > 0) return;
      adopted.delete(document);
      if (current.ownsDelegation) clearDelegatedEvents(document);
    },
  };
}

/**
 * The focused element, followed into same-origin frames: when a control inside the chart frame opens a dialog in the
 * page, the page's own `activeElement` is only the frame.
 */
export function focusedElement(document: Document): HTMLElement | undefined {
  let active: Element | null = document.activeElement;
  for (let depth = 0; depth < 4 && active?.tagName === "IFRAME"; depth++) {
    let inner: Document | null = null;
    try {
      inner = (active as HTMLIFrameElement).contentDocument;
    } catch {
      inner = null;
    }
    if (!inner?.activeElement) break;
    active = inner.activeElement;
  }
  return active && "focus" in active ? (active as HTMLElement) : undefined;
}

/**
 * Modal isolation inside a host document: every other child of the page body is hidden from assistive technology and
 * made inert, never the layer that holds the dialog. Kobalte's own hide-outside walks the platform's global document,
 * which is the chart frame when the dialog lives in the page. The returned function restores what it changed.
 */
export function isolateLayer(layer: HTMLElement): () => void {
  const body = layer.ownerDocument.body;
  const changed: { element: Element; ariaHidden: string | null; inert: boolean }[] = [];
  for (const element of [...body.children]) {
    if (element === layer || element.contains(layer)) continue;
    changed.push({ element, ariaHidden: element.getAttribute("aria-hidden"), inert: element.hasAttribute("inert") });
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("inert", "");
  }
  return () => {
    for (const { element, ariaHidden, inert } of changed) {
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
      if (!inert) element.removeAttribute("inert");
    }
  };
}
