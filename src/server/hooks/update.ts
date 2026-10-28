// Run by git receive-pack once per ref, as `update <ref> <old> <new>`, before that ref moves; a
// non-zero exit refuses that ref alone. Ether passes the repository's rules in ETHER_BRANCH_RULES,
// so this needs no database.
import { refusal, type BranchRule } from "../branch-rules";

// Ether runs this once to prove the hook can actually be executed where it lives.
if (process.argv[2] === "--check") process.exit(0);

const [ref, old, next] = process.argv.slice(2);
const rules = JSON.parse(process.env.ETHER_BRANCH_RULES ?? "[]") as BranchRule[];

const git = async (args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return { ok: (await proc.exited) === 0, out };
};

const why = await refusal(rules, { ref, old, new: next }, {
  // New objects are still in quarantine; git finds them through the environment receive-pack set.
  isAncestor: async (a, b) => (await git(["merge-base", "--is-ancestor", a, b])).ok,
  branches: async () => (await git(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"])).out.split("\n").filter(Boolean),
  freshRepo: process.env.ETHER_FRESH_REPO === "1",
});
if (why) console.error(`ether: ${why}`);
process.exit(why ? 1 : 0);
