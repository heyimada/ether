// Request bodies saved to disk as they arrive.
import { randomBytes } from "node:crypto";
import { renameSync, rmSync } from "node:fs";

export class BodyTooLarge extends Error {}
export class BodyIncomplete extends Error {}

// Streams a request body into `file`, at most `max` bytes, and returns the size written. The body goes to
// a temporary file next to it, which replaces `file` only once it is complete: an upload that is cut off
// (the client disconnects, the disk fills up) leaves the previous file, or none, never a truncated one.
// With `expected` (the Content-Length), a body that ends early counts as cut off too.
// Not `Bun.write(file, new Response(body))`: that hangs for good when the body is still arriving as it
// starts, which is how a small upload got stuck whenever its body trailed its headers by a moment.
// Throws BodyTooLarge as soon as the body passes `max`, and BodyIncomplete when it ends short.
export async function writeBody(body: ReadableStream<Uint8Array> | null, file: string, max: number, expected?: number): Promise<number> {
  const part = `${file}.${randomBytes(6).toString("hex")}.part`;
  const sink = Bun.file(part).writer();
  let size = 0;
  let done = false;
  try {
    try {
      if (body)
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > max) throw new BodyTooLarge();
          sink.write(chunk);
          // Waits for the disk, so a fast upload can't pile up in memory.
          await sink.flush();
        }
    } finally {
      await sink.end();
    }
    if (expected !== undefined && size !== expected) throw new BodyIncomplete(`received ${size} of ${expected} bytes`);
    renameSync(part, file);
    done = true;
    return size;
  } finally {
    if (!done) rmSync(part, { force: true });
  }
}
