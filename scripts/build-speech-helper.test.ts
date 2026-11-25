import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSpeechHelper,
  findSpeechToolchain,
  shouldBuildSpeechHelper,
  speechHelperBuildArgs,
  speechToolchainCandidates,
} from "./build-speech-helper";

const repositoryRoot = resolve(import.meta.dirname, "..");
let fixtureRoot = "";
let helperPath = "";
let runnable = false;

beforeAll(async () => {
  if (!shouldBuildSpeechHelper()) return;
  fixtureRoot = await mkdtemp(join(tmpdir(), "octant-speech-helper-test-"));
  helperPath = join(fixtureRoot, "octant-speech-helper");
  const built = await buildSpeechHelper(undefined, helperPath);
  // Darwin 25 is macOS 26, the first system that can start the helper.
  runnable = built === "built" && Number(release().split(".")[0]) >= 25;
}, 120_000);

afterAll(async () => {
  if (fixtureRoot !== "") await rm(fixtureRoot, { recursive: true, force: true });
});

function exchange(
  bytes: Uint8Array,
  options: { readonly hold: boolean },
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((settle) => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on("error", () => undefined);
    child.on("exit", (code) => settle({ code, stdout, stderr }));
    if (options.hold) child.stdin.write(bytes);
    else child.stdin.end(bytes);
  });
}

function frame(value: Record<string, unknown>, audio = Buffer.alloc(0)): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload, audio]);
}

describe("speech helper build", () => {
  it("skips the helper off macOS so Linux and Windows builds do not require swiftc", () => {
    expect(shouldBuildSpeechHelper("darwin")).toBe(true);
    expect(shouldBuildSpeechHelper("linux")).toBe(false);
    expect(shouldBuildSpeechHelper("win32")).toBe(false);
  });

  it("pins an Apple Silicon macOS 26 executable whatever the builder runs", () => {
    expect(speechHelperBuildArgs("/repo/helper.swift", "/repo/dist/helper")).toEqual([
      "--sdk",
      "macosx",
      "swiftc",
      "-parse-as-library",
      "-swift-version",
      "5",
      "-O",
      "-target",
      "arm64-apple-macos26.0",
      "-o",
      "/repo/dist/helper",
      "/repo/helper.swift",
    ]);
  });

  it("keeps the selected Xcode when it already has the macOS 26 SDK", async () => {
    expect(
      await findSpeechToolchain({
        listApplications: async () => ["Xcode_26.3.app"],
        sdkVersion: async (directory) => (directory === undefined ? "27.2" : "26.2"),
      }),
    ).toEqual({ kind: "selected" });
  });

  it("finds the newest released Xcode with the SDK when an older one is selected", async () => {
    const asked: Array<string | undefined> = [];
    expect(
      await findSpeechToolchain({
        listApplications: async () => [
          "Xcode.app",
          "Xcode_16.4.app",
          "Xcode_26.0.1.app",
          "Xcode_26.3.app",
          "Xcode_27.0_beta.app",
          "Safari.app",
        ],
        sdkVersion: async (directory) => {
          asked.push(directory);
          return directory === undefined ? "15.5" : "26.2";
        },
      }),
    ).toEqual({
      kind: "installed",
      developerDirectory: "/Applications/Xcode_26.3.app/Contents/Developer",
    });
    expect(asked).toEqual([undefined, "/Applications/Xcode_26.3.app/Contents/Developer"]);
  });

  it("reports no toolchain rather than building against an SDK without the API", async () => {
    expect(
      await findSpeechToolchain({
        listApplications: async () => ["Xcode_16.4.app"],
        sdkVersion: async () => "15.5",
      }),
    ).toEqual({ kind: "absent" });
    expect(speechToolchainCandidates(["Xcode_27.0_Release_Candidate.app"])).toEqual([]);
  });

  it("never names the recognizer that may use Apple's servers, and writes no file or log", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "apps/desktop/native/speech-helper/OctantSpeechHelper.swift"),
      "utf8",
    );
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/SFSpeech|requestAuthorization|AVCapture|AVAudioEngine|URLSession/);
    expect(code).not.toMatch(
      /standardError|STDERR|NSLog|os_log|Logger|print\(|localizedDescription/,
    );
    expect(code).not.toMatch(/FileManager|write\(to|AVAudioFile|CommandLine|environment/);
  });
});

describe("speech helper process", () => {
  it("answers a malformed request with a code and nothing on stderr", async (context) => {
    if (!runnable) return context.skip();
    expect((await stat(helperPath)).mode & 0o111).toBe(0o111);
    for (const bytes of [
      frame({ protocolVersion: 1, operation: "listen" }),
      frame({ protocolVersion: 2, operation: "status" }),
      frame({ protocolVersion: 1, operation: "transcribe", audioBytes: 3 }),
      frame({ protocolVersion: 1, operation: "transcribe", audioBytes: 50_000_000 }),
    ]) {
      const { stdout, stderr } = await exchange(bytes, { hold: true });
      expect(JSON.parse(stdout)).toEqual({ event: "refused", code: "malformed" });
      expect(stderr).toBe("");
    }
  });

  it("refuses a language Apple has no on-device model for", async (context) => {
    if (!runnable) return context.skip();
    const { stdout } = await exchange(
      frame({ protocolVersion: 1, operation: "status", language: "xx" }),
      { hold: true },
    );
    expect(JSON.parse(stdout)).toEqual({ event: "refused", code: "unsupported-language" });
  });

  it("exits without an answer when the host leaves before the clip is transcribed", async (context) => {
    if (!runnable) return context.skip();
    const { stdout, stderr } = await exchange(
      frame(
        { protocolVersion: 1, operation: "transcribe", audioBytes: 64_000 },
        Buffer.alloc(16_000),
      ),
      { hold: false },
    );
    expect(stdout === "" || JSON.parse(stdout).code === "malformed").toBe(true);
    expect(stderr).toBe("");
  });
});
