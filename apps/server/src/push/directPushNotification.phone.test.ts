// Exercises the phone's real Swift (macOS) and Kotlin (JVM) DirectNotification
// parsers against v2 payloads produced by the host's branded builder, proving
// both platforms validate v2 metadata, strip control/bidi characters, build
// deep links, and hide/reject alerts from forgotten computers or old versions.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { decodeStableHostId, type UtcTimestamp } from "@octant/contracts";
import { buildPushAlert } from "@octant/domain/push-notification-policy";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const pushModuleRoot = join(repoRoot, "apps", "mobile", "modules", "octant-push");

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const threadId = "00000000-0000-4000-8000-000000000001";
const collapseId = "q2HnS1wZcV0k3fA8uYt7Rg";
const occurredAt = "2026-11-28T12:00:00.000Z" as UtcTimestamp;

const scratch = mkdtempSync(join(tmpdir(), "octant-direct-push-phone-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function hasTool(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRunSwift = process.platform === "darwin" && hasTool("swiftc");
const canRunKotlin = hasTool("kotlinc") && hasTool("java");
const requireKotlin = process.env.OCTANT_REQUIRE_KOTLINC === "1";

describe("phone native direct v2 push parsers", () => {
  it.skipIf(!canRunSwift)(
    "parses host v2 alerts and hides forgotten hosts in the iOS Swift parser",
    () => {
      const binary = join(scratch, "direct-push-swift");
      execFileSync(
        "swiftc",
        [
          join(pushModuleRoot, "ios", "DirectNotification.swift"),
          join(pushModuleRoot, "test", "ios", "main.swift"),
          "-o",
          binary,
        ],
        { stdio: "pipe" },
      );
      const run = (input: unknown) =>
        JSON.parse(
          execFileSync(binary, [], {
            input: JSON.stringify(input),
            encoding: "utf8",
          }).trim(),
        ) as Record<string, string>;

      const message = buildPushAlert({
        source: "thread",
        kind: "approval-needed",
        hostId,
        threadId,
        mode: "code",
        computerLabel: "Studio Mac",
        threadTitle: "Ship release",
        threadTitles: true,
        collapseId,
        sequence: 1,
        occurredAt,
        heldSecrets: { status: "ready", values: [] },
      });
      if (message.type !== "alert") throw new Error("expected alert");
      const { alert } = message;

      expect(
        run({
          octant: {
            v: 2,
            kind: alert.kind,
            hostId: alert.hostId,
            threadId: alert.threadId,
            mode: alert.mode,
          },
          title: alert.title,
          body: alert.body,
        }),
      ).toEqual({
        status: "parsed",
        hostId,
        kind: "approval-needed",
        title: "Approval needed: Ship release",
        body: "On Studio Mac",
        deepLink: `octant://hosts/${hostId}/threads/code/${threadId}`,
      });

      // Forgotten host is hidden behind generic placeholder.
      expect(
        run({
          octant: {
            v: 2,
            kind: alert.kind,
            hostId: alert.hostId,
            threadId: alert.threadId,
            mode: alert.mode,
          },
          title: alert.title,
          body: alert.body,
          forgottenHosts: [hostId],
        }),
      ).toEqual({ status: "placeholder" });

      // Legacy v1 payload falls back to placeholder.
      expect(
        run({
          octant: { v: 1, ek: "x", ct: "y" },
          title: "Octant",
          body: "A paired computer has an update",
        }),
      ).toEqual({ status: "placeholder" });

      // Device-joined and move-waiting deep links.
      expect(
        run({
          octant: { v: 2, kind: "device-joined", hostId },
          title: "New device: Phone",
          body: "Paired with Studio Mac",
        }),
      ).toMatchObject({ status: "parsed", deepLink: `octant://hosts/${hostId}/new-devices` });
      expect(
        run({
          octant: { v: 2, kind: "move-waiting", hostId },
          title: "A move is waiting for your phone",
          body: "To Studio Mac",
        }),
      ).toMatchObject({ status: "parsed", deepLink: `octant://hosts/${hostId}/moves` });
    },
  );

  it.skipIf(!canRunKotlin && !requireKotlin)(
    "parses host v2 alerts and drops forgotten hosts in the Android Kotlin parser",
    () => {
      const jar = join(scratch, "direct-push-kotlin.jar");
      execFileSync(
        "kotlinc",
        [
          join(
            pushModuleRoot,
            "android",
            "src",
            "main",
            "java",
            "sh",
            "octant",
            "push",
            "DirectNotification.kt",
          ),
          join(pushModuleRoot, "test", "android", "Main.kt"),
          "-include-runtime",
          "-d",
          jar,
        ],
        { stdio: "pipe" },
      );
      const run = (args: ReadonlyArray<string>) =>
        JSON.parse(
          execFileSync("java", ["-jar", jar, ...args], { encoding: "utf8" }).trim(),
        ) as Record<string, string>;

      expect(
        run([
          "v=2",
          "kind=waiting",
          `hostId=${hostId}`,
          `threadId=${threadId}`,
          "mode=work",
          "title=Waiting for you",
          "body=On Studio Mac",
        ]),
      ).toEqual({
        status: "parsed",
        hostId,
        kind: "waiting",
        title: "Waiting for you",
        body: "On Studio Mac",
        deepLink: `octant://hosts/${hostId}/threads/work/${threadId}`,
      });

      expect(
        run([
          "v=2",
          "kind=waiting",
          `hostId=${hostId}`,
          `threadId=${threadId}`,
          "mode=work",
          "title=Waiting for you",
          "body=On Studio Mac",
          `__forgotten=${hostId}`,
        ]),
      ).toEqual({ status: "placeholder" });

      expect(run(["v=1", "ek=abc", "ct=def"])).toEqual({ status: "placeholder" });
    },
  );
});
