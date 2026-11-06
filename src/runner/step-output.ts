import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
// What a step writes to the file in $CI_OUTPUT: `name=value` lines, or for several lines `name<<DELIMITER`, the
// lines and then the delimiter on its own. As GitHub's $GITHUB_OUTPUT.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_OUTPUTS = 50;

export function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && Object.keys(out).length < MAX_OUTPUTS; i++) {
    const line = lines[i];
    const eq = line.indexOf("=");
    const heredoc = line.indexOf("<<");
    if (heredoc > 0 && (eq === -1 || heredoc < eq)) {
      const name = line.slice(0, heredoc);
      const end = lines.indexOf(line.slice(heredoc + 2), i + 1);
      if (!NAME_RE.test(name) || end === -1) continue;
      out[name] = lines.slice(i + 1, end).join("\n");
      i = end;
    } else if (eq > 0 && NAME_RE.test(line.slice(0, eq))) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// The first `max` bytes of a host step's output file, if it's a plain file. The step may have put
// anything there (a FIFO, a link to /dev/zero, gigabytes), and this runs on the event loop: for the built-in
// runner, Ether's own. So: never follow a link, never wait on a FIFO, never read more than `max`.
export function readOutputFile(file: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return "";
  }
  try {
    if (!fstatSync(fd).isFile()) return "";
    const buffer = Buffer.alloc(max);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return new TextDecoder().decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
