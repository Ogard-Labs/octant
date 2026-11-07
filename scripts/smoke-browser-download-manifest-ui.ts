import { chromium } from "playwright-core";
import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

/** One finite isolated-render proof; no app host, credentials or live grants. */
async function main() {
  const webRoot = resolve("apps/web");
  const fixture = await mkdtemp(join(webRoot, ".download-manifest-render-"));
  const artifacts = resolve(process.env.OCTANT_QA_OUTPUT ?? "/tmp/octant-download-manifest-ui");
  const permission = {
    permissionId: "10000000-0000-4000-8000-000000000001",
    target: {
      grantee: { kind: "routine", routineId: "20000000-0000-4000-8000-000000000001" },
      label: "Collect daily report",
      modelId: "example-model",
      authority: {
        hostId: "30000000-0000-4000-8000-000000000001",
        mode: "work",
        projectId: "40000000-0000-4000-8000-000000000001",
        providerInstanceId: "50000000-0000-4000-8000-000000000001",
        extension: { kind: "core" },
      },
    },
    recipientRevisionDigest: `sha256:${"a".repeat(64)}`,
    profile: { kind: "personal" },
    origin: "https://reports.example",
    sourceOrigins: Array.from(
      { length: 32 },
      (_, i) => `https://source-${i}.${"a".repeat(40)}.example`,
    ),
    folder: { id: `folder_${"b".repeat(64)}`, kind: "extra", label: "Reports" },
    directory: "daily/reports",
    mediaTypes: ["text/plain", "application/pdf"],
    maxFiles: 5,
    maxBytes: 125 * 1_048_576,
    grantedAt: "2026-11-07T10:00:00.000Z",
    expiresAt: "2026-11-14T10:00:00.000Z",
  };
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browserServer: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  let cleanupFailure: string | undefined;
  let wasInterrupted = false;
  const finishWithin = async (pending: Promise<unknown> | undefined, milliseconds: number) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(Error("Cleanup deadline elapsed.")), milliseconds);
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  };
  const close = () =>
    (stopping ??= (async () => {
      try {
        await finishWithin(browser?.close(), 3000);
        await finishWithin(browserServer?.close(), 3000);
      } catch {
        try {
          await finishWithin(browserServer?.kill(), 3000);
        } catch {
          cleanupFailure = "Owned browser cleanup was not confirmed.";
        }
      }
      vite?.httpServer?.closeAllConnections?.();
      try {
        await finishWithin(vite?.close(), 3000);
      } catch {
        cleanupFailure = "Owned render server cleanup was not confirmed.";
      }
      await rm(fixture, { recursive: true, force: true });
    })());
  const interrupted = () => {
    wasInterrupted = true;
    void close().catch(() => undefined);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let observed: ReadonlyArray<number> = [];
  const childIds = () => {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const ids = new Set([process.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, parent] of rows)
        if (pid !== undefined && parent !== undefined && ids.has(parent) && !ids.has(pid)) {
          ids.add(pid);
          grew = true;
        }
    }
    return [...ids].filter((pid) => pid !== process.pid);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(fixture, "index.html"),
      '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
    );
    await writeFile(
      join(fixture, "main.tsx"),
      `
import {createRoot} from "react-dom/client";
import {BrowserDownloadPermissionsSection} from "../src/browser/BrowserDownloadPermissionsSection";
import {decodeBrowserDownloadPermissionsResult} from "@octant/contracts/browser-download-permissions";
import "../src/styles.css";import "../src/styles/shell.css";import "../src/styles/dock.css";import "../src/styles/environment.css";import "../src/styles/components.css";
const permission=${JSON.stringify(permission)};let granted=false;
const client={manageDownloadPermissions:async command=>{if(command.kind==="grant")granted=true;if(command.kind==="revoke")granted=false;return decodeBrowserDownloadPermissionsResult(command.kind==="targets"?{kind:"download-permission-targets",targets:[{target:permission.target,folders:[permission.folder]}]}:command.kind==="list"?{kind:"download-permissions",permissions:granted?[{permission,remainingFiles:5,remainingBytes:permission.maxBytes}]:[]}:command.kind==="review"?{kind:"download-permission-review",reviewId:"60000000-0000-4000-8000-000000000001",permission}:command.kind==="grant"?{kind:"download-permission-granted",permission}:{kind:"download-permission-revoked",permissionId:permission.permissionId});}};
createRoot(document.getElementById("root")).render(<main className="settings-panel" style={{padding:16,maxWidth:1000,margin:"auto"}}><BrowserDownloadPermissionsSection client={client} profiles={[{profile:{kind:"personal"},label:"Personal",sizeBytes:0}]} /></main>);
`,
    );
    vite = await createServer({
      configFile: join(webRoot, "vite.config.ts"),
      root: webRoot,
      server: { host: "127.0.0.1", port: 0, strictPort: true, open: false, hmr: false },
      logLevel: "error",
    });
    const server = vite;
    await Promise.race([
      (async () => {
        await server.listen();
        const address = server.httpServer?.address();
        if (address === undefined || address === null || typeof address === "string")
          throw Error("Render server did not listen.");
        const origin = `http://127.0.0.1:${address.port}`;
        browserServer = await chromium.launchServer({ headless: true, timeout: 15000 });
        browser = await chromium.connect(browserServer.wsEndpoint());
        for (const [width, height, scale] of [
          [1280, 900, 1],
          [390, 844, 1],
          [390, 844, 1.25],
        ] as const) {
          const page = await browser.newPage({ viewport: { width, height } });
          const failures: string[] = [];
          page.on("pageerror", (error) => failures.push(error.message));
          await page.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          await page.goto(`${origin}/${basename(fixture)}/index.html`);
          if (scale !== 1)
            await page.evaluate(
              (scale) => (document.documentElement.style.fontSize = `${16 * scale}px`),
              scale,
            );
          await page.getByRole("button", { name: "New download manifest…" }).click();
          await page.getByRole("combobox", { name: "Download routine" }).click();
          await page.getByRole("option", { name: "Collect daily report" }).click();
          await page.getByRole("combobox", { name: "Download account profile" }).click();
          await page.getByRole("option", { name: "Personal", exact: true }).click();
          await page.getByRole("combobox", { name: "Download destination folder" }).click();
          await page.getByRole("option", { name: "Reports", exact: true }).click();
          await page.getByRole("textbox", { name: "Download HTTPS site" }).fill(permission.origin);
          await page
            .getByRole("textbox", { name: "Download source sites" })
            .fill(permission.sourceOrigins.join("\n"));
          await page
            .getByRole("textbox", { name: "Download destination directory" })
            .fill(permission.directory);
          await page.getByRole("button", { name: "Review sources and destination" }).click();
          await page.getByRole("button", { name: "Grant download manifest" }).waitFor();
          if (
            (await page
              .getByRole("button", { name: "Revoke download permission for Collect daily report" })
              .count()) !== 0
          )
            throw Error("Review granted permission.");
          const dialog = page.getByRole("dialog");
          await dialog
            .getByRole("heading", { name: "Grant this download manifest?" })
            .scrollIntoViewIfNeeded();
          for (const value of [
            permission.target.label,
            permission.target.modelId,
            permission.origin,
            permission.directory,
          ])
            if ((await dialog.getByText(value, { exact: true }).count()) !== 1)
              throw Error("Review omitted the exact recipient or destination.");
          await page.screenshot({
            path: join(artifacts, `review-top-${width}-${scale}.png`),
            fullPage: true,
          });
          await page
            .getByRole("button", { name: "Grant download manifest" })
            .scrollIntoViewIfNeeded();
          const overflow = await dialog.evaluate(
            (element) => element.scrollWidth > element.clientWidth + 1,
          );
          if (overflow) throw Error("Review overflows horizontally.");
          await page.screenshot({
            path: join(artifacts, `review-${width}-${scale}.png`),
            fullPage: true,
          });
          await page.getByRole("button", { name: "Grant download manifest" }).click();
          await page
            .getByRole("button", { name: "Revoke download permission for Collect daily report" })
            .click();
          await page.getByText("No recurring download permissions.", { exact: true }).waitFor();
          if (failures.length > 0) throw Error(failures.join("\n"));
          await page.close();
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("Rendered manifest proof timed out.")), 90000);
      }),
    ]);
  } finally {
    observed = childIds();
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await close();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const alive = observed.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ESRCH"
          );
        }
      });
      if (alive.length === 0) break;
      if (attempt === 29) cleanupFailure = "Owned render process cleanup was not confirmed.";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (cleanupFailure !== undefined) throw Error(cleanupFailure);
  if (wasInterrupted) throw Error("Rendered manifest proof was interrupted.");
  console.log(
    JSON.stringify({
      check: "download-manifest-rendered",
      status: "passed",
      viewports: [1280, 390],
      largeText: 1.25,
      longSourceChain: 32,
      cleanup: "verified",
      personalAccount: false,
      artifacts,
    }),
  );
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Rendered manifest proof failed.");
  process.exitCode = 1;
});
