// What the host seals is opened here by the phone's own source: the Swift the
// notification service extension runs, built for this Mac with swiftc (only
// where swiftc exists), and the Kotlin the Android receiver runs, built for a
// desktop JVM with kotlinc (only where kotlinc and java exist). Each reads
// the host's real sealed envelope, so a difference between the host's HPKE and
// a phone's, or between the two phones' display rules, shows up here and not on
// a device. The host's sealer and the test opener in Node are checked against
// the published RFC 9180 vector in `pushNotificationSealing.test.ts`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealPushNotification } from "./pushNotificationSealing";

const PHONE_MODULE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../mobile/modules/octant-push",
);
const ANDROID_SOURCES = join(PHONE_MODULE, "android/src/main/java/sh/octant/push");

const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const threadId = "00000000-0000-4000-8000-000000000001";
const collapseKey = Buffer.alloc(32, 7).toString("base64url");

interface Opened {
  readonly status: "opened" | "placeholder";
  readonly title?: string;
  readonly body?: string;
  readonly deepLink?: string;
}

interface PhoneKeys {
  readonly privateKey: string;
  readonly publicKey: string;
}

function newPhoneKeys(): PhoneKeys {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: String(pair.privateKey.export({ format: "jwk" }).d),
    publicKey: String(pair.publicKey.export({ format: "jwk" }).x),
  };
}

const goodContent = {
  kind: "approval-needed",
  hostId,
  threadId,
  mode: "code",
  title: "Approval needed: Acme rollback",
  body: "On Studio Mac",
};

function seal(input: {
  readonly keys: PhoneKeys;
  readonly content?: unknown;
  readonly deviceId?: string;
  readonly hostId?: string;
}) {
  const sealed = sealPushNotification({
    hostId: input.hostId ?? hostId,
    deviceId: input.deviceId ?? deviceId,
    notificationPublicKey: input.keys.publicKey,
    collapseKey,
    threadId,
    kind: "approval-needed",
    content: input.content ?? goodContent,
  });
  if (sealed.status !== "sealed") throw new Error(`Sealing was refused: ${sealed.reason}`);
  return sealed.envelope.sealed;
}

interface OpenerInput {
  readonly version?: string;
  readonly keys: PhoneKeys;
  readonly hostId?: string;
  readonly deviceId?: string;
  readonly encapsulatedKey: string;
  readonly ciphertext: string;
}

type Opener = (input: OpenerInput) => Opened;

function swiftOpener(binary: string): Opener {
  return (input) => {
    const run = spawnSync(binary, [], {
      input: JSON.stringify({
        version: Number(input.version ?? "1"),
        hostId: input.hostId ?? hostId,
        deviceId: input.deviceId ?? deviceId,
        privateKey: input.keys.privateKey,
        encapsulatedKey: input.encapsulatedKey,
        ciphertext: input.ciphertext,
      }),
      encoding: "utf8",
    });
    if (run.status !== 0) throw new Error(`The iOS opener failed: ${run.stderr}`);
    return JSON.parse(run.stdout) as Opened;
  };
}

