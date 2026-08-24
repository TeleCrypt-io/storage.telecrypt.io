/** Run an account-scoped task only while that account remains active. */
export function withAccountSignal<T>(
  signal: AbortSignal | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(new DOMException("Account is no longer active", "AbortError"));

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Account is no longer active", "AbortError"));
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      cleanup();
      abort();
      return;
    }
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
