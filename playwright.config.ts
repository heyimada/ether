import { defineConfig } from "@playwright/test";

// One timestamped report directory per run. Workers re-evaluate this file, so the
// stamp is pinned in the environment by the main process before workers start.
process.env.ETHER_E2E_STAMP ??= new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = `e2e-report/${process.env.ETHER_E2E_STAMP}`;
process.env.ETHER_E2E_REPORT_DIR = reportDir;

// Specs that change site-wide settings (CI on/off and its runner, anonymous access). They run one at a time after the
// rest, because the other specs assume those settings are at their defaults.
const SITE_SETTINGS = ["ci.spec.ts", "ci-isolation.spec.ts", "workflows.spec.ts", "job-graph.spec.ts", "anonymous.spec.ts"];

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Spec files run side by side against the one server; they use unique names, so they don't collide. Tests inside a
  // file still run in order.
  workers: 4,
  fullyParallel: false,
  projects: [
    { name: "parallel", testIgnore: SITE_SETTINGS },
    // A failure in "parallel" skips these, like any project dependency; CI is red either way.
    { name: "site-settings", testMatch: SITE_SETTINGS, workers: 1, dependencies: ["parallel"] },
  ],
  timeout: 120_000,
  outputDir: `${reportDir}/artifacts`,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${reportDir}/html`, open: "never" }],
    ["json", { outputFile: `${reportDir}/results.json` }],
  ],
  use: {
    screenshot: "on",
    trace: "retain-on-failure",
  },
});
