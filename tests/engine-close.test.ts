/**
 * tests/engine-close.test.ts — verifies engine.close() preserves the user's headed Chrome.
 *
 * The bug we're guarding against: stopping the agent used to call browser.close() which
 * Puppeteer interprets as "kill the underlying Chrome process" — even when we attached via CDP
 * to a Chrome we didn't launch. That destroyed the user's logged-in session every restart.
 *
 * The fix tracks attachedToExisting and disconnects instead of closing on shutdown. We exercise
 * both paths here by rigging puppeteer.connect / puppeteer.launch to hand back a fake browser
 * with spy methods, then confirming engine.close() picks the right one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  closeSpy: vi.fn(async () => {}),
  disconnectSpy: vi.fn(async () => {}),
  connectSpy: vi.fn(async () => fakeBrowser()),
  launchSpy: vi.fn(async () => fakeBrowser()),
}));

function fakeBrowser() {
  return {
    on: vi.fn(),
    close: h.closeSpy,
    disconnect: h.disconnectSpy,
    connected: true,
  };
}

global.fetch = h.fetchMock as unknown as typeof fetch;

vi.mock("puppeteer-extra", () => ({
  default: {
    use: vi.fn(),
    connect: h.connectSpy,
    launch: h.launchSpy,
  },
}));

vi.mock("puppeteer-extra-plugin-stealth", () => ({ default: () => ({}) }));
vi.mock("puppeteer-extra-plugin-recaptcha", () => ({ default: () => ({}) }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, default: actual, existsSync: vi.fn(() => true) };
});

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  h.fetchMock.mockReset();
  h.closeSpy.mockClear();
  h.disconnectSpy.mockClear();
  h.connectSpy.mockClear();
  h.launchSpy.mockClear();
  // Make sure we get a fresh module (and fresh `browser` + `attachedToExisting` state)
  vi.resetModules();
});

describe("engine.close() — disconnect-vs-close behavior", () => {
  it("DISCONNECTS Chrome when we attached to a pre-existing instance", async () => {
    // CDP probe succeeds → engine treats Chrome as pre-existing
    h.fetchMock.mockResolvedValue({ ok: true } as unknown as Response);

    const engine = await import("../src/browser/engine");
    await engine.launch({ headless: false });
    await engine.close();

    expect(h.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(h.closeSpy).not.toHaveBeenCalled();
  });

  it("CLOSES Chrome when we launched it ourselves (no pre-existing CDP)", async () => {
    // First fetch (probe) fails, subsequent fetches (waiting for spawned Chrome) succeed
    h.fetchMock
      .mockRejectedValueOnce(new Error("not running"))
      .mockResolvedValue({ ok: true } as unknown as Response);

    // Mock spawn so we don't actually launch Chrome
    vi.doMock("child_process", () => ({
      execSync: vi.fn(),
      spawn: vi.fn(() => ({ unref: vi.fn() })),
    }));

    const engine = await import("../src/browser/engine");
    await engine.launch({ headless: false });
    await engine.close();

    expect(h.closeSpy).toHaveBeenCalledTimes(1);
    expect(h.disconnectSpy).not.toHaveBeenCalled();
  });

  it("close() is a no-op when no browser is connected", async () => {
    const engine = await import("../src/browser/engine");
    await engine.close();
    expect(h.closeSpy).not.toHaveBeenCalled();
    expect(h.disconnectSpy).not.toHaveBeenCalled();
  });

  it("clears the attached flag after disconnect so a subsequent launch starts clean", async () => {
    h.fetchMock.mockResolvedValue({ ok: true } as unknown as Response);
    const engine = await import("../src/browser/engine");
    await engine.launch({ headless: false });
    await engine.close();

    // Re-launch — this time with no pre-existing CDP. Should call close, not disconnect.
    h.fetchMock.mockReset();
    h.fetchMock
      .mockRejectedValueOnce(new Error("not running"))
      .mockResolvedValue({ ok: true } as unknown as Response);
    vi.doMock("child_process", () => ({
      execSync: vi.fn(),
      spawn: vi.fn(() => ({ unref: vi.fn() })),
    }));

    h.disconnectSpy.mockClear();
    h.closeSpy.mockClear();

    await engine.launch({ headless: false });
    await engine.close();
    expect(h.closeSpy).toHaveBeenCalledTimes(1);
    expect(h.disconnectSpy).not.toHaveBeenCalled();
  });
});
