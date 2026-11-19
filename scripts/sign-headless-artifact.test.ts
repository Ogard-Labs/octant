import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createReleaseFeedVerifier,
  decodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
  verifyHeadlessArtifactSignature,
} from "@octant/host-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildHeadlessArtifact, type HeadlessComponentSource } from "./package-headless";
import {
  signHeadlessArtifactDirectory,
  signHeadlessArtifactTarball,
} from "./sign-headless-artifact";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

async function builtArtifact() {
  const base = temporaryRoot("octant-headless-sign-");
  const files: ReadonlyArray<readonly [HeadlessComponentSource["role"], string, string]> = [
    ["server", "lib/server/main.mjs", "console.log('server');\n"],
    ["cli", "bin/octant", "#!/usr/bin/env bun\nconsole.log('cli');\n"],
    ["web-assets", "share/web/index.html", "<html></html>\n"],
    ["native-module", "lib/native/better_sqlite3.node", "native-bytes"],
    ["migrations", "share/migrations.json", '{"storeVersion":1}\n'],
    ["notices", "share/NOTICES.txt", "third-party notices\n"],
    ["service-template", "share/service/octant.service.template", "[Unit]\n"],
    ["runtime", "lib/runtime/bun", "runtime-bytes"],
  ];
  const components = files.map(([role, path, body]) => {
    const source = join(base, "sources", path.replaceAll("/", "_"));
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, body);
    return { role, path, source };
  });
  return await buildHeadlessArtifact({
    version: "1.2.3",
    target: { platform: "linux", arch: "arm64" },
    wireVersion: "1",
    storeVersion: 1,
    components,
    outputDirectory: join(base, "out"),
  });
}

function previewTrust(publicKeyBase64: string) {
  return { stable: [], preview: [publicKeyBase64], candidate: [publicKeyBase64] };
}

describe("signing a headless build for release", () => {
  it("signs a build so the install check accepts it", async () => {
    const built = await builtArtifact();
    const ringKey = keyPair();
    const result = await signHeadlessArtifactDirectory({
      artifactRoot: built.artifactRoot,
      ring: "preview",
      privateKeyBase64: ringKey.privateKeyBase64,
      trustedKeys: previewTrust(ringKey.publicKeyBase64),
    });
    expect(result).toEqual({ status: "signed", version: "1.2.3" });
    expect(
      verifyHeadlessArtifactSignature({
        manifest: decodeHeadlessArtifactManifest(
          readFileSync(join(built.artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME), "utf8"),
        ),
        signatureText: readFileSync(
          join(built.artifactRoot, HEADLESS_ARTIFACT_SIGNATURE_FILENAME),
          "utf8",
        ),
        verifier: createReleaseFeedVerifier(previewTrust(ringKey.publicKeyBase64)),
      }),
    ).toEqual({ status: "verified", ring: "preview" });
  });

  it("refuses to sign a build whose files no longer match its manifest", async () => {
    const built = await builtArtifact();
    const ringKey = keyPair();
    writeFileSync(join(built.artifactRoot, "lib/server/main.mjs"), "changed after the build");
    const result = await signHeadlessArtifactDirectory({
      artifactRoot: built.artifactRoot,
      ring: "preview",
      privateKeyBase64: ringKey.privateKeyBase64,
      trustedKeys: previewTrust(ringKey.publicKeyBase64),
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(readdirSync(built.artifactRoot)).not.toContain(HEADLESS_ARTIFACT_SIGNATURE_FILENAME);
  });

  it("refuses a key the release keys do not trust for that ring", async () => {
    const built = await builtArtifact();
    const ringKey = keyPair();
    const result = await signHeadlessArtifactDirectory({
      artifactRoot: built.artifactRoot,
      ring: "stable",
      privateKeyBase64: ringKey.privateKeyBase64,
      trustedKeys: previewTrust(ringKey.publicKeyBase64),
    });
    expect(result).toMatchObject({ status: "refused" });
    expect(readdirSync(built.artifactRoot)).not.toContain(HEADLESS_ARTIFACT_SIGNATURE_FILENAME);
  });

  it("repacks a signed tarball that carries the signature beside the manifest", async () => {
    const built = await builtArtifact();
    const ringKey = keyPair();
    const out = join(temporaryRoot("octant-headless-signed-"), "signed.tar.gz");
    const result = await signHeadlessArtifactTarball({
      tarball: built.tarPath,
      out,
      ring: "candidate",
      privateKeyBase64: ringKey.privateKeyBase64,
      trustedKeys: previewTrust(ringKey.publicKeyBase64),
    });
    expect(result).toEqual({ status: "signed", version: "1.2.3" });
    const { stdout } = await execFileAsync("tar", ["-tzf", out]);
    expect(stdout.split("\n")).toContain(
      `octant-1.2.3-linux-arm64/${HEADLESS_ARTIFACT_SIGNATURE_FILENAME}`,
    );
  });
});
