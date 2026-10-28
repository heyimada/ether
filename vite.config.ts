import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.ETHER_PORT ?? 3000}`;

export default defineConfig({
  server: {
    port: 5173,
    // In development the Elysia server owns /api and git; Vite serves the app.
    proxy: { "/api": api, "^/[^/]+/[^/]+\.git/": api },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ srcDirectory: "src/web", spa: { enabled: true } }),
    viteReact(),
  ],
});
