import { defineConfig } from "@playwright/test";

/** Browser tests: a real Chromium clicking through the real screens against a throwaway database.
 *  Run them with scripts/e2e.ps1 from the project root, which prepares that database and both servers. */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "./e2e-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1366, height: 768 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
