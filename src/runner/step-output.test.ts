import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutputFile } from "./step-output";

test("a host step's output file is read up to the limit, and only if it's a plain file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ether-output-test-"));
  try {
    const plain = join(dir, "plain");
    writeFileSync(plain, "a=1\n");
    expect(readOutputFile(plain, 1024)).toBe("a=1\n");
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(10_000));
    expect(readOutputFile(big, 1024)).toBe("x".repeat(1024));
    expect(readOutputFile(join(dir, "missing"), 1024)).toBe("");
    // A link isn't followed, whether to a file or to something endless.
    const link = join(dir, "link");
    symlinkSync(plain, link);
    expect(readOutputFile(link, 1024)).toBe("");
    // A FIFO nobody writes to doesn't hold up the read.
    const fifo = join(dir, "fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0) expect(readOutputFile(fifo, 1024)).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
