import { describe, expect, it } from "vitest";
import {
  BUNDLED_TYPESCRIPT_LANGUAGE_SERVER,
  BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT,
  bundledLanguageServerComponent,
  resolveBundledLanguageServerActivation,
} from "./bundledLanguageServers";

describe("bundled language servers", () => {
  it("ships the TypeScript server as a reviewed static language-server component", () => {
    const bundled = bundledLanguageServerComponent(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER);
    expect(bundled.manifest.source).toEqual({
      kind: "bundled",
      sourceRef: "app:language-server-typescript",
    });
    expect(bundled.manifest.provenance.reviewed).toBe(true);
    expect(bundled.entryPoint).toBe(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT);
    expect(bundled.languageServer).toEqual({
      languages: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
      launchClass: "static",
    });
  });

  it("is on by default in Code and contributes nothing in Chat or Work", () => {
    expect(
      resolveBundledLanguageServerActivation(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER, "code"),
    ).toEqual({ kind: "effective" });
    for (const mode of ["chat", "work"] as const) {
      expect(
        resolveBundledLanguageServerActivation(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER, mode, {
          modeAllowed: true,
        }),
      ).toEqual({ kind: "blocked", reason: "mode-prohibited" });
    }
  });

  it("reads as blocked when this install has no binary for it", () => {
    expect(
      resolveBundledLanguageServerActivation(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER, "code", {
        unavailable: true,
      }),
    ).toEqual({ kind: "blocked", reason: "unavailable" });
  });
});
