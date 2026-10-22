import { defineConfig } from "@playwright/test";

const baseArgs = [
  "--no-sandbox",
  "--mute-audio",
  "--disable-dev-shm-usage",
];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  outputDir: "./tests/e2e/output",
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  projects: [
    {
      // Playback intent: sound-permissive autoplay so play() resolves and
      // `paused === false` is observable. This proves the element was
      // *allowed* to play — it does NOT prove audible output, which no
      // headless run can verify (see docs/OBS_SETUP.md for the manual
      // audible check).
      name: "playback",
      testMatch: /(overlay|editor|saas)\.spec\.ts/,
      use: {
        browserName: "chromium",
        headless: true,
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [...baseArgs, "--autoplay-policy=no-user-gesture-required"],
        },
        screenshot: "only-on-failure",
        trace: "off",
      },
    },
    {
      // Default browser autoplay policy: media with sound must be refused
      // without a user gesture. The overlay has to degrade gracefully
      // (status message, timed cleanup, idle transparency) — never hang.
      name: "autoplay-default",
      testMatch: /policy\.spec\.ts/,
      use: {
        browserName: "chromium",
        headless: true,
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: baseArgs,
        },
        screenshot: "only-on-failure",
        trace: "off",
      },
    },
  ],
});
