import { Link, Outlet, createFileRoute, redirect, useLocation, useRouteContext, useRouter } from "@tanstack/react-router";
import { Star as StarIcon } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { TabBar, useAction } from "../components/ui";
import { snappy } from "../lib/motion";
import { ApiError, api, del, put, repoApi, type Issue, type RepoInfo } from "../lib/api";

type Counts = { open: number; items: Issue[] };

export const Route = createFileRoute("/_authed/$owner/$repo")({
  beforeLoad: async ({ params, location }) => {
    const base = repoApi(params.owner, params.repo);
    const [info, issues, pulls] = await Promise.all([
      api<RepoInfo>(base),
      api<Counts>(`${base}/issues`),
      api<Counts>(`${base}/pulls`),
    ]).catch((e) => {
      // A visitor asking for something only accounts can see.
      if (e instanceof ApiError && e.status === 401) throw redirect({ to: "/login", search: { next: location.href } });
      throw e;
    });
    return { info, counts: { issues: issues.open, pulls: pulls.open }, latest: { issue: issues.items[0] ?? null, pull: pulls.items[0] ?? null } };
  },
  component: RepoLayout,
});

function RepoLayout() {
  const { info, counts } = Route.useRouteContext();
  const { owner, repo } = Route.useParams();
  const params = { owner, repo };
  const { pathname } = useLocation();
  return (
    <main className="page">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-2xl tracking-tight">
        <span className="badge">{info.repo.visibility === "public" ? "Public" : "Private"}</span>
        <span>
          <Link to="/$owner" params={{ owner: info.repo.owner }} className="font-semibold text-muted">
            {info.repo.owner}
          </Link>
          <span className="text-muted"> / </span>
          <Link to="/$owner/$repo" params={params} className="font-semibold">
            {info.repo.name}
          </Link>
        </span>
        <span className="flex-1" />
        <StarButton info={info} />
      </div>
      {info.repo.description && <p className="m-0 text-muted">{info.repo.description}</p>}
      <TabBar label="Repository">
        <Link to="/$owner/$repo" params={params} activeOptions={{ exact: true }}>
          Code
        </Link>
        <Link to="/$owner/$repo/issues" params={params}>
          Issues<span className="count">{counts.issues}</span>
        </Link>
        <Link to="/$owner/$repo/pulls" params={params}>
          Pull requests<span className="count">{counts.pulls}</span>
        </Link>
        <Link to="/$owner/$repo/wiki" params={params}>
          Wiki
        </Link>
        <Link to="/$owner/$repo/ci" params={params}>
          CI
        </Link>
        {info.role === "owner" && (
          <Link to="/$owner/$repo/settings" params={params}>
            Settings
          </Link>
        )}
      </TabBar>
      {/* Keyed by path so each tab's content eases in; the header above stays put. */}
      <div key={pathname} className="route-enter">
        <Outlet />
      </div>
    </main>
  );
}

function StarButton({ info }: { info: RepoInfo }) {
  const router = useRouter();
  const { me } = useRouteContext({ from: "/_authed" });
  const toggle = useAction(async () => {
    const url = `${repoApi(info.repo.owner, info.repo.name)}/star`;
    await (info.starred ? del(url) : put(url, {}));
    await router.invalidate();
    toast(info.starred ? `Unstarred ${info.repo.name}` : `Starred ${info.repo.name}`);
  });
  if (!me)
    return (
      <span className="pill" title="Stars">
        <StarIcon size={14} aria-hidden /> {info.stars}
      </span>
    );
  return (
    <button className="text-sm" onClick={() => toggle.run()} disabled={toggle.pending} aria-pressed={info.starred}>
      <motion.span key={String(info.starred)} className="inline-flex" initial={info.starred ? { scale: 0.3, rotate: -40 } : false} animate={{ scale: 1, rotate: 0 }} transition={snappy}>
        <StarIcon size={16} aria-hidden fill={info.starred ? "currentColor" : "none"} className={info.starred ? "text-star" : ""} />
      </motion.span>
      {info.starred ? "Unstar" : "Star"}
      <motion.span key={info.stars} className="count" initial={{ y: info.starred ? 6 : -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={snappy}>
        {info.stars}
      </motion.span>
    </button>
  );
}
