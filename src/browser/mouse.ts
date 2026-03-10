/**
 * src/browser/mouse.ts — Human-like mouse movement for Cloudflare bypass
 * Uses OS-level native mouse input (Windows SendInput) to bypass Cloudflare's
 * detection of synthetic browser events. Falls back to Puppeteer mouse on non-Windows.
 */
import type { Page } from "puppeteer";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import logger from "../config/logger";

const IS_WINDOWS = process.platform === "win32";

interface Point { x: number; y: number; }

/** Generate a random number between min and max */
function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Cubic bezier interpolation */
function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Generate points along a bezier curve from start to end with random control points */
function bezierPath(start: Point, end: Point, steps: number): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  const cp1: Point = {
    x: start.x + dx * rand(0.2, 0.4) + rand(-50, 50),
    y: start.y + dy * rand(0.2, 0.4) + rand(-50, 50),
  };
  const cp2: Point = {
    x: start.x + dx * rand(0.6, 0.8) + rand(-50, 50),
    y: start.y + dy * rand(0.6, 0.8) + rand(-50, 50),
  };

  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    points.push({
      x: bezier(eased, start.x, cp1.x, cp2.x, end.x) + rand(-1, 1),
      y: bezier(eased, start.y, cp1.y, cp2.y, end.y) + rand(-1, 1),
    });
  }
  return points;
}

/**
 * Move the OS-level cursor to absolute screen coordinates using PowerShell.
 */
function nativeMoveTo(screenX: number, screenY: number): void {
  if (!IS_WINDOWS) return;
  try {
    execSync(
      `powershell -NoProfile -Command "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(screenX)},${Math.round(screenY)})"`,
      { stdio: "ignore", timeout: 2000 }
    );
  } catch { /* ignore */ }
}

/**
 * Perform a native OS-level mouse click using a temp PowerShell script.
 * Writes a .ps1 file to avoid quote-escaping issues with inline commands.
 */
export function nativeClickExported(screenX: number, screenY: number): void {
  return nativeClick(screenX, screenY);
}

