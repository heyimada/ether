// What follows from something a person did (notifications, the feed, code owner requests, CI) must never fail what
// they did. Runs `fn` synchronously up to its first await, and logs instead of throwing.
export async function sideEffect(what: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`${what} failed:`, e);
  }
}
