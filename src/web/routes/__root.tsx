import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { RouteProgress } from "../components/ui";
import { PREPAINT } from "../lib/accent";
import appCss from "../styles.css?url";

// The browser tab's icon: Ether's mark (BrandMark in ui.tsx) in the default accent, lighter on a dark tab bar.
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>*{color:#0b7285}@media (prefers-color-scheme:dark){*{color:#4fc3d9}}</style><g fill="currentColor"><circle cx="32" cy="32" r="6.5"/><circle cx="46.85" cy="17.15" r="6.5"/></g><path d="M52.74 28.71A21 21 0 1 1 35.29 11.26" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>',
)}`;

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Ether" }],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: FAVICON },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
  component: Root,
  errorComponent: ({ error }) => (
    <main className="page">
      <div className="error">{error instanceof Error ? error.message : String(error)}</div>
    </main>
  ),
  notFoundComponent: () => (
    <main className="page">
      <h1>Not found</h1>
      <p className="text-muted">That page doesn’t exist, or you don’t have access to it.</p>
    </main>
  ),
});

// Motion follows the OS reduced-motion setting everywhere; toasts take their colours from the theme tokens.
function Root() {
  return (
    <MotionConfig reducedMotion="user">
      <RouteProgress />
      <Outlet />
      <Toaster position="bottom-right" gap={8} />
    </MotionConfig>
  );
}
