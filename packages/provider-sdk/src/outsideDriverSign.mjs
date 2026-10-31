/**
 * Signs an outside provider driver package: writes `octant-signature.json`
 * beside its `octant-provider-driver.json`.
 *
 * The signature is Ed25519 over one exact message: the package's name (its
 * slug), version, protocol versions, and the SHA-256 of every other file in
 * the folder, as the host reads the folder (a `.git` folder is never package
 * content). Octant recomputes every hash itself and builds the same message
 * from its own reading, so a file changed, added, or removed after signing
 * makes the signature invalid.
 *
 * The private key is a PKCS #8 PEM (`openssl genpkey -algorithm ed25519`),
 * read from a file or from standard input. It is never written anywhere and
 * never printed; the tool prints only the public key's fingerprint, which is
 * what Octant shows a person who trusts the package.
 *
 *     node outsideDriverSign.mjs <package-folder> --key-file <private-key.pem>
 *     node outsideDriverSign.mjs <package-folder> --key-stdin < private-key.pem
 *
 * For a package published to npm, add `--name <npm package name>` (for
 * example `@scope/loopback-chat`). The signature then names the package as npm
 * does, so Octant refuses the same files republished under another npm name.
 * Sign the exact files the tarball will hold: the folder `npm pack` unpacks to.
 *
 * This file imports only runtime built-ins, so an author can copy it and run
 * it on Node or Bun without installing anything.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SIGNATURE_FORMAT = "octant-signature/1";

/** A refusal this tool words itself; any other error is reported without its text. */
class SigningRefused extends Error {}
export const SIGNATURE_PATH = "octant-signature.json";
export const DRIVER_DOCUMENT_PATH = "octant-provider-driver.json";

/**
 * The bytes a publisher signs, as UTF-8 text of lines each ended by one LF:
 * the format, `name <name>`, `version <version>`, `protocol <version>` once
 * per version (sorted, no repeats), and `file <sha256 hex> <path>` once per
 * file, sorted by the path's UTF-8 bytes.
 *
 * @param {{ name: string, version: string, protocolVersions: ReadonlyArray<string>, files: ReadonlyArray<{ path: string, sha256: string }> }} content
 * @returns {Uint8Array}
 */
export function signedMessage(content) {
  const encoder = new TextEncoder();
  const protocols = [...new Set(content.protocolVersions)].sort();
  const files = content.files
    .map((file) => ({ ...file, bytes: encoder.encode(file.path) }))
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  const lines = [
    SIGNATURE_FORMAT,
    `name ${content.name}`,
    `version ${content.version}`,
    ...protocols.map((protocol) => `protocol ${protocol}`),
    ...files.map((file) => `file ${file.sha256} ${file.path}`),
  ];
  return encoder.encode(lines.map((line) => `${line}\n`).join(""));
}

/**
 * The fingerprint Octant shows for a public key: `ed25519:` and the hex
 * SHA-256 of its 32 raw bytes.
 *
 * @param {Uint8Array} rawPublicKey
 * @returns {string}
 */
export function publisherKeyFingerprint(rawPublicKey) {
  return `ed25519:${createHash("sha256").update(rawPublicKey).digest("hex")}`;
}

/**
 * Signs the package folder at `root` with `privateKeyPem` and writes its
 * signature file. Returns the fingerprint of the key that signed it.
 *
 * @param {{ root: string, privateKeyPem: string | Uint8Array, name?: string }} input
 * @returns {Promise<{ fingerprint: string, path: string }>}
 */
export async function signOutsideDriverPackage(input) {
  const root = resolve(input.root);
  const document = JSON.parse(await readFile(join(root, DRIVER_DOCUMENT_PATH), "utf8"));
  const manifest = document?.manifest;
  if (
    typeof manifest?.slug !== "string" ||
    typeof manifest?.version !== "string" ||
    !Array.isArray(document?.protocolVersions)
  ) {
    throw new SigningRefused(
      `${DRIVER_DOCUMENT_PATH} names no slug, version, or protocol versions.`,
    );
  }
  const privateKey = createPrivateKey(
    typeof input.privateKeyPem === "string"
      ? input.privateKeyPem
      : Buffer.from(input.privateKeyPem),
  );
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new SigningRefused("The private key is not an Ed25519 key.");
  }
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new SigningRefused("The public key could not be read.");
  const rawPublicKey = Buffer.from(jwk.x, "base64url");

  const files = [];
  for (const path of await packageFiles(root)) {
    if (path === SIGNATURE_PATH) continue;
    const content = await readFile(join(root, ...path.split("/")));
    files.push({ path, sha256: createHash("sha256").update(content).digest("hex") });
  }
  const content = {
    name: input.name ?? manifest.slug,
    version: manifest.version,
    protocolVersions: document.protocolVersions,
    files,
  };
  const signature = sign(null, signedMessage(content), privateKey);
  const sortedFiles = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  const path = join(root, SIGNATURE_PATH);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        format: SIGNATURE_FORMAT,
        name: content.name,
        version: content.version,
        protocolVersions: [...new Set(content.protocolVersions)].sort(),
        files: sortedFiles,
        publicKey: rawPublicKey.toString("base64"),
        signature: signature.toString("base64"),
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  return { fingerprint: publisherKeyFingerprint(rawPublicKey), path };
}

/**
 * Every regular file below `root`, as `/`-separated relative paths, skipping
 * `.git` as the host does. A link cannot be signed, so one is refused.
 *
 * @param {string} root
 * @returns {Promise<Array<string>>}
 */
async function packageFiles(root) {
  const found = [];
  const visit = async (directory) => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.name === ".git") continue;
      const absolute = join(directory, child.name);
      const stats = await lstat(absolute);
      const path = relative(root, absolute).split(sep).join("/");
      if (stats.isSymbolicLink()) throw new SigningRefused(`A link cannot be signed: ${path}`);
      if (stats.isDirectory()) await visit(absolute);
      else if (stats.isFile()) found.push(path);
      else throw new SigningRefused(`Not a file or folder: ${path}`);
    }
  };
  await visit(root);
  return found;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main(argv) {
  const [folder, ...flags] = argv;
  const usage =
    "Usage: outsideDriverSign.mjs <package-folder> (--key-file <private-key.pem> | --key-stdin) [--name <npm package name>]";
  if (folder === undefined) throw new SigningRefused(usage);
  let privateKeyPem;
  let name;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === "--key-file" && value !== undefined) {
      privateKeyPem = await readFile(value);
      index += 1;
    } else if (flag === "--key-stdin") {
      privateKeyPem = await readStandardInput();
    } else if (flag === "--name" && value !== undefined) {
      name = value;
      index += 1;
    } else {
      throw new SigningRefused(usage);
    }
  }
  if (privateKeyPem === undefined) throw new SigningRefused(usage);
  const signed = await signOutsideDriverPackage({
    root: folder,
    privateKeyPem,
    ...(name === undefined ? {} : { name }),
  });
  process.stdout.write(`Signed ${signed.path}\nPublisher key ${signed.fingerprint}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // Only the tool's own words: another error (a key parser's, say) is not repeated.
    process.stderr.write(
      `${error instanceof SigningRefused ? error.message : "Signing failed: the folder or the private key could not be read."}\n`,
    );
    process.exitCode = 1;
  });
}
