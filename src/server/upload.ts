// Request bodies saved to disk as they arrive.
import { rmSync } from "node:fs";

export class BodyTooLarge extends Error {}

// Streams a request body into `file` (replacing it), at most `max` bytes, and returns the size written.
// Not `Bun.write(file, new Response(body))`: that hangs for good when the body is still arriving as it
// starts, which is how a small upload got stuck whenever its body trailed its headers by a moment.
// Throws BodyTooLarge as soon as the body passes `max`, leaving a partial file for the caller to remove.
export async function writeBody(body: ReadableStream<Uint8Array> | null, file: string, max: number): Promise<number> {
  // A file sink writes over an existing file without shortening it, so start from none.
  rmSync(file, { force: true });
  const sink = Bun.file(file).writer();
  let size = 0;
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
  return size;
}
