// Replaces secret values in streamed log output with ***. Output arrives in chunks, so a value split
// across two chunks would slip through a per-chunk replace: the masker holds back the last few
// characters until the next chunk (or the end) shows whether they start a secret.
//
// This only stops secrets from showing up by accident. A job that can read a secret can always
// print it transformed (reversed, base64), so secrets are as private as write access to the repository.

const MIN = 4;

export class LogMasker {
  private readonly values: string[];
  private readonly hold: number;
  private pending = "";

  constructor(secrets: string[]) {
    // Multi-line values (keys, certificates) are also masked line by line, as tools often print them that way.
    const all = new Set<string>();
    for (const s of secrets) {
      all.add(s);
      for (const line of s.split(/\r?\n/)) all.add(line.trim());
    }
    // Longest first, so a whole value is replaced before any of its lines.
    this.values = [...all].filter((v) => v.length >= MIN).sort((a, b) => b.length - a.length);
    this.hold = Math.max(0, ...this.values.map((v) => v.length - 1));
  }

  private mask(text: string) {
    for (const v of this.values) text = text.replaceAll(v, "***");
    return text;
  }

  // Masked text that is safe to show now.
  push(chunk: string): string {
    if (this.values.length === 0) return chunk;
    const masked = this.mask(this.pending + chunk);
    const cut = Math.max(0, masked.length - this.hold);
    this.pending = masked.slice(cut);
    return masked.slice(0, cut);
  }

  // Whatever is still held back, once the stream has ended.
  flush(): string {
    const rest = this.mask(this.pending);
    this.pending = "";
    return rest;
  }
}
