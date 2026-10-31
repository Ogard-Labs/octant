import { execFile } from "node:child_process";

export type KeychainRead =
  | { readonly status: "ok"; readonly password: string }
  /** The person said no, the Keychain is locked, or macOS would not answer. */
  | { readonly status: "refused" }
  /** The Keychain holds no such item. */
  | { readonly status: "missing" };

export type KeychainPasswordReader = (item: {
  readonly service: string;
  readonly account: string;
}) => Promise<KeychainRead>;

const SECURITY_TOOL = "/usr/bin/security";
/** `security` exits with 44 when the item does not exist. */
const ITEM_NOT_FOUND_EXIT_CODE = 44;
/** Long enough for a person to read macOS's prompt and answer it. */
const PROMPT_TIMEOUT_MS = 180_000;

/**
 * Reads a generic password through the platform's documented tool. macOS shows
 * the person its own Keychain prompt, naming the item, and returns the secret
 * only if they allow it; a refusal comes back as `refused` with nothing read.
 * The secret never leaves this function except as the return value, and no
 * failure carries it.
 */
export const readKeychainPasswordWithSecurityTool: KeychainPasswordReader = (item) =>
  new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve({ status: "refused" });
      return;
    }
    execFile(
      SECURITY_TOOL,
      ["find-generic-password", "-w", "-s", item.service, "-a", item.account],
      { timeout: PROMPT_TIMEOUT_MS, maxBuffer: 16 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error === null) {
          const password = stdout.replace(/\r?\n$/, "");
          resolve(password === "" ? { status: "refused" } : { status: "ok", password });
          return;
        }
        const code: unknown = (error as { code?: unknown }).code;
        resolve(code === ITEM_NOT_FOUND_EXIT_CODE ? { status: "missing" } : { status: "refused" });
      },
    );
  });
