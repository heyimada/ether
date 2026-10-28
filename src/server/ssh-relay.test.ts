import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { Client, Server, utils, type Connection, type ServerChannel } from "ssh2";
import { channelPump, hangUps, type HangUp } from "./ssh-relay";

// A real ssh2 server streams endless output, like a big clone, to a client that hangs up partway.
// The pump has to finish anyway, or every aborted clone leaves a handler waiting forever.
// `hangUp` is how the client leaves: closing just the channel, or ending the whole connection.
async function abortedTransfer(hangUp: "channel" | "connection", setup: (stream: ServerChannel, conn: Connection) => HangUp[]) {
  let pumped: Promise<void> | null = null;
  let killed = false;
  // Writing to a closed channel is what used to hang: write() returns false and drain never comes.
  let writesAfterClose = 0;
  const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (conn) => {
    conn.on("authentication", (ctx) => ctx.accept());
    conn.on("ready", () =>
      conn.on("session", (accept) =>
        accept().on("exec", (ok) => {
          const stream = ok();
          const signals = setup(stream, conn);
          let closed = false;
          for (const [emitter, event] of signals) emitter.once(event, () => (closed = true));
          const write = stream.write.bind(stream);
          stream.write = ((chunk: Uint8Array) => (closed && writesAfterClose++, write(chunk))) as typeof stream.write;
          const relay = channelPump(signals, () => (killed = true));
          // Stands in for git's stdout: once the process is killed, what's left in the pipe still comes out, then it ends.
          let leftInPipe = 4;
          const output = new ReadableStream<Uint8Array>({ pull: (c) => (killed && leftInPipe-- === 0 ? c.close() : c.enqueue(randomBytes(64 * 1024))) });
          pumped = relay.pump(output, stream);
        }),
      ),
    );
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.on("ready", () =>
      client.exec("git-upload-pack 'o/r.git'", (err, channel) => {
        if (err) return reject(err);
        let received = 0;
        channel.on("data", (chunk: Buffer) => {
          received += chunk.length;
          // Hang up after a few windows' worth, while the server is still writing.
          if (received > 4 * 1024 * 1024 && received - chunk.length <= 4 * 1024 * 1024) {
            if (hangUp === "channel") channel.close();
            else client.end();
            resolve();
          }
        });
      }),
    );
    client.on("error", reject);
    client.connect({ host: "127.0.0.1", port, username: "git" });
  });

  const finished = await Promise.race([pumped!.then(() => true), Bun.sleep(3000).then(() => false)]);
  client.end();
  server.close();
  return { finished, killed, writesAfterClose };
}

test("the pump finishes when the client closes the channel mid-transfer", async () => {
  // The channel's input flows, as with the stdin feed in ssh.ts, so ssh2 emits the channel's close.
  const r = await abortedTransfer("channel", (stream) => (stream.on("data", () => {}), [[stream, "close"]]));
  expect(r).toEqual({ finished: true, killed: true, writesAfterClose: 0 });
});

test("the pump finishes when the client hangs up while the channel's input is paused", async () => {
  // A paused channel never ends its input, so ssh2 never closes it; the connection ending still counts,
  // even while its close waits behind buffered output.
  const r = await abortedTransfer("connection", (stream, conn) => (stream.pause(), hangUps(stream, conn)));
  expect(r).toEqual({ finished: true, killed: true, writesAfterClose: 0 });
});