function nativeClick(screenX: number, screenY: number): void {
  if (!IS_WINDOWS) return;
  const tmpDir = process.env.TEMP || "C:\\Windows\\Temp";
  const scriptPath = path.join(tmpDir, "outreach-mouse-click.ps1");
  const holdMs = Math.round(rand(40, 120));

  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NativeMouse {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public static void Click(int x, int y, int holdMs) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0002, 0, 0, 0, 0);
        System.Threading.Thread.Sleep(holdMs);
        mouse_event(0x0004, 0, 0, 0, 0);
    }
}
'@
[NativeMouse]::Click(${Math.round(screenX)}, ${Math.round(screenY)}, ${holdMs})
`;

  try {
    fs.writeFileSync(scriptPath, script, "utf-8");
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      stdio: "ignore",
      timeout: 8000,
    });
  } catch (e) {
    logger.warn(`[Mouse] Native click failed: ${(e as Error).message}`);
  }
}

/**
 * Get the Chrome window position to convert page coords to screen coords.
 * Uses CDP to get window bounds + measures the Chrome UI offset precisely.
 */
export async function getWindowBounds(page: Page): Promise<{ x: number; y: number; chromeOffsetY: number }> {
  try {
    const cdp = await page.createCDPSession();
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });

    // Measure the actual Chrome UI height by comparing window outer vs inner
    const chromeUIHeight = await page.evaluate(() => {
      return window.outerHeight - window.innerHeight;
    }).catch(() => 85);

    await cdp.detach();

    const result = {
      x: bounds.left || 0,
      y: (bounds.top || 0) + chromeUIHeight,
      chromeOffsetY: chromeUIHeight,
    };
    logger.info(`[Mouse] Window bounds: left=${bounds.left}, top=${bounds.top}, chromeUI=${chromeUIHeight}px → offset=(${result.x}, ${result.y})`);
    return result;
  } catch (e) {
    logger.warn(`[Mouse] getWindowBounds failed: ${(e as Error).message}`);
    return { x: 0, y: 85, chromeOffsetY: 85 };
  }
}

/**
 * Move mouse along a natural bezier curve path to target coordinates.
 * On Windows: uses native OS cursor movement.
 * On other platforms: uses Puppeteer's mouse API.
 */
export async function humanMouseMove(page: Page, toX: number, toY: number, fromX?: number, fromY?: number): Promise<void> {
  const startX = fromX ?? rand(100, 400);
  const startY = fromY ?? rand(100, 300);

  const steps = Math.floor(rand(25, 60));
  const path = bezierPath({ x: startX, y: startY }, { x: toX, y: toY }, steps);

  if (IS_WINDOWS) {
    const win = await getWindowBounds(page);
    for (const point of path) {
      nativeMoveTo(win.x + point.x, win.y + point.y);
      await new Promise((r) => setTimeout(r, rand(3, 15)));
    }
  } else {
    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await new Promise((r) => setTimeout(r, rand(2, 12)));
    }
  }
}

/**
 * Click at target with human-like mouse movement + native OS click.
 */
export async function humanClick(page: Page, x: number, y: number): Promise<void> {
  await humanMouseMove(page, x, y);
  await new Promise((r) => setTimeout(r, rand(100, 350)));

  if (IS_WINDOWS) {
    const win = await getWindowBounds(page);
    const screenX = Math.round(win.x + x);
    const screenY = Math.round(win.y + y);
    logger.info(`[Mouse] Native click: page(${Math.round(x)}, ${Math.round(y)}) -> screen(${screenX}, ${screenY})`);
    nativeClick(screenX, screenY);
    // Debug screenshot after click
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: "debug-after-click.png" }).catch(() => {});
  } else {
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, rand(50, 150)));
    await page.mouse.up();
  }
}

/**
 * Random idle mouse movements to appear human on the page.
 */
export async function idleMouseMovements(page: Page, durationMs = 2000): Promise<void> {
  const start = Date.now();
  let lastX = rand(200, 800);
  let lastY = rand(200, 500);

  while (Date.now() - start < durationMs) {
    const nextX = lastX + rand(-80, 80);
    const nextY = lastY + rand(-60, 60);
    const x = Math.max(10, Math.min(1350, nextX));
    const y = Math.max(10, Math.min(750, nextY));

    const microSteps = Math.floor(rand(5, 15));
    const path = bezierPath({ x: lastX, y: lastY }, { x, y }, microSteps);

    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await new Promise((r) => setTimeout(r, rand(5, 20)));
    }

    lastX = x;
    lastY = y;
    await new Promise((r) => setTimeout(r, rand(200, 800)));
  }
}

/**
 * Find and click the Cloudflare Turnstile checkbox.
 * Strategy: locate the iframe by URL, get its bounding box, and click
 * the checkbox position (left side of the iframe, vertically centered).
 */
export async function solveTurnstile(page: Page): Promise<boolean> {
  // Do some idle movements first to look human
  await idleMouseMovements(page, rand(1000, 2000));

  try {
    // The Turnstile widget is injected via script, not a regular <iframe> tag.
    // We need to find it using evaluate to search the full DOM including shadow roots.
    const iframeBox = await page.evaluate(() => {
      // Search for Turnstile iframe — check ALL elements in the DOM
      const allElements = Array.from(document.querySelectorAll("*"));
      for (const el of allElements) {
        // Check shadow roots
        if (el.shadowRoot) {
          const shadowIframes = Array.from(el.shadowRoot.querySelectorAll("iframe"));
          for (const sf of shadowIframes) {
            const src = sf.getAttribute("src") || "";
            if (src.includes("challenges.cloudflare") || src.includes("turnstile")) {
              const rect = sf.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, src };
            }
          }
        }
        // Check regular iframes
        if (el.tagName === "IFRAME") {
          const src = el.getAttribute("src") || "";
          if (src.includes("challenges.cloudflare") || src.includes("turnstile")) {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, src };
          }
        }
      }

      // Last resort: find any visible iframe
      const iframes = Array.from(document.querySelectorAll("iframe"));
      for (const iframe of iframes) {
        const rect = iframe.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 30) {
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, src: iframe.src || "unknown" };
        }
      }

      // Check for div-based widget (cf-turnstile class)
      const widget = document.querySelector(".cf-turnstile, [data-sitekey], #turnstile-wrapper, #cf-turnstile");
      if (widget) {
        const rect = widget.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, src: "div-widget" };
      }

      return null;
    });

    if (iframeBox && iframeBox.width > 10) {
      logger.info(`[Mouse] Turnstile widget at x=${Math.round(iframeBox.x)}, y=${Math.round(iframeBox.y)}, w=${Math.round(iframeBox.width)}, h=${Math.round(iframeBox.height)} src=${iframeBox.src.slice(0, 60)}`);

      // Checkbox is at left side of the widget, vertically centered
      const targetX = iframeBox.x + 28 + rand(-4, 4);
      const targetY = iframeBox.y + iframeBox.height / 2 + rand(-4, 4);

      logger.info(`[Mouse] Clicking Turnstile checkbox at (${Math.round(targetX)}, ${Math.round(targetY)})`);
      await humanClick(page, targetX, targetY);
      return true;
    }

    // Ultimate fallback: use CDP to get the Turnstile frame's position
    // We know the frame URL contains "challenges.cloudflare.com"
    const cdpSession = await page.createCDPSession();
    try {
      const { result } = await cdpSession.send("Runtime.evaluate", {
        expression: `
          (() => {
            const all = document.querySelectorAll("iframe, div");
            for (const el of all) {
              const r = el.getBoundingClientRect();
              if (r.width > 200 && r.width < 400 && r.height > 50 && r.height < 100 && r.y > 100) {
                return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
              }
            }
            return null;
          })()
        `,
      });

      if (result.value && result.value !== "null") {
        const box = JSON.parse(result.value);
        logger.info(`[Mouse] CDP found widget at x=${box.x}, y=${box.y}, w=${box.w}, h=${box.h}`);
        const targetX = box.x + 28 + rand(-4, 4);
        const targetY = box.y + box.h / 2 + rand(-4, 4);
        await humanClick(page, targetX, targetY);
        return true;
      }
    } finally {
      await cdpSession.detach().catch(() => {});
    }

    // Absolute fallback: click where the screenshot showed the checkbox
    // From the debug screenshot: checkbox is roughly at (548, 224) on a 1366x768 viewport
    logger.warn("[Mouse] No widget found — clicking estimated checkbox position");
    await page.screenshot({ path: "debug-turnstile-miss.png" }).catch(() => {});
    const vp = page.viewport();
    const w = vp?.width || 1366;
    // Checkbox is horizontally centered (slightly left of center), about 30% down
    const targetX = w / 2 - 80 + rand(-5, 5);
    const targetY = 225 + rand(-10, 10);
    logger.info(`[Mouse] Fallback click at (${Math.round(targetX)}, ${Math.round(targetY)})`);
    await humanClick(page, targetX, targetY);
    return true;
  } catch (e) {
    logger.error(`[Mouse] solveTurnstile error: ${(e as Error).message}`);
    return false;
  }
}
