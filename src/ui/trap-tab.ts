/** Elements that can take Tab focus before disabled and hidden checks. */
export const TAB_CANDIDATES = 'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';
type Candidate = Pick<Element, "matches" | "closest">;
/**
 * Whether a candidate can actually receive focus. `:disabled` covers controls inside a disabled
 * `<fieldset>` (the ticket disables itself that way while busy); hidden and inert subtrees are skipped.
 */
export function isTabCandidate(element: Candidate): boolean {
  return !element.matches(":disabled") && !element.closest("[hidden], [inert]");
}
/** Keep Tab focus inside a compact full-screen panel. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = [...root.querySelectorAll<HTMLElement>(TAB_CANDIDATES)].filter(isTabCandidate);
  if (!focusable.length) return;
  const first = focusable[0],
    last = focusable[focusable.length - 1],
    active = root.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
