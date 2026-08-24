const FORBIDDEN_AUDIT_IDENTITY_KEYS = [
  "windowId",
  "deviceId",
  "sessionId",
  "hostId",
  "capability",
] as const;

/** Reject caller-supplied identity fields before the server resolves them. */
export function assertNoPrincipalIdentityInAuditInput(input: unknown): void {
  if (!isRecord(input)) return;
  for (const key of FORBIDDEN_AUDIT_IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new AuditPrincipalIdentityRejected(
        `Audit inputs cannot supply principal identity field "${key}".`,
      );
    }
  }
}

export class AuditPrincipalIdentityRejected extends Error {
  override readonly name = "AuditPrincipalIdentityRejected";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Structural redaction gate for audit payloads after schema decode. Rejects
 * values that look like secrets, absolute private paths, or raw tool dumps
 * even if they passed a looser contract string field.
 */
export function assertAuditPayloadRedacted(value: unknown, path = "payload"): void {
  if (typeof value === "string") {
    if (value.includes("BEGIN ") && /PRIVATE KEY|CERTIFICATE/i.test(value)) {
      throw new AuditRedactionRejected(`${path} contains key material.`);
    }
    if (/\/(?:Users|home|private|var\/folders)\//i.test(value) || /^[A-Za-z]:\\/.test(value)) {
      throw new AuditRedactionRejected(`${path} contains an absolute private path.`);
    }
    if (value.length > 4_096) {
      throw new AuditRedactionRejected(`${path} exceeds redacted audit length bound.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAuditPayloadRedacted(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "rawToolOutput" || key === "secret" || key === "password" || key === "token") {
        throw new AuditRedactionRejected(`${path}.${key} is forbidden in audit payloads.`);
      }
      assertAuditPayloadRedacted(entry, `${path}.${key}`);
    }
  }
}

export class AuditRedactionRejected extends Error {
  override readonly name = "AuditRedactionRejected";

  constructor(message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
