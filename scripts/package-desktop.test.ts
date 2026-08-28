import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DESKTOP_PRELOAD_FILENAME } from "../apps/desktop/src/runtimePaths";
import {
  DESKTOP_INTERNAL_RUNTIME_PATTERN,
  DESKTOP_PRELOAD_FORMAT,
} from "../apps/desktop/tsdown.config";
import { SERVER_INTERNAL_RUNTIME_PATTERN } from "../apps/server/tsdown.config";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PACKAGE_IDENTITY,
  DESKTOP_PACKAGE_TARGETS,
  PACKAGED_EXECUTABLE_FILES,
  PACKAGED_ARM64_FILES,
  PACKAGED_LINUX_EXECUTABLE_FILES,
  PACKAGED_LINUX_NATIVE_FILES,
  FORBIDDEN_PACKAGED_FILES,
  FORBIDDEN_PACKAGED_EXECUTABLE_PATTERNS,
  FORBIDDEN_LINUX_HELPER_PATTERNS,
  PACKAGED_RUNTIME_IMPORTS,
  REQUIRED_PACKAGED_FILES,
  REQUIRED_STAGED_PACKAGED_FILES,
  REQUIRED_DARWIN_HELPER_FILES,
  REQUIRED_CODE_WEB_ASSET_PATTERNS,
  APPIMAGE_TOOL_URL,
  createActivateAppleScript,
  createLinuxAppRunScript,
  createLinuxDesktopEntry,
  createNativeRebuildOptions,
  createPackagerOptions,
  createQuitAppleScript,
  createServerRuntimeManifest,
  linuxPackageDirectoryName,
  packagedBundlePath,
  packagedLinuxBundlePath,
  pruneUnusedNativePayloads,
  resolveDesktopPackageTarget,
  resolveNodeExecutable,
  selectFinalBundlePaths,
  selectLinuxPackagePaths,
  validatePackagedRendererPolicy,
  stripNativeDebugMetadata,
  validatePackagedPayload,
  resolveReleaseVersion,
  validateBundledInternalRuntime,
  validatePackagedRuntimeImports,
  validateCodeWebAssets,
  validateLinuxNativePayloadAllowlist,
  validateNativePayloadAllowlist,
  waitForChildExit,
} from "./package-desktop";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("desktop packaging boundary", () => {
  it("defaults the Apple Silicon packager options, and can target Linux x64 AppImage packaging", () => {
    // The version is not cosmetic: the updater compares it against the feed,
    // and a build that cannot say which version it is cannot refuse a
    // downgrade.
    expect(createPackagerOptions("/tmp/octant-stage", "/tmp/octant-out", "0.1.0")).toEqual({
      appBundleId: "app.octant.desktop",
      appVersion: "0.1.0",
      arch: "arm64",
      asar: false,
      dir: "/tmp/octant-stage",
      electronVersion: "43.1.0",
      icon: "/tmp/octant-stage/apps/desktop/resources/icon.icns",
      name: "Octant",
      out: "/tmp/octant-out",
      overwrite: true,
      platform: "darwin",
      prune: false,
      protocols: [{ name: "Octant Code links", schemes: ["octant"] }],
    });
    expect(
      createPackagerOptions(
        "/tmp/octant-stage",
        "/tmp/octant-out",
        "0.1.0",
        DESKTOP_PACKAGE_TARGETS["linux-x64"],
      ),
    ).toEqual({
      appBundleId: "app.octant.desktop",
      appVersion: "0.1.0",
      arch: "x64",
      asar: false,
      dir: "/tmp/octant-stage",
      electronVersion: "43.1.0",
      icon: "/tmp/octant-stage/apps/desktop/resources/icon.png",
      name: "Octant",
      out: "/tmp/octant-out",
      overwrite: true,
      platform: "linux",
      prune: false,
      protocols: [{ name: "Octant Code links", schemes: ["octant"] }],
    });
  });

  it("resolves packaging targets from the host or an explicit override", () => {
    expect(resolveDesktopPackageTarget({}, { platform: "darwin", arch: "arm64" }).id).toBe(
      "darwin-arm64",
    );
    expect(resolveDesktopPackageTarget({}, { platform: "linux", arch: "x64" }).id).toBe(
      "linux-x64",
    );
    expect(
      resolveDesktopPackageTarget(
        { OCTANT_PACKAGE_TARGET: "linux-x64" },
        { platform: "linux", arch: "x64" },
      ).id,
    ).toBe("linux-x64");
    expect(() =>
      resolveDesktopPackageTarget(
        { OCTANT_PACKAGE_TARGET: "linux-x64" },
        { platform: "darwin", arch: "arm64" },
      ),
    ).toThrow(/matching host/);
    expect(() =>
      resolveDesktopPackageTarget(
        { OCTANT_PACKAGE_TARGET: "windows-x64" },
        { platform: "linux", arch: "x64" },
      ),
    ).toThrow(/OCTANT_PACKAGE_TARGET/);
  });

  it("uses only Octant product and bundle identity", () => {
    expect(DESKTOP_PACKAGE_IDENTITY).toEqual({
      bundleId: "app.octant.desktop",
      productName: "Octant",
      version: "0.1.0",
    });
  });

  it("bundles internal Octant packages into both Electron runtimes", () => {
    for (const pattern of [DESKTOP_INTERNAL_RUNTIME_PATTERN, SERVER_INTERNAL_RUNTIME_PATTERN]) {
      expect(pattern.test("@octant/contracts")).toBe(true);
      expect(pattern.test("@octant/domain/code-follow-up-policy")).toBe(true);
      expect(pattern.test("effect")).toBe(false);
      expect(pattern.test("electron")).toBe(false);
    }
  });

  it("requires built desktop, server, web, and runtime dependency content", () => {
    expect({ filename: DESKTOP_PRELOAD_FILENAME, format: DESKTOP_PRELOAD_FORMAT }).toEqual({
      filename: "preload.cjs",
      format: "cjs",
    });
    expect(REQUIRED_STAGED_PACKAGED_FILES).toEqual([
      "apps/desktop/dist/main.mjs",
      "apps/desktop/dist/preload.cjs",
      "apps/desktop/node_modules/effect/package.json",
      "apps/desktop/resources/icon.icns",
      "apps/desktop/resources/icon.png",
      "apps/desktop/resources/menuBarTemplate.png",
      "apps/desktop/resources/menuBarTemplate@2x.png",
      "apps/server/dist/main.mjs",
      "apps/web/dist/index.html",
      "apps/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      "apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
      "apps/server/node_modules/@opencode-ai/sdk/package.json",
      "apps/server/node_modules/effect/package.json",
      "apps/server/node_modules/better-sqlite3/package.json",
      "apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "apps/server/node_modules/node-pty/package.json",
      "apps/server/node_modules/node-pty/build/Release/pty.node",
      "apps/server/node_modules/node-pty/build/Release/spawn-helper",
      "apps/server/node_modules/playwright-core/package.json",
      "apps/server/node_modules/yaml/package.json",
    ]);
    expect(REQUIRED_DARWIN_HELPER_FILES).toEqual([
      "Octant.app/Contents/Resources/native/octant-keychain-helper",
      "Octant.app/Contents/Resources/native/octant-code-file-helper",
    ]);
    expect(REQUIRED_PACKAGED_FILES).toEqual([
      ...REQUIRED_STAGED_PACKAGED_FILES,
      ...REQUIRED_DARWIN_HELPER_FILES,
    ]);
    expect(PACKAGED_EXECUTABLE_FILES).toContain("native/octant-keychain-helper");
    expect(PACKAGED_EXECUTABLE_FILES).toContain("native/octant-code-file-helper");
    expect(PACKAGED_EXECUTABLE_FILES).toContain(
      "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    );
    expect(PACKAGED_LINUX_EXECUTABLE_FILES).toEqual([
      "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ]);
    expect(PACKAGED_LINUX_NATIVE_FILES).toEqual([
      "app/apps/server/node_modules/node-pty/build/Release/pty.node",
      "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
      "app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ]);
    expect(PACKAGED_ARM64_FILES).toEqual([
      "native/octant-keychain-helper",
      "native/octant-code-file-helper",
      "app/apps/server/node_modules/node-pty/build/Release/pty.node",
      "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ]);
    expect(FORBIDDEN_PACKAGED_FILES).toContain(
      "Octant.app/Contents/Resources/app/apps/desktop/dist/native/octant-keychain-helper",
    );
    expect(FORBIDDEN_PACKAGED_FILES).toContain(
      "Octant.app/Contents/Resources/app/apps/desktop/dist/native/octant-code-file-helper",
    );
    expect(FORBIDDEN_LINUX_HELPER_PATTERNS).toHaveLength(2);
    expect(FORBIDDEN_PACKAGED_EXECUTABLE_PATTERNS).toEqual([
      /^apps\/server\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\//,
      /^apps\/server\/node_modules\/@anthropic-ai\/claude-agent-sdk\/(?:vendor\/)?claude(?:\.exe)?$/,
    ]);
  });

  it("refuses Darwin helpers inside a Linux package tree", () => {
    const allowed = [
      "Octant-linux-x64/resources/app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "Octant-linux-x64/resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
      "Octant-linux-x64/resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ];
    expect(() => validateLinuxNativePayloadAllowlist(allowed)).not.toThrow();
    expect(() =>
      validateLinuxNativePayloadAllowlist([
        ...allowed,
        "Octant-linux-x64/resources/native/octant-keychain-helper",
      ]),
    ).toThrow(/Darwin-only helper/);
    expect(() =>
      validateLinuxNativePayloadAllowlist([
        ...allowed,
        "Octant-linux-x64/resources/app/unreviewed.node",
      ]),
    ).toThrow(/unexpected native payload/);
  });

  it("stages a Linux AppDir launcher, desktop entry, and pinned appimagetool URL", () => {
    expect(linuxPackageDirectoryName(DESKTOP_PACKAGE_TARGETS["linux-x64"])).toBe(
      "Octant-linux-x64",
    );
    expect(createLinuxDesktopEntry("0.1.0")).toContain("Name=Octant");
    expect(createLinuxDesktopEntry("0.1.0")).toContain("Icon=octant");
    expect(createLinuxAppRunScript("Octant")).toContain('exec "${HERE}/Octant" "$@"');
    expect(APPIMAGE_TOOL_URL).toContain("appimagetool-x86_64.AppImage");
    expect(
      packagedLinuxBundlePath(
        "apps/server/dist/main.mjs",
        linuxPackageDirectoryName(DESKTOP_PACKAGE_TARGETS["linux-x64"]),
      ),
    ).toBe("Octant-linux-x64/resources/app/apps/server/dist/main.mjs");
    expect(
      selectLinuxPackagePaths(
        [
          "Octant-linux-x64/resources/app/apps/server/dist/main.mjs",
          ".desktop-stage/apps/server/dist/main.mjs",
        ],
        "Octant-linux-x64",
      ),
    ).toEqual(["Octant-linux-x64/resources/app/apps/server/dist/main.mjs"]);
  });
  it("requires Monaco, workers, and Xterm assets in the packaged renderer", () => {
    expect(REQUIRED_CODE_WEB_ASSET_PATTERNS).toHaveLength(5);
    const paths = [
      "apps/web/dist/assets/MonacoEditorPane-a.js",
      "apps/web/dist/assets/editor.api-b.js",
      "apps/web/dist/assets/editor.worker-c.js",
      "apps/web/dist/assets/xtermRuntime-d.js",
      "apps/web/dist/assets/xtermRuntime-e.css",
    ];
    expect(() => validateCodeWebAssets(paths)).not.toThrow();
    expect(() => validateCodeWebAssets(paths.slice(1))).toThrow("Monaco editor pane");
  });

  it("rejects unexpected native payloads while allowing the exact helper, SQLite, and PTY set", () => {
    const allowed = [
      "Octant.app/Contents/Resources/native/octant-keychain-helper",
      "Octant.app/Contents/Resources/native/octant-code-file-helper",
      "Octant.app/Contents/Resources/app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
      "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ];
    expect(() => validateNativePayloadAllowlist(allowed)).not.toThrow();
    expect(() =>
      validateNativePayloadAllowlist([
        ...allowed,
        "Octant.app/Contents/Resources/native/unreviewed-helper",
      ]),
    ).toThrow("unexpected native payload");
  });

  it("prunes dependency build metadata, prebuilds, and native test binaries after the Electron rebuild", async () => {
    const remove = vi.fn(async () => undefined);
    await pruneUnusedNativePayloads("/tmp/octant-stage", remove);
    expect(remove.mock.calls).toEqual([
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/bin",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Release/test_extension.node",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Release/.deps",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Release/.forge-meta",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Release/obj",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Release/obj.target",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Release/sqlite3.a",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/deps",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/obj.target",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/Makefile",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/better_sqlite3.target.mk",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/binding.Makefile",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/config.gypi",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/gyp-mac-tool",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/better-sqlite3/build/test_extension.target.mk",
        { recursive: true, force: true },
      ],
      ["/tmp/octant-stage/apps/server/node_modules/node-pty/bin", { recursive: true, force: true }],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/prebuilds",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/Release/.forge-meta",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/Release/.deps",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/Release/node-addon-api",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/Release/obj.target",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/obj.target",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/Makefile",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/binding.Makefile",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/config.gypi",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/gyp-mac-tool",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/pty.target.mk",
        { recursive: true, force: true },
      ],
      [
        "/tmp/octant-stage/apps/server/node_modules/node-pty/build/spawn-helper.target.mk",
        { recursive: true, force: true },
      ],
    ]);
  });

  it("applies final native allowlisting only to the shipped application bundle", () => {
    expect(
      selectFinalBundlePaths([
        ".desktop-stage/apps/server/node_modules/node-pty/build/Release/pty.node",
        "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
      ]),
    ).toEqual([
      "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
    ]);
  });

  it("strips checkout paths from the staged PTY native payloads", async () => {
    const strip = vi.fn(async () => undefined);
    await stripNativeDebugMetadata("/tmp/octant-stage", strip);

    expect(strip.mock.calls).toEqual([
      ["/tmp/octant-stage/apps/server/node_modules/node-pty/build/Release/pty.node"],
      ["/tmp/octant-stage/apps/server/node_modules/node-pty/build/Release/spawn-helper"],
    ]);
  });

  it("builds both native helpers after the desktop JavaScript bundle", async () => {
    const desktopPackage = JSON.parse(
      await readFile(resolve(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ) as { readonly scripts: { readonly build: string } };

    expect(desktopPackage.scripts.build).toBe(
      "tsdown && bun ../../scripts/build-keychain-helper.ts && bun ../../scripts/build-code-file-helper.ts",
    );
  });

  it("pins the JavaScript SDK runtime without selecting its bundled executable", () => {
    expect(createServerRuntimeManifest().dependencies).toMatchObject({
      "@anthropic-ai/claude-agent-sdk": "0.3.211",
      "playwright-core": "1.62.0",
    });
    expect(PACKAGED_RUNTIME_IMPORTS).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "@opencode-ai/sdk",
      "better-sqlite3",
      "effect",
      "node-pty",
      "playwright-core",
      "yaml",
    ]);
    expect(() =>
      validatePackagedPayload([
        ...REQUIRED_STAGED_PACKAGED_FILES.map((path) => ({ path, content: "Octant" })),
        {
          path: "apps/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
        },
      ]),
    ).toThrow("SDK-bundled Claude executable");
  });

  it("does not stage internal packages behind synthetic export maps", () => {
    expect(Object.keys(createServerRuntimeManifest().dependencies)).not.toContain(
      "@octant/plugin-host",
    );
    expect(PACKAGED_RUNTIME_IMPORTS.some((name) => name.startsWith("@octant/"))).toBe(false);
    expect(REQUIRED_PACKAGED_FILES.some((path) => path.includes("node_modules/@octant/"))).toBe(
      false,
    );
  });

  it("resolves a Node executable for the packaged-import probe without assuming /usr/bin/node", () => {
    expect(
      resolveNodeExecutable(
        () => null,
        {},
        (path) => path === "/exec-daemon/node",
      ),
    ).toBe("/exec-daemon/node");
    expect(
      resolveNodeExecutable(
        () => "/custom/node",
        {},
        () => false,
      ),
    ).toBe("/custom/node");
    expect(
      resolveNodeExecutable(
        () => null,
        { OCTANT_NODE_BINARY: "/opt/node" },
        () => false,
      ),
    ).toBe("/opt/node");
  });

  it("resolves the pinned Agent SDK JavaScript with Node rather than Bun", async () => {
    await expect(
      validatePackagedRuntimeImports(repositoryRoot, ["@anthropic-ai/claude-agent-sdk"]),
    ).resolves.toBeUndefined();
  });

  it("maps staged payload and native resource requirements to bundle-root paths", () => {
    expect(packagedBundlePath("apps/server/dist/main.mjs")).toBe(
      "Octant.app/Contents/Resources/app/apps/server/dist/main.mjs",
    );
    expect(packagedBundlePath("Octant.app/Contents/Resources/native/octant-keychain-helper")).toBe(
      "Octant.app/Contents/Resources/native/octant-keychain-helper",
    );
  });

  it("rebuilds the staged SQLite and PTY native modules for the selected Electron arch", () => {
    expect(createNativeRebuildOptions("/tmp/octant-stage")).toEqual({
      arch: "arm64",
      buildPath: "/tmp/octant-stage/apps/server",
      electronVersion: "43.1.0",
      force: true,
      onlyModules: ["better-sqlite3", "node-pty"],
    });
    expect(
      createNativeRebuildOptions("/tmp/octant-stage", DESKTOP_PACKAGE_TARGETS["linux-x64"]),
    ).toEqual({
      arch: "x64",
      buildPath: "/tmp/octant-stage/apps/server",
      electronVersion: "43.1.0",
      force: true,
      onlyModules: ["better-sqlite3", "node-pty"],
    });
  });

  it("pins node-pty only in the server runtime", async () => {
    const [rootPackage, serverPackage, desktopPackage, webPackage] = await Promise.all([
      readFile(resolve(repositoryRoot, "package.json"), "utf8"),
      readFile(resolve(repositoryRoot, "apps/server/package.json"), "utf8"),
      readFile(resolve(repositoryRoot, "apps/desktop/package.json"), "utf8"),
      readFile(resolve(repositoryRoot, "apps/web/package.json"), "utf8"),
    ]);
    const root = JSON.parse(rootPackage) as { workspaces: { catalog: Record<string, string> } };
    const server = JSON.parse(serverPackage) as { dependencies: Record<string, string> };

    expect(root.workspaces.catalog["node-pty"]).toBe("1.1.0");
    expect(server.dependencies["node-pty"]).toBe("catalog:");
    expect(desktopPackage).not.toContain('"node-pty"');
    expect(webPackage).not.toContain('"node-pty"');
    expect(createServerRuntimeManifest().dependencies["node-pty"]).toBe("1.1.0");
  });

  it("rejects unresolved internal imports before packaging", () => {
    expect(() =>
      validateBundledInternalRuntime([
        {
          path: "apps/server/dist/main.mjs",
          content:
            'import { CodeFollowUpPolicyRejected } from "@octant/domain/code-follow-up-policy";',
        },
      ]),
    ).toThrow("unresolved internal runtime import");

    expect(() =>
      validateBundledInternalRuntime([
        {
          path: "apps/desktop/dist/preload.cjs",
          content: 'const contracts = require("@octant/contracts");',
        },
      ]),
    ).toThrow("unresolved internal runtime import");

    expect(() =>
      validateBundledInternalRuntime([
        { path: "apps/server/dist/main.mjs", content: 'import "effect";' },
        { path: "apps/desktop/dist/main.mjs", content: 'import "electron";' },
      ]),
    ).not.toThrow();
  });

  it("rejects missing runtime content, secrets, source maps, and forbidden identity", () => {
    const required = REQUIRED_STAGED_PACKAGED_FILES.map((path) => ({ path, content: "Octant" }));
    expect(() => validatePackagedPayload(required.slice(1))).toThrow(
      "missing apps/desktop/dist/main.mjs",
    );
    expect(() =>
      validatePackagedPayload([...required, { path: ".env", content: "TOKEN=secret" }]),
    ).toThrow("forbidden packaged path .env");
    expect(() =>
      validatePackagedPayload([...required, { path: "apps/web/dist/app.js.map", content: "{}" }]),
    ).toThrow("forbidden packaged path apps/web/dist/app.js.map");
    expect(() =>
      validatePackagedPayload([
        ...required,
        { path: "apps/web/dist/app.js", content: "Syn" + "ara" },
      ]),
    ).toThrow("forbidden product identity");
    expect(() =>
      validatePackagedPayload([
        ...required,
        { path: "apps/web/dist/app.js", content: "OpenOr" + "bit" },
      ]),
    ).toThrow("forbidden product identity");
  });

  it("keeps output ignored and packages without third-party release tooling", async () => {
    const [gitignore, rootPackage, desktopPackage] = await Promise.all([
      readFile(resolve(repositoryRoot, ".gitignore"), "utf8"),
      readFile(resolve(repositoryRoot, "package.json"), "utf8"),
      readFile(resolve(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ]);

    expect(gitignore.split("\n")).toContain("out/");
    // Signing, notarizing, and feed signing are this repository's own scripts,
    // whose ordering and refusals are tested here. A packaging framework that
    // owned any of those steps would move the decisions somewhere these tests
    // cannot see, which is the thing to keep out — not the words.
    const serializedConfiguration = `${rootPackage}\n${desktopPackage}`.toLowerCase();
    expect(serializedConfiguration).not.toMatch(
      /electron-builder|electron-updater|@electron\/osx-sign|@electron\/notarize/,
    );
  });

  it("refuses a release version that is not the one this repository declares", () => {
    // A build free to name any version can publish 9.0.0 from a branch, and
    // every install that saw it would then refuse the real release as older.
    expect(resolveReleaseVersion({}, "0.2.0")).toBe("0.2.0");
    expect(
      resolveReleaseVersion({ OCTANT_RELEASE_VERSION: "0.2.0-preview.20260828.4" }, "0.2.0"),
    ).toBe("0.2.0-preview.20260828.4");
    expect(() => resolveReleaseVersion({ OCTANT_RELEASE_VERSION: "9.0.0" }, "0.2.0")).toThrow(
      /declares 0\.2\.0/,
    );
    expect(() =>
      resolveReleaseVersion({ OCTANT_RELEASE_VERSION: "not-a-version" }, "0.2.0"),
    ).toThrow(/MAJOR\.MINOR\.PATCH/);
  });

  it("observes a child that exits while its exit listener is being installed", async () => {
    let exitCodeReads = 0;
    const child = {
      get exitCode() {
        exitCodeReads += 1;
        return exitCodeReads === 1 ? null : 0;
      },
      signalCode: null,
      once: () => undefined,
      off: () => undefined,
    };

    await expect(waitForChildExit(child, 10)).resolves.toBeUndefined();
  });

  it("targets the exact directly launched app bundle for graceful quit", () => {
    expect(createActivateAppleScript('/tmp/Octant "Preview".app')).toBe(
      'tell application "/tmp/Octant \\"Preview\\".app" to activate',
    );
    expect(createQuitAppleScript('/tmp/Octant "Preview".app')).toBe(
      'tell application "/tmp/Octant \\"Preview\\".app" to quit',
    );
  });
  it("refuses to ship a renderer whose built policy lost a directive", () => {
    const meta = (content: string) =>
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
    const complete = "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'";

    expect(() => validatePackagedRendererPolicy(meta(complete))).not.toThrow();
    // The build is what can drop it: the source file keeps the directive while
    // the document that ships is the one the renderer actually loads.
    expect(() =>
      validatePackagedRendererPolicy(meta(complete.replace("; script-src 'self'", ""))),
    ).toThrow(/script-src/);
    expect(() => validatePackagedRendererPolicy("<html></html>")).toThrow(
      /no Content-Security-Policy/,
    );
  });

  it("refuses a script-src that keeps 'self' but also allows another source", () => {
    const meta = (content: string) =>
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
    // A substring check on "script-src 'self'" is fooled by this: the required
    // text is present, but the extra source defeats the policy it is meant to
    // enforce.
    const weakened =
      "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'";

    expect(() => validatePackagedRendererPolicy(meta(weakened))).toThrow(/script-src/);
  });

  it("refuses an object-src that keeps 'none' but also allows a remote host", () => {
    const meta = (content: string) =>
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
    const weakened =
      "default-src 'self'; base-uri 'none'; object-src 'none' https://example.invalid; script-src 'self'";

    expect(() => validatePackagedRendererPolicy(meta(weakened))).toThrow(/object-src/);
  });

  it("refuses a policy that declares the same directive twice, since a browser only honours the first", () => {
    const meta = (content: string) =>
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
    // A reviewer scanning the end of the string sees the strict copy, but the
    // browser applies the weak one that came first and silently drops this
    // duplicate.
    const duplicated =
      "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; script-src 'self'";

    expect(() => validatePackagedRendererPolicy(meta(duplicated))).toThrow(/script-src/);
  });

  it("refuses a script-src-elem that is weaker than script-src", () => {
    const meta = (content: string) =>
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
    // script-src-elem overrides script-src for element-sourced scripts when
    // present, so a strict script-src does not protect against a weaker
    // script-src-elem shipping alongside it.
    const weakened =
      "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; script-src-elem 'self' 'unsafe-inline'";

    expect(() => validatePackagedRendererPolicy(meta(weakened))).toThrow(/script-src-elem/);
  });

  it("refuses a script-src-attr that is weaker than script-src", () => {
    const meta = (content: string) =>
      `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
    const weakened =
      "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; script-src-attr 'unsafe-inline'";

    expect(() => validatePackagedRendererPolicy(meta(weakened))).toThrow(/script-src-attr/);
  });

  it("accepts the real shipped renderer policy, including directives it does not require", async () => {
    // This is the policy apps/web actually ships (apps/web/index.html), not a
    // synthetic fixture: it proves the exact-match rule does not start
    // refusing a correct build just because it carries directives, like
    // frame-ancestors or connect-src, that this function does not require.
    const source = await readFile(resolve(repositoryRoot, "apps/web/index.html"), "utf8");

    expect(() => validatePackagedRendererPolicy(source)).not.toThrow();
  });
});
