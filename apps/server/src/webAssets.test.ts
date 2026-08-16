import { describe, expect, it } from "vitest";
import { createWebAssetsHandler } from "./webAssets";

const distPath = "/virtual/dist";

function fs(files: Record<string, string | Buffer>) {
  return {
    readFile: async (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const entry = files[normalized];
      if (entry === undefined) {
        const error = new Error("not found");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return typeof entry === "string" ? Buffer.from(entry, "utf8") : entry;
    },
    stat: async (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (files[normalized] === undefined) {
        const error = new Error("not found");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      }
      return { isFile: () => true };
    },
  };
}

function handler(files: Record<string, string | Buffer>, options?: { distPath?: string }) {
  const { readFile, stat } = fs(files);
  return createWebAssetsHandler({
    distPath: options?.distPath ?? distPath,
    readFile,
    stat,
  });
}

describe("createWebAssetsHandler", () => {
  it("serves index.html for the root path", async () => {
    const h = handler({ [`${distPath}/index.html`]: "<html>root</html>" });
    const response = await h(new Request("http://127.0.0.1:13773/"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("<html>root</html>");
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves a hashed asset with the correct content type", async () => {
    const h = handler({
      [`${distPath}/index.html`]: "<html></html>",
      [`${distPath}/assets/app-a1b2.js`]: "console.log(1)",
    });
    const response = await h(new Request("http://127.0.0.1:13773/assets/app-a1b2.js"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("console.log(1)");
    expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("falls back to index.html for an extensionless SPA path", async () => {
    const h = handler({ [`${distPath}/index.html`]: "<html>spa</html>" });
    const response = await h(new Request("http://127.0.0.1:13773/chat/thread/123"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("<html>spa</html>");
  });

  it("returns 404 for a missing asset path with an extension", async () => {
    const h = handler({ [`${distPath}/index.html`]: "<html></html>" });
    const response = await h(new Request("http://127.0.0.1:13773/assets/missing.js"));
    expect(response?.status).toBe(404);
  });

  it("returns a 503 actionable response when the web dist is unavailable", async () => {
    const h = handler({}, { distPath: "/missing/dist" });
    const response = await h(new Request("http://127.0.0.1:13773/"));
    expect(response?.status).toBe(503);
    const body = await response?.json();
    expect(body.category).toBe("unavailable");
    expect(body.message).toMatch(/web client/i);
  });

  it("defers API and health paths to later route handlers", async () => {
    const h = handler({ [`${distPath}/index.html`]: "<html></html>" });
    expect(await h(new Request("http://127.0.0.1:13773/api/shell/bootstrap"))).toBeUndefined();
    expect(await h(new Request("http://127.0.0.1:13773/health"))).toBeUndefined();
  });

  it("rejects path traversal outside the dist root", async () => {
    const h = handler({
      [`${distPath}/index.html`]: "<html></html>",
      "/virtual/secret.txt": "secret",
    });
    const response = await h(new Request("http://127.0.0.1:13773/../secret.txt"));
    expect(response?.status).toBe(404);
  });

  it("ignores non-GET requests", async () => {
    const h = handler({ [`${distPath}/index.html`]: "<html></html>" });
    expect(await h(new Request("http://127.0.0.1:13773/", { method: "POST" }))).toBeUndefined();
  });
});
