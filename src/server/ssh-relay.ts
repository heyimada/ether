import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

// Copies from git into an SSH channel (stdout or stderr), waiting for the client whenever it falls behind.
// Watching `destroyed` doesn't work: ssh2 closes a server channel by emitting "close" without setting it,
// and only once the channel's input has ended, which a paused channel may never reach. So the pump stops
// writing when the channel or the whole connection closes, and `onClose` runs once (to kill git).
// After that, output is read and dropped until git's pipe ends.
export function channelPump(closers: EventEmitter[], onClose: () => void) {
  let closed = false;
  const waiting = new Set<() => void>();
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
    for (const wake of waiting) wake();
  };
  for (const c of closers) c.once("close", close);
  const drained = (to: Writable) =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      const done = () => (to.off("drain", done), waiting.delete(done), resolve());
      to.on("drain", done);
      waiting.add(done);
    });
  return {
    pump: async (from: ReadableStream<Uint8Array>, to: Writable) => {
      for await (const chunk of from) if (!closed && !to.write(chunk)) await drained(to);
    },
    // Stops watching, so a long-lived connection doesn't collect a listener per command.
    release: () => {
      for (const c of closers) c.off("close", close);
    },
  };
}
