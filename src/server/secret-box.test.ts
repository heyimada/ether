import { expect, test } from "bun:test";
import { LogMasker } from "./log-mask";
import { deriveKey, open, seal } from "./secret-box";

const key = deriveKey("server secret", "ci secrets");

test("a sealed value opens with the same key and place, and only then", () => {
  const sealed = seal(key, "hunter2 ünïcode\nline two", "7\0DEPLOY_KEY");
  expect(sealed).not.toContain("hunter2");
  expect(open(key, sealed, "7\0DEPLOY_KEY")).toBe("hunter2 ünïcode\nline two");
  expect(() => open(key, sealed, "8\0DEPLOY_KEY")).toThrow();
  expect(() => open(key, sealed, "7\0OTHER")).toThrow();
  expect(() => open(deriveKey("rotated secret", "ci secrets"), sealed, "7\0DEPLOY_KEY")).toThrow();
  expect(() => open(deriveKey("server secret", "something else"), sealed, "7\0DEPLOY_KEY")).toThrow();
  const tampered = Buffer.from(sealed, "base64");
  tampered[tampered.length - 1] ^= 1;
  expect(() => open(key, tampered.toString("base64"), "7\0DEPLOY_KEY")).toThrow();
});

test("sealing the same value twice gives different ciphertexts", () => {
  expect(seal(key, "same", "a")).not.toBe(seal(key, "same", "a"));
});

const run = (m: LogMasker, chunks: string[]) => chunks.map((c) => m.push(c)).join("") + m.flush();

test("secrets are masked even when a chunk boundary splits them", () => {
  const text = "token=s3cr3t-value done\n";
  for (let i = 0; i <= text.length; i++) {
    expect(run(new LogMasker(["s3cr3t-value"]), [text.slice(0, i), text.slice(i)])).toBe("token=*** done\n");
  }
  expect(run(new LogMasker(["s3cr3t-value"]), [...text])).toBe("token=*** done\n");
});

test("multi-line secrets are masked whole and line by line; tiny values are left alone", () => {
  const pem = "-----BEGIN KEY-----\nAAAABBBBCCCC\n-----END KEY-----";
  expect(run(new LogMasker([pem]), [`key:\n${pem}\nonly a line: AAAABBBBCCCC\n`])).toBe("key:\n***\nonly a line: ***\n");
  expect(run(new LogMasker(["abc"]), ["abc abc"])).toBe("abc abc");
});

test("without secrets, output passes straight through", () => {
  const m = new LogMasker([]);
  expect(m.push("hello")).toBe("hello");
  expect(m.flush()).toBe("");
});
