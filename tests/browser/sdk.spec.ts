import { expect, test, type Page } from "@playwright/test";

const PAGE = "tests/browser/pages/offline.html";

async function harness(page: Page): Promise<void> {
  await page.goto(PAGE);
  await page.waitForSelector('body[data-ready="true"]');
}

test.describe("Audiospan in a real AudioWorklet (Chromium, offline rendering)", () => {
  test("works without cross-origin isolation or SharedArrayBuffer", async ({ page }) => {
    await harness(page);
    const flags = await page.evaluate(() => ({ coi: window.audiospanHarness.crossOriginIsolated, sab: window.audiospanHarness.sharedArrayBuffer }));
    expect(flags.coi).toBe(false);
    expect(flags.sab).toBe(false);
  });

  test("works without a workletUrl (embedded worklet) through host.addPlugin", async ({ page }) => {
    await harness(page);
    const result = await page.evaluate(() => window.audiospanHarness.embedded(0.5));
    expect(result.chain).toHaveLength(1);
    expect(result.outputs).toEqual(["level"]);
    for (const channel of result.channels) expect(channel.mean).toBeCloseTo(0.25, 5);
  });

  test("loads the C++ gain plugin and scales a constant source by the parameter value", async ({ page }) => {
    await harness(page);
    const result = await page.evaluate(() => window.audiospanHarness.gain(0.5));
    expect(result.descriptor.id).toBe("dev.audiospan.gain-cpp");
    expect(result.descriptor.parameters).toEqual(["gain"]);
    expect(result.descriptor.presets.sort()).toEqual(["boost", "default", "half"]);
    expect(result.status).toBe("ready");
    for (const channel of result.channels) {
      expect(channel.min).toBeCloseTo(0.25, 5);
      expect(channel.max).toBeCloseTo(0.25, 5);
    }
    const doubled = await page.evaluate(() => window.audiospanHarness.gain(2));
    for (const channel of doubled.channels) expect(channel.mean).toBeCloseTo(1.0, 5);
  });

  test("bypass passes the input through untouched", async ({ page }) => {
    await harness(page);
    const channels = await page.evaluate(() => window.audiospanHarness.bypass());
    for (const channel of channels) expect(channel.mean).toBeCloseTo(0.5, 5);
  });

  test("chain order multiplies gains in sequence", async ({ page }) => {
    await harness(page);
    const result = await page.evaluate(() => window.audiospanHarness.chainOrder());
    expect(result.order).toEqual(["a", "b"]);
    for (const channel of result.channels) expect(channel.mean).toBeCloseTo(0.5 * 2 * 0.25, 5);
  });

  test("state saves, presets load, and invalid state is rejected", async ({ page }) => {
    await harness(page);
    const result = await page.evaluate(() => window.audiospanHarness.state());
    expect(result.saved.parameters.gain).toBe(1.5);
    expect(result.opaqueLength).toBeGreaterThan(0);
    expect(result.afterPreset).toBe(0.5);
    expect(result.restored).toBe(1.5);
    expect(result.rejected).toBe("INVALID_STATE");
  });

  test("errors surface as typed AudiospanError codes", async ({ page }) => {
    await harness(page);
    const codes = await page.evaluate(() => window.audiospanHarness.errors());
    expect(codes.missing).toBe("MANIFEST_FETCH_FAILED");
    expect(codes.notJson).toBe("MANIFEST_INVALID");
    expect(codes.remote).toBe("POLICY_VIOLATION");
    expect(codes.unknownPlugin).toBe("PLUGIN_NOT_FOUND");
    expect(codes.disposed).toBe("DISPOSED");
    const bad = await page.evaluate(() => window.audiospanHarness.badWorklet());
    expect(bad).toMatchObject({ code: "WORKLET_INIT_FAILED" });
  });

  test("disposal releases listeners, instances and the node", async ({ page }) => {
    await harness(page);
    const result = await page.evaluate(() => window.audiospanHarness.dispose());
    expect(result.events).toBe(1);
    expect(result.pluginStatus).toBe("disposed");
    expect(result.hostStatus).toBe("disposed");
    expect(result.nodeConnected).toBe(true);
  });
});

declare global {
  interface Window {
    audiospanHarness: {
      crossOriginIsolated: boolean;
      sharedArrayBuffer: boolean;
      embedded(value: number): Promise<{ chain: string[]; channels: { min: number; max: number; mean: number }[]; outputs: string[] }>;
      gain(value: number): Promise<{ descriptor: { id: string; parameters: string[]; presets: string[] }; channels: { min: number; max: number; mean: number }[]; status: string }>;
      bypass(): Promise<{ min: number; max: number; mean: number }[]>;
      chainOrder(): Promise<{ channels: { min: number; max: number; mean: number }[]; order: string[] }>;
      state(): Promise<{ saved: { parameters: Record<string, number>; opaqueState?: string }; afterPreset: number; restored: number; rejected: string | null; opaqueLength: number }>;
      errors(): Promise<Record<string, string>>;
      badWorklet(): Promise<{ code: string; message: string } | string>;
      dispose(): Promise<{ events: number; pluginStatus: string; hostStatus: string; nodeConnected: boolean }>;
    };
  }
}
