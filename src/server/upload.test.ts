import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyTooLarge, writeBody } from "./upload";

const dir = mkdtempSync(join(tmpdir(), "ether-upload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A server that saves each PUT's body right away, as the release asset route does once it has checked access.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const file = join(dir, new URL(req.url).pathname.slice(1));
    try {
      return Response.json({ size: await writeBody(req.body, file, 8192) });
    } catch (e) {
      return Response.json({ tooLarge: e instanceof BodyTooLarge }, { status: 413 });
    }
  },
});
afterAll(() => server.stop(true));

// Sends the headers, then the body a moment later, as browsers often do, and resolves with the
// status line, or with "hung" when no answer comes within two seconds.
function put(path: string, body: Buffer, delayMs: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(server.port!, "127.0.0.1", () => {
      socket.write(`PUT ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      setTimeout(() => socket.write(body), delayMs);
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

test("a body past the limit is refused", async () => {
  expect(await put("/big", Buffer.alloc(9000, 3), 0)).toBe("HTTP/1.1 413 Payload Too Large");
});
