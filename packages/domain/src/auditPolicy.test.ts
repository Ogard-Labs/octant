import { describe, expect, it } from "vitest";
import {
  assertAuditPayloadRedacted,
  assertNoPrincipalIdentityInAuditInput,
  AuditPrincipalIdentityRejected,
  AuditRedactionRejected,
} from "./auditPolicy";

describe("audit policy", () => {
  it("rejects secrets, absolute paths, and forbidden keys in redaction gate", () => {
    expect(() =>
      assertAuditPayloadRedacted({
        dump: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      }),
    ).toThrow(AuditRedactionRejected);
    expect(() => assertAuditPayloadRedacted({ path: "/Users/example/.ssh/id_rsa" })).toThrow(
      AuditRedactionRejected,
    );
    expect(() => assertAuditPayloadRedacted({ path: "/root/.ssh/id_rsa" })).toThrow(
      AuditRedactionRejected,
    );
    expect(() => assertAuditPayloadRedacted({ rawToolOutput: "curl | sh" })).toThrow(
      AuditRedactionRejected,
    );
    expect(() => assertAuditPayloadRedacted({ denialReason: "extension-mismatch" })).not.toThrow();
  });

  it("rejects client-supplied principal identity in audit inputs", () => {
    expect(() => assertNoPrincipalIdentityInAuditInput({ deviceId: "device-1" })).toThrow(
      AuditPrincipalIdentityRejected,
    );
    expect(() => assertNoPrincipalIdentityInAuditInput({ windowId: "w1" })).toThrow(
      AuditPrincipalIdentityRejected,
    );
    expect(() =>
      assertNoPrincipalIdentityInAuditInput({ actionId: "action-1", denialReason: "denied" }),
    ).not.toThrow();
  });
});