function kotlinOpener(jar: string): Opener {
  return (input) => {
    const run = spawnSync(
      "java",
      [
        "-jar",
        jar,
        input.version ?? "1",
        input.hostId ?? hostId,
        input.deviceId ?? deviceId,
        input.keys.privateKey,
        input.encapsulatedKey,
        input.ciphertext,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`The Android opener failed: ${run.stderr}`);
    return JSON.parse(run.stdout) as Opened;
  };
}

function hasSwiftc(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `kotlinc` and `java` on the path, as on a Linux CI runner or a Mac with both installed. */
function hasKotlinc(): boolean {
  try {
    execFileSync("kotlinc", ["-version"], { stdio: "ignore", timeout: 60_000 });
    execFileSync("java", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const swiftcFound = hasSwiftc();
const kotlincFound = hasKotlinc();
/**
 * Set where the Android opener must run, as the CI server job sets it. The
 * Ubuntu runner image ships `kotlinc` and `java`, but nothing else would notice
 * an image without them: the Android opener would skip and the run would still
 * pass, leaving the phone's Kotlin source untested.
 */
const kotlincRequired = process.env.OCTANT_REQUIRE_KOTLINC === "1";
const nativeBuild = mkdtempSync(join(tmpdir(), "octant-push-opener-"));
let swiftBinary: string | undefined;
let kotlinJar: string | undefined;

beforeAll(() => {
  if (swiftcFound) {
    const binary = join(nativeBuild, "push-opener");
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-o",
        binary,
        join(PHONE_MODULE, "ios/SealedNotification.swift"),
        join(PHONE_MODULE, "test/ios/main.swift"),
      ],
      { stdio: "inherit", timeout: 240_000 },
    );
    if (existsSync(binary)) swiftBinary = binary;
  }
  if (kotlincFound) {
    const jar = join(nativeBuild, "push-opener.jar");
    execFileSync(
      "kotlinc",
      [
        join(ANDROID_SOURCES, "X25519.kt"),
        join(ANDROID_SOURCES, "Hpke.kt"),
        join(ANDROID_SOURCES, "SealedNotification.kt"),
        join(PHONE_MODULE, "test/android/Main.kt"),
        "-include-runtime",
        "-d",
        jar,
      ],
      { stdio: "inherit", timeout: 240_000 },
    );
    if (existsSync(jar)) kotlinJar = jar;
  }
}, 480_000);

afterAll(() => {
  rmSync(nativeBuild, { recursive: true, force: true });
});

const phones: ReadonlyArray<{
  readonly name: string;
  readonly opener: () => Opener;
  readonly runs: boolean;
}> = [
  {
    name: "the iPhone's notification service extension",
    opener: () => {
      if (swiftBinary === undefined) throw new Error("The iOS opener was not built.");
      return swiftOpener(swiftBinary);
    },
    runs: swiftcFound,
  },
  {
    name: "the Android receiver",
    opener: () => {
      if (!kotlincFound) {
        throw new Error(
          "OCTANT_REQUIRE_KOTLINC is set, but kotlinc or java did not answer, so the Android opener cannot run.",
        );
      }
      if (kotlinJar === undefined) throw new Error("The Android opener was not built.");
      return kotlinOpener(kotlinJar);
    },
    runs: kotlincFound || kotlincRequired,
  },
];

describe.each(phones)("opening a sealed notification in $name", ({ opener, runs }) => {
  it.skipIf(!runs)("shows the host's text and links to the thread it names", () => {
    const keys = newPhoneKeys();
    const sealed = seal({ keys });
    expect(opener()({ keys, ...sealed })).toEqual({
      status: "opened",
      title: "Approval needed: Acme rollback",
      body: "On Studio Mac",
      deepLink: `octant://hosts/${hostId}/threads/code/${threadId}`,
    });
  });

  it.skipIf(!runs)("links without a mode when the host names none", () => {
    const keys = newPhoneKeys();
    const { mode: _mode, ...withoutMode } = goodContent;
    const sealed = seal({ keys, content: withoutMode });
    expect(opener()({ keys, ...sealed }).deepLink).toBe(
      `octant://hosts/${hostId}/threads/${threadId}`,
    );
  });

  it.skipIf(!runs)(
    "removes control and text-reordering characters, and keeps quotes and non-Latin text",
    () => {
      const keys = newPhoneKeys();
      const sealed = seal({
        keys,
        content: {
          ...goodContent,
          title: '‮Approval\u0007 "needed"⁦ æøå',
          body: "Line one\nLine two end\u0000",
        },
      });
      const opened = opener()({ keys, ...sealed });
      expect(opened.title).toBe('Approval "needed" æøå');
      expect(opened.body).toBe("Line oneLine twoend");
    },
  );

  it.skipIf(!runs)(
    "leaves the placeholder when the key, host, or device it was sealed for differs",
    () => {
      const keys = newPhoneKeys();
      const sealed = seal({ keys });
      const open = opener();
      expect(open({ keys: newPhoneKeys(), ...sealed }).status).toBe("placeholder");
      expect(
        open({ keys, deviceId: "33333333-3333-4333-8333-333333333333", ...sealed }).status,
      ).toBe("placeholder");
      expect(open({ keys, hostId: "44444444-4444-4444-8444-444444444444", ...sealed }).status).toBe(
        "placeholder",
      );
    },
  );

  it.skipIf(!runs)(
    "leaves the placeholder for tampered, truncated, or wrongly versioned bytes",
    () => {
      const keys = newPhoneKeys();
      const sealed = seal({ keys });
      const open = opener();
      const flipped = Buffer.from(sealed.ciphertext, "base64url");
      flipped[10] = (flipped[10] ?? 0) ^ 0x01;
      expect(open({ keys, ...sealed, ciphertext: flipped.toString("base64url") }).status).toBe(
        "placeholder",
      );
      expect(open({ keys, ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) }).status).toBe(
        "placeholder",
      );
      expect(open({ keys, ...sealed, encapsulatedKey: "A".repeat(43) }).status).toBe("placeholder");
      expect(open({ keys, ...sealed, encapsulatedKey: "not a key" }).status).toBe("placeholder");
      expect(open({ keys, version: "2", ...sealed }).status).toBe("placeholder");
    },
  );

  it.skipIf(!runs)(
    "leaves the placeholder when the content breaks the phone's own rules, even though it opened",
    () => {
      const keys = newPhoneKeys();
      const open = opener();
      const broken: ReadonlyArray<Record<string, unknown>> = [
        { kind: "secret" },
        { hostId: "55555555-5555-4555-8555-555555555555" },
        { threadId: "../../hosts/other/threads/x" },
        { threadId: "thread?next=1" },
        { threadId: "t".repeat(65) },
        { mode: "admin" },
        { title: "" },
        { title: "‮\u0007" },
        { title: "t".repeat(81) },
        { body: "b".repeat(121) },
        { title: 5 },
        { threadId: undefined },
      ];
      for (const change of broken) {
        const sealed = seal({ keys, content: { ...goodContent, ...change } });
        expect(open({ keys, ...sealed }).status, JSON.stringify(change)).toBe("placeholder");
      }
    },
  );

  it.skipIf(!runs)("holds the title and body to the host's bounds in bytes, not characters", () => {
    const keys = newPhoneKeys();
    const open = opener();
    // 40 two-byte characters are exactly 80 bytes; 41 are 82.
    const atBound = seal({ keys, content: { ...goodContent, title: "æ".repeat(40) } });
    expect(open({ keys, ...atBound }).status).toBe("opened");
    const overBound = seal({ keys, content: { ...goodContent, title: "æ".repeat(41) } });
    expect(open({ keys, ...overBound }).status).toBe("placeholder");
  });
});
