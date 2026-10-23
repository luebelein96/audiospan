import { defineConfig, devices } from "@playwright/test";

const PORT = 8791;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never", outputFolder: "../../playwright-report" }]] : "list",
  outputDir: "../../test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node packages/cli/dist/index.js dev --root . --port ${PORT} --host 127.0.0.1`,
    cwd: "../..",
    url: `http://127.0.0.1:${PORT}/__audiospan/worklet.js`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
  ],
});
