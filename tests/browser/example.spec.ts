import { expect, test } from "@playwright/test";

test.describe("vanilla example (real-time AudioContext)", () => {
  test("starts from a click, renders controls, reacts to parameter changes, and stops", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("examples/vanilla-web/index.html");
    await expect(page.locator("#status")).toHaveText("Idle.");
    await page.click("#start");
    await expect(page.locator("#status")).toContainText("Running Gain (C++)", { timeout: 15_000 });
    await expect(page.locator(".as-panel__title")).toHaveText("Gain (C++)");
    const slider = page.locator('[data-parameter="gain"] input[type="range"]');
    await expect(slider).toBeVisible();
    await slider.fill("0.5");
    await expect(page.locator('[data-parameter="gain"] .as-control__value')).toHaveText("0.50");
    await expect(page.locator("#log")).toContainText("gain = 0.5");
    // The plugin's "level" output is polled on the audio thread and rendered as a meter; with a source playing it must move off zero.
    const meter = page.locator('[data-output="level"] meter');
    await expect(meter).toBeVisible();
    await expect(page.locator('[data-output="level"] .as-output__value')).not.toHaveText("0.00", { timeout: 10_000 });
    await page.click(".as-panel__bypass");
    await expect(page.locator(".as-panel__status")).toHaveText("Bypassed");
    await page.click("#save");
    await expect(page.locator("#log")).toContainText('saved {"gain":0.5}');
    await page.click("#stop");
    await expect(page.locator("#status")).toHaveText("Stopped.");
    expect(errors).toEqual([]);
  });

  test("the sandbox served by `audiospan dev` loads the reference plugin", async ({ page }) => {
    await page.goto("__audiospan/demo/?plugin=/plugins/gain-cpp/dist/plugin.json");
    await page.click("#start");
    await expect(page.locator("#status")).toContainText("Running Gain (C++)", { timeout: 15_000 });
    await expect(page.locator("#log")).toContainText("loaded dev.audiospan.gain-cpp@0.1.0");
    await page.click("#stop");
    await expect(page.locator("#status")).toHaveText("Stopped.");
  });
});

test.describe("react example (@audiospan/react hooks, real-time AudioContext)", () => {
  test("starts through useAudiospanHost, loads through usePlugin, and renders PluginPanel with a live meter", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("examples/react/index.html");
    const status = page.locator("main > [role=status]"); // the app's own line; the panel renders another role=status
    await expect(status).toHaveText("Idle.");
    await page.getByRole("button", { name: "Start audio" }).click();
    await expect(status).toContainText("Running Gain (C++)", { timeout: 15_000 });
    // React controls bound to the typed handle; the oscillator comes through useAudioSource.
    const slider = page.locator('[data-parameter="gain"] input[type="range"]');
    await expect(slider).toBeVisible();
    await slider.fill("0.5");
    await expect(page.locator('[data-parameter="gain"] .as-control__value')).toHaveText("0.50");
    await expect(page.locator('[data-output="level"] .as-output__value')).not.toHaveText("0.00", { timeout: 10_000 });
    await page.selectOption(".as-panel__presets", "boost");
    await expect(page.locator('[data-parameter="gain"] .as-control__value')).toHaveText("2.00");
    await page.getByRole("button", { name: "Bypass" }).click();
    await expect(page.getByRole("button", { name: "Bypassed" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(status).toHaveText("Idle.");
    expect(errors).toEqual([]);
  });
});
