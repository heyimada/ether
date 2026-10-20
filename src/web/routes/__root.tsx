import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { RouteProgress } from "../components/ui";
import { PREPAINT } from "../lib/accent";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Ether" }],
    links: [{ rel: "stylesheet", href: appCss }],
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
      <p className="muted">That page doesn’t exist, or you don’t have access to it.</p>
    </main>
  ),
});

// Motion follows the OS reduced-motion setting everywhere; toasts take their colours from the theme tokens.
function Root() {
  return (
    <MotionConfig reducedMotion="user">
      <RouteProgress />
      <Outlet />
      <Toaster position="bottom-right" className="toaster" gap={8} />
    </MotionConfig>
  );
}
