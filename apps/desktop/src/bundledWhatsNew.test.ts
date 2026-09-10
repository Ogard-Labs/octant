import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_WHATS_NEW_FILENAME,
  MAX_BUNDLED_WHATS_NEW_CHARS,
  acknowledgeWhatsNew,
  decideWhatsNewPresentation,
  encodeLastShownVersion,
  loadBundledWhatsNew,
  parseLastShownVersion,
  parseWhatsNewDocument,
  resolveBundledWhatsNewPath,
  resolveWhatsNewStatePath,
} from "./bundledWhatsNew";

describe("bundled What's new", () => {
  it("resolves packaged notes inside the app payload, not over the network", () => {
    expect(
      resolveBundledWhatsNewPath({
        packaged: true,
        appPath: "/Applications/Octant.app/Contents/Resources/app",
        moduleUrl: "file:///unused",
      }),
    ).toBe("/Applications/Octant.app/Contents/Resources/app/apps/desktop/resources/whats-new.txt");
    expect(
      resolveBundledWhatsNewPath({
        packaged: false,
        appPath: "/unused",
        moduleUrl: pathToFileURL("/repo/apps/desktop/src/bundledWhatsNew.ts").href,
      }),
    ).toBe(resolve("/repo/apps/desktop/resources", BUNDLED_WHATS_NEW_FILENAME));
  });

  it("treats a missing or unreadable document as empty rather than a fetch", () => {
    expect(parseWhatsNewDocument("")).toEqual({ kind: "empty" });
    expect(parseWhatsNewDocument("   \n")).toEqual({ kind: "empty" });
    expect(parseWhatsNewDocument("a".repeat(MAX_BUNDLED_WHATS_NEW_CHARS + 1))).toEqual({
      kind: "empty",
    });
    expect(parseWhatsNewDocument(" Dock pins stay put. \n")).toEqual({
      kind: "notes",
      text: "Dock pins stay put.",
    });
  });

  it("does not open What's new on the first launch of an install", () => {
    // First-run setup is not a release blog.
    expect(
      decideWhatsNewPresentation({
        currentVersion: "0.2.0",
        lastShownVersion: undefined,
        document: { kind: "notes", text: "Octant 0.2.0" },
      }),
    ).toEqual({ showAfterApply: false, recordOnRead: true });
  });

  it("opens bundled notes after a version the person installed finishes applying", () => {
    expect(
      decideWhatsNewPresentation({
        currentVersion: "0.2.0",
        lastShownVersion: "0.1.0",
        document: { kind: "notes", text: "Octant 0.2.0" },
      }),
    ).toEqual({ showAfterApply: true, recordOnRead: false });
  });

  it("stays quiet when the version did not change, or the local document is missing", () => {
    expect(
      decideWhatsNewPresentation({
        currentVersion: "0.2.0",
        lastShownVersion: "0.2.0",
        document: { kind: "notes", text: "Octant 0.2.0" },
      }),
    ).toEqual({ showAfterApply: false, recordOnRead: false });
    expect(
      decideWhatsNewPresentation({
        currentVersion: "0.2.0",
        lastShownVersion: "0.1.0",
        document: { kind: "empty" },
      }),
    ).toEqual({ showAfterApply: false, recordOnRead: false });
  });

  it("returns empty when the bundled file cannot be read", async () => {
    const files = new Map<string, string>();
    const document = await loadBundledWhatsNew({
      currentVersion: "0.1.0",
      notesPath: "/missing/whats-new.txt",
      statePath: resolveWhatsNewStatePath("/data"),
      readFile: async (path) => {
        const contents = files.get(path);
        if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return contents;
      },
      writeFile: async (path, contents) => void files.set(path, contents),
    });

    expect(document).toEqual({ kind: "empty", version: "0.1.0", showAfterApply: false });
    expect(parseLastShownVersion(files.get("/data/octant-whats-new.json") ?? "")).toBe("0.1.0");
  });

  it("shows notes after apply and remembers the version once acknowledged", async () => {
    const files = new Map<string, string>([
      ["/app/whats-new.txt", "Octant 0.2.0\n\nThe dock keeps pins."],
      ["/data/octant-whats-new.json", encodeLastShownVersion("0.1.0")],
    ]);
    const readFile = async (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return contents;
    };
    const writeFile = async (path: string, contents: string) => void files.set(path, contents);

    const document = await loadBundledWhatsNew({
      currentVersion: "0.2.0",
      notesPath: "/app/whats-new.txt",
      statePath: "/data/octant-whats-new.json",
      readFile,
      writeFile,
    });

    expect(document).toEqual({
      kind: "notes",
      version: "0.2.0",
      text: "Octant 0.2.0\n\nThe dock keeps pins.",
      showAfterApply: true,
    });

    await acknowledgeWhatsNew({
      currentVersion: "0.2.0",
      statePath: "/data/octant-whats-new.json",
      writeFile,
    });
    expect(parseLastShownVersion(files.get("/data/octant-whats-new.json") ?? "")).toBe("0.2.0");
  });

  it("treats a corrupt last-shown record as first launch rather than a prompt", () => {
    expect(parseLastShownVersion("not json")).toBeUndefined();
    expect(
      parseLastShownVersion(JSON.stringify({ schemaVersion: 2, lastShownVersion: "0.1.0" })),
    ).toBe(undefined);
  });

  it("ships a local document for the running build", async () => {
    const text = await readFile(
      resolve(import.meta.dirname, "../resources", BUNDLED_WHATS_NEW_FILENAME),
      "utf8",
    );
    expect(parseWhatsNewDocument(text).kind).toBe("notes");
  });
});
