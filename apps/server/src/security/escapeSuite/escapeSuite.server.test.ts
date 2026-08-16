import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoPrincipalIdentityInPayload } from "../../clientPrincipal";
import {
  ESCAPE_SUITE_FIXTURES_ROOT,
  evaluateEscapeSuiteRow,
  listEscapeSuiteFixtures,
  loadEscapeSuiteCases,
} from "./evaluateEscapeSuite";

describe("escape suite server integration (layer 2)", () => {
  it("ships inert fixtures for every abuse-case row", () => {
    for (const fixture of listEscapeSuiteFixtures()) {
      const cases = loadEscapeSuiteCases(fixture);
      expect(cases.fixture).toBe(fixture);
      expect(cases.rows.length).toBeGreaterThan(0);
      expect(existsSync(join(ESCAPE_SUITE_FIXTURES_ROOT, fixture, "cases.json"))).toBe(true);
    }
    expect(
      readFileSync(join(ESCAPE_SUITE_FIXTURES_ROOT, "injected-readme", "README.md"), "utf8"),
    ).toMatch(/approval-granted|curl/);
    expect(
      JSON.parse(
        readFileSync(join(ESCAPE_SUITE_FIXTURES_ROOT, "rogue-mcp-server", "manifest.json"), "utf8"),
      ).declaredCapabilities,
    ).toEqual(["mcp", "instructions"]);
  });

  it.each(listEscapeSuiteFixtures().flatMap((fixture) => loadEscapeSuiteCases(fixture).rows))(
    "denies $id with correlated audit and zero side effects",
    (row) => {
      const result = evaluateEscapeSuiteRow(row);
      expect(result.denied).toBe(true);
      expect(result.denialReason).toBe(row.expectedDenial);
      expect(result.sideEffects).toEqual([]);
      expect(result.auditEvent.eventName).toBe(row.auditEvent);
      expect(result.auditEvent.body.eventName).toBe(row.auditEvent);
      const payload = result.auditEvent.body.payload as {
        readonly denialReason?: string;
        readonly actingPrincipal: { readonly kind: string };
      };
      expect(payload.denialReason).toBe(row.expectedDenial);
      expect(["local-window", "remote-device"]).toContain(payload.actingPrincipal.kind);
    },
  );

  it("keeps principal identity server-resolved for audit write paths", () => {
    expect(() =>
      assertNoPrincipalIdentityInPayload(new Request("https://octant.local/api/audit?deviceId=1")),
    ).toThrow(/principal identity/);
    expect(() =>
      assertNoPrincipalIdentityInPayload(new Request("https://octant.local/api/audit"), {
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }),
    ).toThrow(/principal identity/);
  });

  it("documents layer 3 macOS probes as out-of-band native evidence", () => {
    const readme = readFileSync(join(ESCAPE_SUITE_FIXTURES_ROOT, "..", "README.md"), "utf8");
    expect(readme).toMatch(/Out-of-band \/ native evidence/);
    expect(readme).toMatch(/toolCallPolicy/);
  });
});
