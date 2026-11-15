import * as Menu from "@radix-ui/react-dropdown-menu";
import { Link, Outlet, createFileRoute, redirect, useRouter, useRouterState } from "@tanstack/react-router";
import { Bell, Building2, ChevronDown, LogOut, Settings, Shield, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { JumpBox } from "../components/jump";
import { Avatar, BrandMark, MENU_LABEL, MENU_SEP, PeopleContext, type Person } from "../components/ui";
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
          <BrandMark />
          Ether
        </Link>
        <JumpBox />
        {me ? (
          <>
            <NotificationBell />
            <UserMenu me={me} displayName={directory.get(me.username)?.displayName ?? ""} />
          </>
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

// The inbox link with its unread count, refreshed on every navigation and once a minute.
function NotificationBell() {
  // The location once its loaders are done: opening an issue reads its notifications there, so counting before
  // that would still include them.
  const location = useRouterState({ select: (s) => s.resolvedLocation?.href ?? s.location.href });
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ unread: number }>("/api/me/notifications/count")
        .then((r) => live && setUnread(r.unread))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    // The inbox page says when it marked something read or unread.
    window.addEventListener("notifications-changed", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("notifications-changed", load);
    };
  }, [location]);
  return (
    <Link
      to="/notifications"
      className="relative ml-auto inline-grid size-8 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg hover:no-underline"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <Bell size={18} aria-hidden />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-2xs leading-4 font-semibold text-on-state tabular-nums" aria-hidden>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
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
      <Menu.Trigger className="user-trigger group min-h-0 gap-1 rounded-full border-0 bg-transparent p-0.5 text-muted shadow-none hover:bg-surface-3" aria-label="Account menu">
        <Avatar name={me.username} size={28} />
        <ChevronDown size={14} aria-hidden className="transition-transform duration-220 ease-out group-data-[state=open]:rotate-180" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={8}>
          <Menu.Label className={MENU_LABEL}>
            Signed in as <strong>{me.username}</strong>
            {displayName && <span className="text-muted"> ({displayName})</span>}
          </Menu.Label>
          <Menu.Separator className={MENU_SEP} />
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
          <Menu.Separator className={MENU_SEP} />
          <Menu.Item className="menu-item" onSelect={signOut}>
            <LogOut size={16} aria-hidden /> Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
