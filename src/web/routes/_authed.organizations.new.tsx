import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { post } from "../lib/api";
import { requireAccount } from "../lib/require-account";

export const Route = createFileRoute("/_authed/organizations/new")({
  beforeLoad: ({ context, location }) => requireAccount(context.me, location.href),
  component: NewOrg,
});

function NewOrg() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const create = useAction(async () => {
    const { org } = await post<{ org: { name: string } }>("/api/orgs", { name, displayName });
    await router.invalidate();
    await router.navigate({ to: "/$owner", params: { owner: org.name } });
  });
  return (
    <main className="page stack" style={{ maxWidth: 640 }}>
      <div className="stack-sm">
        <h1 style={{ margin: 0 }}>Create an organization</h1>
        <p className="muted" style={{ margin: 0 }}>
          Organizations own repositories together. Members get a base permission on every repository; owners manage members and settings.
        </p>
      </div>
      <form className="card body stack-md" onSubmit={onSubmit(create.run)}>
        <ErrorNote error={create.error} />
        <Field id="org-name" label="Organization name" hint={`Your organization's URL will be /${name || "name"}. Letters, digits and dashes.`}>
          <input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={39} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,38}" autoFocus />
        </Field>
        <Field id="org-display" label="Display name" hint="Optional, for example the full company name.">
          <input id="org-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
        </Field>
        <div>
          <button className="primary" disabled={create.pending}>
            Create organization
          </button>
        </div>
      </form>
    </main>
  );
}
