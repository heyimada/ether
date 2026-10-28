import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorNote, Field, onSubmit, useAction } from "../components/ui";
import { post, repoApi } from "../lib/api";

export const Route = createFileRoute("/_authed/$owner/$repo/issues/new")({ component: NewIssue });

function NewIssue() {
  const router = useRouter();
  const { info } = Route.useRouteContext();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useAction(async () => {
    const { issue } = await post<{ issue: { number: number } }>(`${repoApi(info.repo.owner, info.repo.name)}/issues`, { title, body });
    await router.invalidate();
    await router.navigate({ to: "/$owner/$repo/issues/$number", params: { owner: info.repo.owner, repo: info.repo.name, number: String(issue.number) } });
  });
  return (
    <form className="card body max-w-[820px]" onSubmit={onSubmit(create.run)}>
      <ErrorNote error={create.error} />
      <Field id="title" label="Title">
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={256} autoFocus />
      </Field>
      <Field id="body" label="Body" hint="Markdown is supported.">
        <textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <button className="primary" disabled={create.pending}>
        Submit new issue
      </button>
    </form>
  );
}
