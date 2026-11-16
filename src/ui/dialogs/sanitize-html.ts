const allowed = new Set([
  "P",
  "BR",
  "STRONG",
  "B",
  "EM",
  "I",
  "UL",
  "OL",
  "LI",
  "A",
]);
/** Only the explicitly documented HTML message path reaches this allowlist sanitizer. */
export function sanitizedMessage(
  document: Document,
  html: string,
): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const result = document.createDocumentFragment();
  let nodes = 0;
  function copy(source: Node, target: Node, depth: number): void {
    if (++nodes > 10000 || depth > 64) return;
    if (source.nodeType === 3) {
      target.appendChild(document.createTextNode(source.textContent ?? ""));
      return;
    }
    if (source.nodeType !== 1) return;
    const element = source as Element;
    if (
      ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH"].includes(
        element.tagName,
      )
    )
      return;
    let destination = target;
    if (allowed.has(element.tagName)) {
      const clean = document.createElement(element.tagName.toLowerCase());
      if (element.tagName === "A") {
        try {
          const url = new URL(
            element.getAttribute("href") ?? "",
            document.baseURI,
          );
          if (["http:", "https:"].includes(url.protocol)) {
            clean.setAttribute("href", url.href);
            clean.setAttribute("target", "_blank");
            clean.setAttribute("rel", "noopener noreferrer");
          }
        } catch {
          /* Invalid hrefs remain ordinary text. */
        }
      }
      target.appendChild(clean);
      destination = clean;
    }
    for (const child of Array.from(element.childNodes))
      copy(child, destination, depth + 1);
  }
  for (const child of Array.from(template.content.childNodes))
    copy(child, result, 0);
  return result;
}
