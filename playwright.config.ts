import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  outputDir: "./tests/e2e/output",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    launchOptions: {
      args: [
        "--no-sandbox",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
        "--disable-dev-shm-usage",
      ],
    },
    screenshot: "only-on-failure",
    trace: "off",
  },
});
