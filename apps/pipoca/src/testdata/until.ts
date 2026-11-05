export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(`not done after ${String(timeoutMs)} ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
