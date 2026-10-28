import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publisherKeyFingerprint, signedMessage } from "./outsideDriverSign.mjs";

const tool = fileURLToPath(new URL("./outsideDriverSign.mjs", import.meta.url));
const folders: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function driverFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-sign-tool-"));
  folders.push(root);
  await writeFile(
    join(root, "octant-provider-driver.json"),
    JSON.stringify({
      driverKind: "outside-harness-endpoint",
      protocolVersions: ["harness-endpoint/1"],
      manifest: { slug: "loopback-chat", version: "0.1.0" },
    }),
  );
  await writeFile(join(root, "driver.mjs"), "export default {};\n");
  return root;
}

function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    fingerprint: publisherKeyFingerprint(raw),
  };
}

describe("the outside driver signing tool", () => {
  it("builds the signed message the host builds, line for line", () => {
    const message = signedMessage({
      name: "loopback-chat",
      version: "0.1.0",
      protocolVersions: ["harness-endpoint/1"],
      files: [
        { path: "lib/b.mjs", sha256: "b".repeat(64) },
        { path: "driver.mjs", sha256: "a".repeat(64) },
      ],
    });
    expect(new TextDecoder().decode(message)).toBe(
      [
        "octant-signature/1",
        "name loopback-chat",
        "version 0.1.0",
        "protocol harness-endpoint/1",
        `file ${"a".repeat(64)} driver.mjs`,
        `file ${"b".repeat(64)} lib/b.mjs`,
        "",
      ].join("\n"),
    );
  });

  it.each(["--key-stdin", "--key-file"] as const)(
    "signs a folder with a key read by %s and prints only the public key's fingerprint",
    async (flag) => {
      const root = await driverFolder();
      const key = throwawayKey();
      const keyFile = join(root, "..", `${root.split("/").pop() ?? "key"}.pem`);
      folders.push(keyFile);
      await writeFile(keyFile, key.pem, { mode: 0o600 });

      const run = spawnSync(
        process.execPath,
        [tool, root, flag, ...(flag === "--key-file" ? [keyFile] : [])],
        { input: flag === "--key-stdin" ? key.pem : "", encoding: "utf8" },
      );

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`Publisher key ${key.fingerprint}`);
      const keyBody = key.pem.split("\n")[1] ?? "";
      expect(`${run.stdout}${run.stderr}`).not.toContain(keyBody);
      const written = await readFile(join(root, "octant-signature.json"), "utf8");
      expect(written).not.toContain(keyBody);
      expect(JSON.parse(written)).toMatchObject({
        format: "octant-signature/1",
        name: "loopback-chat",
        version: "0.1.0",
        protocolVersions: ["harness-endpoint/1"],
        files: [{ path: "driver.mjs" }, { path: "octant-provider-driver.json" }],
      });
    },
  );

  it("refuses a key that is not Ed25519 without repeating it", async () => {
    const root = await driverFolder();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();

    const run = spawnSync(process.execPath, [tool, root, "--key-stdin"], {
      input: rsa,
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toBe("The private key is not an Ed25519 key.\n");
  });
});
