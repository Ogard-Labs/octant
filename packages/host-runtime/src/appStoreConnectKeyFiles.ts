import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readAppStoreConnectKey, type OnePasswordRead } from "./appStoreConnectKeySource";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

const BODY_LIMIT = 4 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The only folders a key file may be written to: one per upload, named for its action. */
const UPLOAD_FOLDER = /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_FILE = /^AuthKey_[A-Z0-9]{10}\.p8$/;

/**
 * The broker's two file routes for the App Store Connect key (slice 7 of
 * docs/design/apple-devices.md). For one upload the broker writes the stored
 * `.p8` key to a `0600` file in that upload's private folder and, when the
 * upload's launch ends, removes it. The answer names the file, the issuer ID,
 * and the key ID, never the key: the server hands the path to the upload
 * launch and never reads the key's bytes.
 *
 * The folder must be a direct child of the root the desktop gave the broker
 * (a `0700` directory in the host's data directory every other launch is
 * denied), named `upload-<uuid>`, a real directory owned by this user and
 * readable by no one else. A broker token alone therefore cannot have the key
 * written anywhere a confined launch or another user could read it.
 */
export async function handleAppStoreConnectKeyFileRoute(
  operation: "write-key-file" | "remove-key-file",
  request: Request,
  store: CredentialStore,
  root: string | undefined,
  readOnePassword: OnePasswordRead,
): Promise<Response> {
  if (root === undefined) return failure("not-found", 404);
  const body = await readBody(request, operation === "write-key-file");
  if (body.kind !== "ok") return failure(body.kind, body.kind === "too-large" ? 413 : 400);
  const folder = await privateUploadFolder(root, body.directory);
  if (folder === undefined) return failure("invalid-directory", 400);

  if (operation === "remove-key-file") {
    await removeKeyFiles(folder);
    return Response.json({ removed: true });
  }

  let stored: string;
  try {
    stored = await store.resolve(body.credentialRef);
  } catch (error) {
    if (error instanceof CredentialStoreFailure) {
      const status =
        error.category === "missing" ? 404 : error.category === "unavailable" ? 503 : 500;
      return failure(error.category, status);
    }
    return failure("failed", 503);
  }
  // A key kept in 1Password is read now, for this one upload, and dropped
  // with this call.
  const read = await readAppStoreConnectKey(stored, readOnePassword);
  if (read.kind === "invalid-stored-key") return failure("invalid-stored-key", 500);
  if (read.kind === "key-source-unavailable") return failure("key-source-unavailable", 424);
  const key = read.key;
  const file = join(folder, `AuthKey_${key.keyId}.p8`);
  try {
    // `wx` refuses a file already there, link or not, so the key is written
    // only to a file this call created, with no one but its owner able to read it.
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(key.privateKey, "utf8");
    } finally {
      await handle.close();
    }
  } catch {
    await removeKeyFiles(folder);
    return failure("unwritable", 409);
  }
  return Response.json({ file, issuerId: key.issuerId, keyId: key.keyId });
}

async function readBody(
  request: Request,
  needsKey: boolean,
): Promise<
  | { readonly kind: "ok"; readonly credentialRef: string; readonly directory: string }
  | { readonly kind: "invalid-request" | "too-large" }
> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) return { kind: "too-large" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "invalid-request" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid-request" };
  }
  const record = value as Record<string, unknown>;
  const expected = needsKey ? "credentialRef,directory" : "directory";
  if (Object.keys(record).sort().join(",") !== expected) return { kind: "invalid-request" };
  const directory = record.directory;
  const credentialRef = needsKey ? record.credentialRef : "";
  if (typeof directory !== "string" || typeof credentialRef !== "string") {
    return { kind: "invalid-request" };
  }
  if (needsKey && !UUID_PATTERN.test(credentialRef)) return { kind: "invalid-request" };
  return { kind: "ok", credentialRef, directory };
}

/**
 * The upload folder, when it is exactly one private `upload-<uuid>` directory
 * directly inside the root. Anything else, a link included, is refused.
 */
async function privateUploadFolder(root: string, directory: string): Promise<string | undefined> {
  if (!UPLOAD_FOLDER.test(basename(directory))) return undefined;
  try {
    const realRoot = await realpath(root);
    const realParent = await realpath(dirname(directory));
    if (realParent !== realRoot) return undefined;
    const folder = join(realRoot, basename(directory));
    const stat = await lstat(folder);
    const uid = process.getuid?.();
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid)
    ) {
      return undefined;
    }
    return folder;
  } catch {
    return undefined;
  }
}

async function removeKeyFiles(folder: string): Promise<void> {
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!KEY_FILE.test(name)) continue;
    try {
      await unlink(join(folder, name));
    } catch {
      // Already gone; the server's sweep removes the folder itself.
    }
  }
}

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
