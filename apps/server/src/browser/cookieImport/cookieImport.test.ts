import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqlite } from "../../persistence/sqlitePort";
import { createBrowserCookieReader } from "./browserCookieReader";
import { deriveChromiumCookieKey, decryptChromiumCookieValue } from "./chromiumCookies";
import { listInstalledCookieSources } from "./cookieImportSources";
import type { KeychainPasswordReader } from "./keychainPassword";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A value no real cookie carries, so any leak of it is unmistakable.
const SENTINEL = "SENTINEL-cookie-value-7f3a9c";
const PASSWORD = "fixture-safe-storage-password";
const NOW_MS = Date.parse("2026-10-31T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const WEBKIT_OFFSET = 11_644_473_600;
const toWebkit = (seconds: number) => (seconds + WEBKIT_OFFSET) * 1_000_000;

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "octant-cookie-home-"));
  roots.push(root);
  return root;
}

function encrypt(value: string, host: string, withHostHash: boolean): Buffer {
  const cipher = createCipheriv(
    "aes-128-cbc",
    deriveChromiumCookieKey(PASSWORD),
    Buffer.alloc(16, 0x20),
  );
  const plain = Buffer.concat([
    withHostHash ? createHash("sha256").update(host).digest() : Buffer.alloc(0),
    Buffer.from(value),
  ]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

interface FixtureCookie {
  readonly host: string;
  readonly name: string;
  readonly value: string;
  readonly encrypt?: boolean;
  readonly expiresAtSeconds?: number;
  readonly path?: string;
  readonly secure?: boolean;
  readonly sameSite?: number;
  readonly partitionKey?: string;
}

/** A Chromium-family profile on a fake Mac, with a cookie database in its real shape. */
function chromeProfile(
  root: string,
  cookies: ReadonlyArray<FixtureCookie>,
  options: { readonly version?: number; readonly folder?: string } = {},
): void {
  const base = join(root, "Library", "Application Support", "Google", "Chrome");
  const folder = options.folder ?? "Default";
  mkdirSync(join(base, folder, "Network"), { recursive: true });
  writeFileSync(
    join(base, "Local State"),
    JSON.stringify({ profile: { info_cache: { [folder]: { name: "Person 1" } } } }),
  );
  const database = openSqlite(join(base, folder, "Network", "Cookies"));
  database.exec("CREATE TABLE meta (key TEXT UNIQUE NOT NULL, value TEXT)");
  database.exec(
    `CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)`,
  );
  const version = options.version ?? 24;
  database.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const insert = database.prepare(
    "INSERT INTO cookies VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
  );
  for (const cookie of cookies) {
    const expires = cookie.expiresAtSeconds;
    insert.run(
      cookie.host,
      cookie.partitionKey ?? "",
      cookie.name,
      cookie.encrypt === false ? cookie.value : "",
      cookie.encrypt === false
        ? Buffer.alloc(0)
        : encrypt(cookie.value, cookie.host, version >= 24),
      cookie.path ?? "/",
      expires === undefined ? 0 : toWebkit(expires),
      cookie.secure === false ? 0 : 1,
      expires === undefined ? 0 : 1,
      cookie.sameSite ?? 1,
    );
  }
  database.close();
}

const keychain = (answer: Awaited<ReturnType<KeychainPasswordReader>>) =>
  vi.fn<KeychainPasswordReader>(async () => answer);

function reader(root: string, readKeychainPassword: KeychainPasswordReader) {
  return createBrowserCookieReader({
    home: root,
    readKeychainPassword,
    now: () => NOW_MS,
  });
}

const future = NOW_SECONDS + 86_400;

describe("cookie import sources", () => {
  it("lists installed browsers and their profiles by name, and opens no database to do it", () => {
    const root = home();
    chromeProfile(root, [{ host: ".example.com", name: "sid", value: SENTINEL }]);

    const sources = listInstalledCookieSources(root);

    expect(sources.map((source) => source.browser.id)).toEqual(["chrome"]);
    expect(sources[0]?.profiles.map((profile) => [profile.id, profile.label])).toEqual([
      ["Default", "Person 1"],
    ]);
  });

  it("offers nothing on a Mac with no other browser", () => {
    expect(listInstalledCookieSources(home())).toEqual([]);
  });

  it("lists a Firefox profile from profiles.ini and ignores a path that leaves the browser's folder", () => {
    const root = home();
    const base = join(root, "Library", "Application Support", "Firefox");
    mkdirSync(join(base, "Profiles", "abcd.default"), { recursive: true });
    writeFileSync(join(base, "Profiles", "abcd.default", "cookies.sqlite"), "");
    writeFileSync(
      join(base, "profiles.ini"),
      [
        "[Profile0]",
        "Name=default",
        "IsRelative=1",
        "Path=Profiles/abcd.default",
        "",
        "[Profile1]",
        "Name=sneaky",
        "IsRelative=1",
        "Path=../../../../etc",
      ].join("\n"),
    );

    const [firefox] = listInstalledCookieSources(root);

    expect(firefox?.profiles.map((profile) => profile.id)).toEqual(["Profiles/abcd.default"]);
  });
});

describe("Chromium cookie reading", () => {
  it("decrypts a value with the key the Keychain password gives, host hash included", () => {
    const key = deriveChromiumCookieKey(PASSWORD);

    expect(decryptChromiumCookieValue(encrypt("abc", "x.com", true), key, true)).toBe("abc");
    expect(decryptChromiumCookieValue(encrypt("abc", "x.com", false), key, false)).toBe("abc");
    expect(
      decryptChromiumCookieValue(
        encrypt("abc", "x.com", true),
        deriveChromiumCookieKey("other"),
        true,
      ),
    ).toBeUndefined();
    expect(decryptChromiumCookieValue(Buffer.from("v11nothing"), key, true)).toBeUndefined();
  });

  it("asks the Keychain once, reads every cookie, and leaves nothing behind in the work folder", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "sid", value: SENTINEL, expiresAtSeconds: future },
      {
        host: "app.example.com",
        name: "host-only",
        value: "two",
        expiresAtSeconds: future,
        sameSite: 2,
      },
      { host: ".example.com", name: "session", value: "three" },
    ]);
    const ask = keychain({ status: "ok", password: PASSWORD });
    const work = mkdtempSync(join(tmpdir(), "octant-cookie-work-"));
    roots.push(work);

    const result = await createBrowserCookieReader({
      home: root,
      readKeychainPassword: ask,
      now: () => NOW_MS,
      workDirectory: work,
    }).read("chrome", "Default");

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({ service: "Chrome Safe Storage", account: "Chrome" });
    expect(result.status).toBe("read");
    if (result.status !== "read") return;
    expect(result.cookies).toEqual([
      {
        domain: ".example.com",
        hostOnly: false,
        name: "sid",
        value: SENTINEL,
        path: "/",
        secure: true,
        httpOnly: true,
        expiresAt: future,
        sameSite: "lax",
      },
      {
        domain: "app.example.com",
        hostOnly: true,
        name: "host-only",
        value: "two",
        path: "/",
        secure: true,
        httpOnly: true,
        expiresAt: future,
        sameSite: "strict",
      },
      {
        domain: ".example.com",
        hostOnly: false,
        name: "session",
        value: "three",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
    ]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("reads a database written before the host hash was added to values", async () => {
    const root = home();
    chromeProfile(
      root,
      [{ host: ".old.example", name: "n", value: "v", expiresAtSeconds: future }],
      {
        version: 20,
      },
    );

    const result = await reader(root, keychain({ status: "ok", password: PASSWORD })).read(
      "chrome",
      "Default",
    );

    expect(result).toMatchObject({ status: "read", cookies: [{ value: "v" }] });
  });

  it("skips what it should not carry and says how many, instead of failing", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "ok", value: "1", expiresAtSeconds: future },
      { host: ".example.com", name: "expired", value: "2", expiresAtSeconds: NOW_SECONDS - 10 },
      {
        host: ".example.com",
        name: "chips",
        value: "3",
        expiresAtSeconds: future,
        partitionKey: "https://other.example",
      },
      { host: ".example.com", name: "__Host-bad", value: "4", expiresAtSeconds: future },
      { host: "not a host!", name: "weird", value: "5", expiresAtSeconds: future },
    ]);

    const result = await reader(root, keychain({ status: "ok", password: PASSWORD })).read(
      "chrome",
      "Default",
    );

    expect(result).toMatchObject({ status: "read", skipped: 4 });
    if (result.status === "read")
      expect(result.cookies.map((cookie) => cookie.name)).toEqual(["ok"]);
  });

  it("reads plain values without asking the Keychain at all", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "plain", value: "p", encrypt: false, expiresAtSeconds: future },
    ]);
    const ask = keychain({ status: "refused" });

    const result = await reader(root, ask).read("chrome", "Default");

    expect(result).toMatchObject({ status: "read", cookies: [{ value: "p" }] });
    expect(ask).not.toHaveBeenCalled();
  });

  it("imports nothing and reads no value when the person refuses the Keychain prompt", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "sid", value: SENTINEL, expiresAtSeconds: future },
    ]);

    const result = await reader(root, keychain({ status: "refused" })).read("chrome", "Default");

    expect(result).toEqual({ status: "refused", reason: "keychain-refused" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("reports a Keychain with no such item as unreadable, not as a refusal", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "sid", value: "v", expiresAtSeconds: future },
    ]);

    expect(await reader(root, keychain({ status: "missing" })).read("chrome", "Default")).toEqual({
      status: "refused",
      reason: "source-unreadable",
    });
  });

  it("reports a wrong key as unreadable rather than importing garbage", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "sid", value: "v", expiresAtSeconds: future },
    ]);

    const result = await reader(root, keychain({ status: "ok", password: "not the key" })).read(
      "chrome",
      "Default",
    );

    expect(result).toMatchObject({ status: "read", cookies: [], skipped: 1 });
  });

  it("refuses a browser or profile the listing does not offer, and a path trick", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "sid", value: "v", expiresAtSeconds: future },
    ]);
    const ask = keychain({ status: "ok", password: PASSWORD });

    for (const [browser, profile] of [
      ["brave", "Default"],
      ["chrome", "Profile 9"],
      ["chrome", "../../../../etc"],
    ] as const) {
      expect(await reader(root, ask).read(browser, profile)).toEqual({
        status: "refused",
        reason: "source-not-found",
      });
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("reads a Firefox profile in the clear with no Keychain access", async () => {
    const root = home();
    const base = join(root, "Library", "Application Support", "Firefox");
    mkdirSync(join(base, "Profiles", "abcd.default"), { recursive: true });
    writeFileSync(
      join(base, "profiles.ini"),
      "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abcd.default\n",
    );
    const database = openSqlite(join(base, "Profiles", "abcd.default", "cookies.sqlite"));
    database.exec(
      "CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)",
    );
    const insert = database.prepare("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, 1, 0, 1, ?)");
    insert.run(".example.org", "sid", SENTINEL, "/", future, "");
    insert.run(".example.org", "container", "x", "/", future, "^userContextId=2");
    database.close();
    const ask = keychain({ status: "refused" });

    const result = await reader(root, ask).read("firefox", "Profiles/abcd.default");

    expect(result).toMatchObject({
      status: "read",
      skipped: 1,
      cookies: [{ name: "sid", value: SENTINEL, domain: ".example.org", expiresAt: future }],
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("never touches the original database", async () => {
    const root = home();
    chromeProfile(root, [
      { host: ".example.com", name: "sid", value: "v", expiresAtSeconds: future },
    ]);
    const original = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default",
      "Network",
      "Cookies",
    );
    const before = existsSync(original);

    await reader(root, keychain({ status: "ok", password: PASSWORD })).read("chrome", "Default");

    expect(before && existsSync(original)).toBe(true);
    expect(existsSync(`${original}-journal`)).toBe(false);
  });
});
