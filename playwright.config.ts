import { defineConfig } from "@playwright/test";

// One timestamped report directory per run. Workers re-evaluate this file, so the
// stamp is pinned in the environment by the main process before workers start.
process.env.ETHER_E2E_STAMP ??= new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = `e2e-report/${process.env.ETHER_E2E_STAMP}`;
process.env.ETHER_E2E_REPORT_DIR = reportDir;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
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
