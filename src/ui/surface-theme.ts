import type {
  ReadonlyValue,
  TradingEnvironment,
} from "../contracts/ports.js";

/** Native inputs follow the mounted chart theme rather than the operating system. */
export function bindSurfaceTheme(
  element: HTMLElement,
  environment: ReadonlyValue<TradingEnvironment>,
): () => void {
  const previous = element.style.colorScheme;
  const apply = (value: TradingEnvironment) => {
    element.style.colorScheme = value.theme;
  };
  apply(environment.get());
  const release = environment.subscribe(apply);
  return () => {
    release();
    element.style.colorScheme = previous;
  };
}
