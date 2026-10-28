import * as Menu from "@radix-ui/react-dropdown-menu";
import { Link, Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Building2, ChevronDown, LogOut, Settings, Shield, User } from "lucide-react";
import { useEffect, useMemo } from "react";
import { JumpBox } from "../components/jump";
import { Avatar, PeopleContext, type Person } from "../components/ui";
import { applyAppearance, clearAppearance } from "../lib/accent";
import { ApiError, api, type Me } from "../lib/api";
import { authClient } from "../lib/auth-client";

export type Instance = { anonymousRead: boolean; ciEnabled: boolean; ciIsolation: "container" | "host"; sshBase: string | null; sshHostKey: { fingerprint: string; publicKey: string } | null };

// Every signed-in page lives under this pathless layout. It runs only in the browser so the
// prerendered SPA shell never bakes in a signed-out session.
export const Route = createFileRoute("/_authed")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    try {
      const [{ user }, { users }, instance] = await Promise.all([api<{ user: Me }>("/api/me"), api<{ users: Person[] }>("/api/users"), api<Instance>("/api/instance")]);
      return { me: user as Me | null, people: users, instance };
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      // Signed out: browse public repositories as a visitor if the admin allows it.
      const instance = await api<Instance>("/api/instance");
      if (!instance.anonymousRead) throw redirect({ to: "/login", search: { next: location.href } });
      const { users } = await api<{ users: Person[] }>("/api/users");
      return { me: null as Me | null, people: users, instance };
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { me, people } = Route.useRouteContext();
  const directory = useMemo(() => new Map(people.map((p) => [p.username.toLowerCase(), p])), [people]);
  useEffect(() => {
    if (me) applyAppearance({ accent: me.accent, theme: me.theme });
  }, [me]);
  return (
    <PeopleContext.Provider value={directory}>
      <header className="sticky top-0 z-10 flex items-center gap-6 border-b border-border bg-surface-glass px-6 py-3 backdrop-blur-[14px] backdrop-saturate-[1.6] max-md:flex-wrap max-md:gap-3 max-md:px-4">
        <Link to="/" className="flex items-center gap-2 text-lg font-bold tracking-wide text-fg hover:no-underline">
          <span className="brand-mark" aria-hidden />
          Ether
        </Link>
        <JumpBox />
        {me ? (
          <UserMenu me={me} displayName={directory.get(me.username)?.displayName ?? ""} />
        ) : (
          <Link to="/login" className="button primary small">
            Sign in
          </Link>
        )}
      </header>
      <Outlet />
    </PeopleContext.Provider>
  );
}

function UserMenu({ me, displayName }: { me: Me; displayName: string }) {
  const router = useRouter();
  const signOut = async () => {
    await authClient.signOut();
    clearAppearance();
    await router.navigate({ to: "/login" });
  };
  return (
    <Menu.Root>
      <Menu.Trigger className="user-trigger group ml-auto min-h-0 gap-1 rounded-full border-0 bg-transparent p-0.5 text-muted shadow-none hover:bg-surface-3" aria-label="Account menu">
        <Avatar name={me.username} size={28} />
        <ChevronDown size={14} aria-hidden className="transition-transform duration-220 ease-out group-data-[state=open]:rotate-180" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={8}>
          <Menu.Label className="px-2.5 py-2 text-sm wrap-anywhere">
            Signed in as <strong>{me.username}</strong>
            {displayName && <span className="text-muted"> ({displayName})</span>}
          </Menu.Label>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item asChild className="menu-item">
            <Link to="/$owner" params={{ owner: me.username }}>
              <User size={16} aria-hidden /> Your profile
            </Link>
          </Menu.Item>
          <Menu.Item asChild className="menu-item">
            <Link to="/organizations/new">
              <Building2 size={16} aria-hidden /> New organization
            </Link>
          </Menu.Item>
          <Menu.Item asChild className="menu-item">
            <Link to="/settings">
              <Settings size={16} aria-hidden /> Settings
            </Link>
          </Menu.Item>
          {me.isAdmin && (
            <Menu.Item asChild className="menu-item">
              <Link to="/site-admin">
                <Shield size={16} aria-hidden /> Admin
              </Link>
            </Menu.Item>
          )}
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item className="menu-item" onSelect={signOut}>
            <LogOut size={16} aria-hidden /> Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
