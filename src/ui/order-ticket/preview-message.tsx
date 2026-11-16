import { For } from "solid-js";
import type { OrderPreviewMessage } from "../../contracts/broker.js";
export function PreviewMessage(props: { value: OrderPreviewMessage }) {
  const parts = () =>
    typeof props.value === "string" ? [props.value] : props.value;
  return (
    <For each={parts()}>
      {(part) => {
        if (typeof part === "string") return <span>{part}</span>;
        let safe = false;
        try {
          safe = ["https:", "http:"].includes(new URL(part.url).protocol);
        } catch {
          /* Invalid links remain escaped text. */
        }
        return safe ? (
          <a href={part.url} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          <span>{part.text}</span>
        );
      }}
    </For>
  );
}
