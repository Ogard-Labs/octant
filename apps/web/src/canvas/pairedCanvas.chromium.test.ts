import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserServer } from "playwright-core";
import { createServer } from "vite";
import { expect, it } from "vitest";

// Hosted, isolated rendered QA; ordinary local unit runs do not launch an app.
it.runIf(process.env.OCTANT_PAIRED_CANVAS_RENDERED === "1")(
  "reads and copies public links at desktop and narrow widths without owner actions",
  async () => {
    const executablePath = process.env.OCTANT_BROWSER_EXECUTABLE ?? "/usr/bin/google-chrome";
    expect(process.env.CI).toBe("true");
    expect(existsSync(executablePath)).toBe(true);
    const artifacts = resolve(process.env.OCTANT_QA_ARTIFACTS ?? "../../.artifacts/paired-canvas");
    await mkdir(artifacts, { recursive: true });
    const server = await createServer({
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    let browser: BrowserServer | undefined;
    let browserClosing: Promise<void> | undefined;
    const close = async () => {
      try {
        if (browser !== undefined) {
          const owned = browser;
          browserClosing ??= (async () => {
            const force = setTimeout(() => void owned.kill(), 3000);
            try {
              await owned.close();
            } finally {
              clearTimeout(force);
            }
          })();
          await browserClosing;
        }
      } finally {
        await server.close();
      }
    };
    const stop = () => {
      void close();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const lifetime = setTimeout(stop, 60_000);
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (address === undefined || address === null || typeof address === "string")
        throw Error("The owned rendered fixture did not bind its loopback port.");
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launchServer({ executablePath, headless: true, timeout: 15_000 });
      const connection = await chromium.connect(browser.wsEndpoint());
      connection.once("disconnected", stop);
      const context = await connection.newContext({
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${origin}/canvas-inventory-browser-evidence.html?public-links=ready`);
        await page.getByRole("heading", { name: "Signed Q3 report" }).waitFor();
        await page.getByRole("button", { name: "More Canvas actions" }).click();
        expect(await page.getByRole("menuitem", { name: "Refine…" }).count()).toBe(0);
        expect(await page.getByRole("menuitem", { name: "Export…" }).count()).toBe(0);
        await page.getByRole("menuitem", { name: "Share…" }).click();
        const dialog = page.getByRole("dialog", { name: "Share canvas" });
        expect(
          await page
            .locator(".octant-dialog__viewport")
            .last()
            .evaluate((element) => getComputedStyle(element).position),
        ).toBe("fixed");
        const bounds = await dialog.boundingBox();
        if (bounds === null) throw Error("The shared dialog is not rendered.");
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
        await page.getByRole("button", { name: "Copy link" }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          "https://shares.example.test/s/AAAAAAAAAAAAAAAAAAAAAA",
        );
        expect(await page.getByRole("button", { name: "Update", exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Revoke", exact: true }).count()).toBe(0);
        await page.screenshot({
          path: resolve(artifacts, `public-links-${width}.png`),
        });
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "More Canvas actions" }).focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("aria-label") === "More Canvas actions",
          undefined,
          { timeout: 3000 },
        );
      }
      await page.goto(`${origin}/canvas-inventory-browser-evidence.html?public-links=error`);
      await page.getByRole("button", { name: "More Canvas actions" }).click();
      await page.getByRole("menuitem", { name: "Share…" }).click();
      await page.getByText("Public links could not be read from this host.").waitFor();
      await page.screenshot({
        path: resolve(artifacts, "public-links-unavailable.png"),
      });
      expect(failures).toEqual([]);
      await context.close();
    } finally {
      clearTimeout(lifetime);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      await close();
      expect(server.httpServer?.listening ?? false).toBe(false);
      expect(browser?.process()?.exitCode !== null || browser?.process()?.signalCode !== null).toBe(
        true,
      );
    }
  },
  75_000,
);
