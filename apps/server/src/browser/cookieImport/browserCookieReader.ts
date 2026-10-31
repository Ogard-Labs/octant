import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CookieImportBrowserId, ImportedCookie } from "@octant/contracts";
import { readChromiumCookies, deriveChromiumCookieKey } from "./chromiumCookies";
import { cookieImportBrowser } from "./cookieImportBrowsers";
import { listInstalledCookieSources, publicCookieSources } from "./cookieImportSources";
import { readFirefoxCookies } from "./firefoxCookies";
import type { KeychainPasswordReader } from "./keychainPassword";

export type CookieReadRefusal = "source-not-found" | "keychain-refused" | "source-unreadable";

export type CookieRead =
  | {
      readonly status: "read";
      readonly cookies: ReadonlyArray<ImportedCookie>;
      readonly skipped: number;
    }
  | { readonly status: "refused"; readonly reason: CookieReadRefusal };

export interface BrowserCookieReaderOptions {
  readonly home: string;
  readonly readKeychainPassword: KeychainPasswordReader;
  readonly now: () => number;
  /** Where the working copy of a cookie database goes. Defaults to the OS temp folder. */
  readonly workDirectory?: string;
}

export interface BrowserCookieReader {
  readonly listSources: () => ReturnType<typeof publicCookieSources>;
  /**
   * Reads one browser profile's cookies, on the person's explicit pick and
   * nowhere else. A Chromium-family browser's key is asked of the Keychain only
   * when its database actually holds encrypted values, and only through the
   * platform's own prompt; a refusal reads nothing.
   */
  readonly read: (browser: CookieImportBrowserId, sourceProfile: string) => Promise<CookieRead>;
}

export function createBrowserCookieReader(
  options: BrowserCookieReaderOptions,
): BrowserCookieReader {
  return {
    listSources: () => publicCookieSources(listInstalledCookieSources(options.home)),
    async read(browserId, sourceProfile) {
      const definition = cookieImportBrowser(browserId);
      // The pick must be one the listing offers: a profile id never reaches a
      // path unless an installed browser named it.
      const profile = listInstalledCookieSources(options.home)
        .find((source) => source.browser.id === browserId)
        ?.profiles.find((candidate) => candidate.id === sourceProfile);
      if (definition === undefined || profile === undefined) {
        return { status: "refused", reason: "source-not-found" };
      }
      const work = mkdtempSync(
        join(options.workDirectory ?? tmpdir(), "octant-cookie-import-"),
        {},
      );
      try {
        // The browser may be running and holds its database open; a copy is read
        // so the original is never touched and a half-written page cannot hurt.
        const copy = join(work, "cookies.sqlite");
        copyFileSync(profile.cookiePath, copy);
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(`${profile.cookiePath}${suffix}`)) {
            copyFileSync(`${profile.cookiePath}${suffix}`, `${copy}${suffix}`);
          }
        }
        const nowSeconds = Math.floor(options.now() / 1_000);
        if (definition.engine === "firefox") {
          const read = readFirefoxCookies({ databasePath: copy, nowSeconds });
          return read.status === "read" ? read : { status: "refused", reason: "source-unreadable" };
        }
        const first = readChromiumCookies({ databasePath: copy, key: undefined, nowSeconds });
        if (first.status === "read") return first;
        if (first.status === "unreadable" || definition.keychain === undefined) {
          return { status: "refused", reason: "source-unreadable" };
        }
        const keychain = await options.readKeychainPassword(definition.keychain);
        if (keychain.status === "refused") return { status: "refused", reason: "keychain-refused" };
        if (keychain.status === "missing")
          return { status: "refused", reason: "source-unreadable" };
        const second = readChromiumCookies({
          databasePath: copy,
          key: deriveChromiumCookieKey(keychain.password),
          nowSeconds,
        });
        return second.status === "read"
          ? second
          : { status: "refused", reason: "source-unreadable" };
      } catch {
        return { status: "refused", reason: "source-unreadable" };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
