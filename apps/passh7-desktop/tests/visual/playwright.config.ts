import {defineConfig} from "@playwright/test";
import chromiumBinary from "@sparticuz/chromium";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  reporter: [["list"]],
  retries: 0,
  workers: 1,
  timeout: 30000,
  expect: {timeout: 10000},
  use: {
    baseURL: "http://127.0.0.1:4187",
    headless: true,
    browserName: "chromium",
    colorScheme: "dark",
    reducedMotion: "reduce",
    launchOptions: {
      executablePath: await chromiumBinary.executablePath(),
      args: chromiumBinary.args
    },
    screenshot: "off"
  },
  outputDir: "./test-results"
});
