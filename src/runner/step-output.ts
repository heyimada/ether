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
