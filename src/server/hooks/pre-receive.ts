// Run by git receive-pack before it updates any ref; a non-zero exit refuses the whole push.
// Ether passes the repository's rules in ETHER_BRANCH_RULES, so this needs no database.
import { refusal, type BranchRule } from "../branch-rules";

const rules = JSON.parse(process.env.ETHER_BRANCH_RULES ?? "[]") as BranchRule[];
const input = await new Response(Bun.stdin.stream()).text();

// New objects are still in quarantine; git finds them through the environment receive-pack set.
const isAncestor = async (old: string, next: string) => (await Bun.spawn(["git", "merge-base", "--is-ancestor", old, next], { stdout: "ignore", stderr: "ignore" }).exited) === 0;

const problems: string[] = [];
for (const line of input.split("\n").filter(Boolean)) {
  const [old, next, ref] = line.split(" ");
  const why = await refusal(rules, { old, new: next, ref }, isAncestor);
  if (why) problems.push(why);
}
for (const p of problems) console.error(`ether: ${p}`);
process.exit(problems.length ? 1 : 0);
