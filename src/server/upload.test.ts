import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyIncomplete, BodyTooLarge, writeBody } from "./upload";

const dir = mkdtempSync(join(tmpdir(), "ether-upload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// What writeBody ended with for each path, including uploads whose client never sees the answer.
const outcomes = new Map<string, Promise<string>>();

// A server that saves each PUT's body right away, as the release asset route does once it has checked access.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    const length = req.headers.get("content-length");
    const result = writeBody(req.body, join(dir, name), 8192, length ? Number(length) : undefined).then(
      (size) => `saved ${size}`,
      (e) => (e instanceof BodyTooLarge ? "too large" : e instanceof BodyIncomplete ? "incomplete" : `error ${(e as Error).message}`),
    );
    outcomes.set(name, result);
    const outcome = await result;
    return Response.json({ outcome }, { status: outcome.startsWith("saved") ? 200 : 413 });
  },
});
afterAll(() => server.stop(true));

// Sends the headers, then the body a moment later, as browsers often do, and resolves with the
// status line, or with "hung" when no answer comes within two seconds. With `cutAt`, only that many
// bytes of the body are sent before the client hangs up.
function put(path: string, body: Buffer, delayMs: number, cutAt?: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(server.port!, "127.0.0.1", () => {
      socket.write(`PUT ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      setTimeout(() => (cutAt === undefined ? socket.write(body) : socket.end(body.subarray(0, cutAt))), delayMs);
    });
    let answer = "";
    socket.on("data", (d) => (answer += d));
    const timer = setTimeout(() => (socket.destroy(), resolve("hung")), 2000);
    socket.on("close", () => (clearTimeout(timer), resolve(answer.split("\r\n")[0])));
  });
}

test("a body that trails its headers is saved instead of hanging", async () => {
  const body = Buffer.alloc(4096, 7);
  expect(await put("/late", body, 50)).toBe("HTTP/1.1 200 OK");
  expect(readFileSync(join(dir, "late")).equals(body)).toBe(true);
});

test("saving replaces an existing file, so a shorter upload doesn't keep the old tail", async () => {
  writeFileSync(join(dir, "again"), Buffer.alloc(6000, 1));
  expect(await put("/again", Buffer.alloc(100, 2), 0)).toBe("HTTP/1.1 200 OK");
  expect(readFileSync(join(dir, "again")).equals(Buffer.alloc(100, 2))).toBe(true);
});

test("a body past the limit is refused and leaves the earlier file alone", async () => {
  writeFileSync(join(dir, "big"), "earlier");
  expect(await put("/big", Buffer.alloc(9000, 3), 0)).toBe("HTTP/1.1 413 Payload Too Large");
  expect(readFileSync(join(dir, "big"), "utf8")).toBe("earlier");
});

test("an upload cut off midway keeps the earlier file and leaves no partial one", async () => {
  writeFileSync(join(dir, "cut"), "earlier");
  await put("/cut", Buffer.alloc(4096, 5), 20, 1000);
  // Bun reports the hang-up as an error; a body that just ends early counts as incomplete. Either way nothing is saved.
  expect(await outcomes.get("cut")).not.toStartWith("saved");
  expect(readFileSync(join(dir, "cut"), "utf8")).toBe("earlier");
  // A first upload that is cut off leaves nothing at all.
  await put("/fresh", Buffer.alloc(4096, 6), 20, 1000);
  expect(await outcomes.get("fresh")).not.toStartWith("saved");
  expect(readdirSync(dir).filter((f) => f.startsWith("fresh") || f.includes(".part"))).toEqual([]);
});
