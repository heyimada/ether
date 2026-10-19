import * as Menu from "@radix-ui/react-dropdown-menu";
import { Link, Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Building2, ChevronDown, LogOut, Settings, Shield, User } from "lucide-react";
import { useEffect, useMemo } from "react";
import { JumpBox } from "../components/jump";
import { Avatar, PeopleContext, type Person } from "../components/ui";
import { applyAppearance, clearAppearance } from "../lib/accent";
import { ApiError, api, type Me } from "../lib/api";
import { authClient } from "../lib/auth-client";

export type Instance = { anonymousRead: boolean; sshBase: string | null };

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
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden />
          Ether
        </Link>
        <JumpBox />
        {me ? (
          <UserMenu me={me} displayName={directory.get(me.username)?.displayName ?? ""} />
        ) : (
          <Link to="/login" className="button primary small sign-in">
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
      <Menu.Trigger className="user-trigger" aria-label="Account menu">
        <Avatar name={me.username} size={28} />
        <ChevronDown size={14} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={8}>
          <Menu.Label className="menu-label">
            Signed in as <strong>{me.username}</strong>
            {displayName && <span className="muted"> ({displayName})</span>}
          </Menu.Label>
          <Menu.Separator className="menu-sep" />
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
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" onSelect={signOut}>
            <LogOut size={16} aria-hidden /> Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
