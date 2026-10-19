import { redirect } from "@tanstack/react-router";
import type { Me } from "./api";

// For pages that only make sense with an account: visitors browsing public repositories
// are sent to sign in, and the page itself can rely on `me`.
export function requireAccount(me: Me | null, href: string): { me: Me } {
  if (!me) throw redirect({ to: "/login", search: { next: href } });
  return { me };
}
