export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // The public promise remains rejectable even before a consumer attaches to it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
