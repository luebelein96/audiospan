import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Served by tests/browser/serve-docs.mjs (second webServer in playwright.config.ts).
const DOCS = "http://127.0.0.1:8792/audiospan/";
const built = existsSync(fileURLToPath(new URL("../../apps/docs/dist/index.html", import.meta.url)));

test.describe("documentation site (apps/docs, real-time AudioContext)", () => {
  test.skip(!built, "apps/docs/dist is not built; run `pnpm docs:build`");

  test("the landing page's live demo runs the reference plugin through @audiospan/react", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(DOCS);
    await expect(page).toHaveTitle(/Audiospan/);
    const status = page.locator(".as-demo__status");
    await expect(status).toContainText("Press Start");
    await page.getByRole("button", { name: "Start audio" }).click();
    await expect(status).toContainText("Gain (C++) 0.1.0", { timeout: 15_000 });
    // The knob is the React Knob component bound to the typed handle (role=slider, keyboard operable).
    const knob = page.getByRole("slider", { name: "Gain" });
    await expect(knob).toBeVisible();
    await knob.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".as-demo__knob .as-demo__value")).toHaveText("2.00");
    await page.getByRole("button", { name: "Half" }).click();
    await expect(page.locator(".as-demo__knob .as-demo__value")).toHaveText("0.50");
    // The test tone drives the plugin's level output, polled on the audio thread.
    await expect(page.locator(".as-demo__meter .as-demo__value")).not.toHaveText("0.00", { timeout: 10_000 });
    // Switching the source reconnects through useAudioSource (Chromium runs with a fake microphone).
    await page.getByLabel("Source").selectOption("microphone");
    await expect(status).toContainText("· microphone", { timeout: 10_000 });
    await expect(page.locator(".as-demo__error")).toHaveCount(0);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(status).toContainText("Press Start");
    expect(errors).toEqual([]);
  });

  test("pages link to each other under the site base", async ({ page }) => {
    await page.goto(`${DOCS}getting-started/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Getting started");
    await page.getByRole("main").getByRole("link", { name: "From your DSP to a web app" }).first().click();
    await expect(page).toHaveURL(/\/audiospan\/from-dsp-to-web\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("From your DSP to a web app");
  });
});
