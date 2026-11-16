import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const ScopeIdentity = Schema.Struct({
  pid: Schema.Int,
  resource: Schema.String,
  jetsam: Schema.String,
  session: Schema.Int,
});
const decodeIdentity = Schema.decodeUnknownSync(ScopeIdentity);
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

describe.skipIf(process.platform !== "darwin")("native sandbox process ownership", () => {
  it("retains an isolated kernel scope after a child starts a new session and its parent exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "octant-scope-"));
    const executable = join(root, "scope");
    const label = `app.octant.sandbox.${root.split("/").at(-1)}`;
    const domain = `user/${process.getuid?.()}`;
    const service = `${domain}/${label}`;
    const output = join(root, "output");
    const plist = join(root, "scope.plist");
    let child: ReturnType<typeof decodeIdentity> | undefined;
    let registered = false;
    try {
      execFileSync(
        "/usr/bin/xcrun",
        [
          "clang",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-o",
          executable,
          fileURLToPath(new URL("./fixtures/macosCoalitionScope.c", import.meta.url)),
        ],
        { timeout: 15000 },
      );
      writeFileSync(
        plist,
        `<?xml version="1.0"?><plist version="1.0"><dict>
        <key>Label</key><string>${label}</string>
        <key>ProgramArguments</key><array><string>${xml(executable)}</string><string>spawn</string><string>${xml(join(root, "beat"))}</string></array>
        <key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
        <key>StandardOutPath</key><string>${xml(output)}</string>
        <key>StandardErrorPath</key><string>${xml(join(root, "errors"))}</string>
        </dict></plist>`,
        { mode: 0o600 },
      );
      execFileSync("/bin/launchctl", ["bootstrap", domain, plist], { timeout: 5000 });
      registered = true;
      let records: ReadonlyArray<ReturnType<typeof decodeIdentity>> = [];
      await expect
        .poll(
          () => {
            try {
              records = readFileSync(output, "utf8")
                .trim()
                .split("\n")
                .map((line) => decodeIdentity(JSON.parse(line)));
            } catch {
              return false;
            }
            return records.length === 2;
          },
          { timeout: 8000 },
        )
        .toBe(true);
      const parent = records[0];
      child = records[1];
      if (parent === undefined || child === undefined)
        throw new Error("Missing native scope identities");
      const host = decodeIdentity(
        JSON.parse(
          execFileSync(executable, ["inspect", String(process.pid)], { encoding: "utf8" }),
        ),
      );
      expect(parent.resource).not.toBe("0");
      expect(parent.resource).not.toBe(host.resource);
      expect(child.resource).toBe(parent.resource);
      expect(child.session).toBe(child.pid);
      const before = readFileSync(join(root, "beat"), "utf8");
      await expect.poll(() => readFileSync(join(root, "beat"), "utf8")).not.toBe(before);
      const orphan = decodeIdentity(
        JSON.parse(execFileSync(executable, ["inspect", String(child.pid)], { encoding: "utf8" })),
      );
      expect(orphan.resource).toBe(parent.resource);
    } finally {
      if (child !== undefined) {
        try {
          const current = decodeIdentity(
            JSON.parse(
              execFileSync(executable, ["inspect", String(child.pid)], { encoding: "utf8" }),
            ),
          );
          if (current.resource === child.resource) process.kill(child.pid, "SIGKILL");
        } catch {
          /* The bounded native fixture may already have exited. */
        }
      }
      if (registered) execFileSync("/bin/launchctl", ["bootout", service], { timeout: 5000 });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
