import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

// An event that means the client is gone, e.g. [channel, "close"].
export type HangUp = [EventEmitter, string];

// The events that end a command's channel: the channel's close, and the connection's end or close.
// Watching `destroyed` doesn't work: ssh2 closes a server channel by emitting "close" without setting it,
// and only once the channel's input has ended, which a paused channel may never reach. The connection's
// "close" can lag well behind its "end" while output is still buffered, and after "end" the client sends
// nothing more. (A channel's own "end" only means the client finished its input, as every push does.)
export const hangUps = (channel: EventEmitter, connection: EventEmitter): HangUp[] => [
  [channel, "close"],
  [connection, "end"],
  [connection, "close"],
];

// Copies from git into an SSH channel (stdout or stderr), waiting for the client whenever it falls behind.
// It stops writing on the first hang-up, and `onClose` runs once (to kill git). After that, output is
// read and dropped until git's pipe ends.
export function channelPump(signals: HangUp[], onClose: () => void) {
  let closed = false;
  const waiting = new Set<() => void>();
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
    for (const wake of waiting) wake();
  };
  for (const [emitter, event] of signals) emitter.once(event, close);
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
      for (const [emitter, event] of signals) emitter.off(event, close);
    },
  };
}
