import { join } from "node:path";

/** The browsers whose cookies a person can import into an Octant profile. */
export type CookieImportBrowserId =
  | "chrome"
  | "chromium"
  | "brave"
  | "edge"
  | "vivaldi"
  | "arc"
  | "firefox";

export interface CookieImportBrowserDefinition {
  readonly id: CookieImportBrowserId;
  readonly label: string;
  /** Folder under the person's `Library/Application Support`. */
  readonly dataFolder: string;
  readonly engine: "chromium" | "firefox";
  /**
   * The macOS Keychain item the browser keeps its cookie key in. The platform's
   * documented route to it is `security find-generic-password`, which makes
   * macOS ask the person; nothing here reads the Keychain by any other way.
   */
  readonly keychain?: { readonly service: string; readonly account: string };
}

export const COOKIE_IMPORT_BROWSERS: ReadonlyArray<CookieImportBrowserDefinition> = [
  {
    id: "chrome",
    label: "Google Chrome",
    dataFolder: "Google/Chrome",
    engine: "chromium",
    keychain: { service: "Chrome Safe Storage", account: "Chrome" },
  },
  {
    id: "chromium",
    label: "Chromium",
    dataFolder: "Chromium",
    engine: "chromium",
    keychain: { service: "Chromium Safe Storage", account: "Chromium" },
  },
  {
    id: "brave",
    label: "Brave",
    dataFolder: "BraveSoftware/Brave-Browser",
    engine: "chromium",
    keychain: { service: "Brave Safe Storage", account: "Brave" },
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    dataFolder: "Microsoft Edge",
    engine: "chromium",
    keychain: { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
  },
  {
    id: "vivaldi",
    label: "Vivaldi",
    dataFolder: "Vivaldi",
    engine: "chromium",
    keychain: { service: "Vivaldi Safe Storage", account: "Vivaldi" },
  },
  {
    id: "arc",
    label: "Arc",
    dataFolder: "Arc/User Data",
    engine: "chromium",
    keychain: { service: "Arc Safe Storage", account: "Arc" },
  },
  { id: "firefox", label: "Firefox", dataFolder: "Firefox", engine: "firefox" },
];

export function cookieImportBrowser(id: string): CookieImportBrowserDefinition | undefined {
  return COOKIE_IMPORT_BROWSERS.find((browser) => browser.id === id);
}

export function browserDataDirectory(home: string, browser: CookieImportBrowserDefinition): string {
  return join(home, "Library", "Application Support", browser.dataFolder);
}
