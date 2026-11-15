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

  // Masked text that is safe to show now. What's held back stays unmasked: masking it early could hide
  // the start of a longer secret (one that begins with a shorter one) and let the rest of it through.
  push(chunk: string): string {
    if (this.values.length === 0) return chunk;
    const text = this.pending + chunk;
    // Hold back enough to finish any secret that might be starting, and never cut through a whole one.
    let cut = Math.max(0, text.length - this.hold);
    for (let moved = true; moved; ) {
      moved = false;
      for (const v of this.values)
        for (let at = text.indexOf(v); at !== -1 && at < cut; at = text.indexOf(v, at + 1))
          if (at + v.length > cut) (cut = at), (moved = true);
    }
    this.pending = text.slice(cut);
    return this.mask(text.slice(0, cut));
  }

  // Whatever is still held back, once the stream has ended.
  flush(): string {
    const rest = this.mask(this.pending);
    this.pending = "";
    return rest;
  }
}
