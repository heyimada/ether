import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Globe, Lock } from "lucide-react";
import { useState } from "react";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { api, post } from "../lib/api";

export const Route = createFileRoute("/_authed/new")({
  loader: () => api<{ orgs: { name: string; role: "owner" | "member" }[] }>("/api/me/orgs"),
  component: NewRepo,
});

function NewRepo() {
  const router = useRouter();
  const { me } = Route.useRouteContext();
  const owners = [me.username, ...Route.useLoaderData().orgs.filter((o) => o.role === "owner").map((o) => o.name)];
  const [owner, setOwner] = useState(me.username);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const create = useAction(async () => {
    const { repo } = await post<{ repo: { owner: string; name: string } }>("/api/repos", { name, description, owner, visibility });
    await router.navigate({ to: "/$owner/$repo", params: { owner: repo.owner, repo: repo.name } });
  });

  return (
    <main className="page stack" style={{ maxWidth: 680 }}>
      <h1>Create a new repository</h1>
      <form className="card body stack-md" onSubmit={onSubmit(create.run)}>
        <ErrorNote error={create.error} />
        <div className="owner-name">
          <Field id="owner" label="Owner">
            <select id="owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <span className="owner-slash" aria-hidden>
            /
          </span>
          <Field id="name" label="Repository name">
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
          </Field>
        </div>
        <Field id="description" label="Description" hint="Optional.">
          <input id="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <fieldset className="fieldset visibility">
          <legend>Visibility</legend>
          <label className="choice">
            <input type="radio" name="visibility" checked={visibility === "public"} onChange={() => setVisibility("public")} />
            <Globe size={20} aria-hidden />
            <span>
              <strong>Public</strong>
              <span className="muted">Everyone with an account on this server can see and clone it. Only people you add can push.</span>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} />
            <Lock size={20} aria-hidden />
            <span>
              <strong>Private</strong>
              <span className="muted">Only you{owner !== me.username ? `, ${owner}'s members` : ""} and the collaborators you add can see it.</span>
            </span>
          </label>
        </fieldset>
        <div>
          <button className="primary" disabled={create.pending}>
            Create repository
          </button>
        </div>
      </form>
    </main>
  );
}
