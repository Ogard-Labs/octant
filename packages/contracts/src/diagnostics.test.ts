import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_PACKET_VERSION,
  DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS,
  DIAGNOSTICS_PACKET_VERSION_WITH_JOURNAL_GROWTH,
  decodeDiagnosticEvidencePacket,
  decodeDiagnosticFailureCode,
  decodeDiagnosticFailureDomain,
  decodeDiagnosticRedactionTag,
  decodeDiagnosticSafeText,
  decodeDiagnosticsExportContentDigest,
  decodeDiagnosticsExportFailure,
  decodeDiagnosticsExportOutcome,
  decodeDiagnosticsExportReceipt,
  decodeDiagnosticsExportRequest,
  decodeJournalGrowth,
} from "./diagnostics";

const baseCorrelationId = "00000000-0000-4000-8000-000000000001";
const basePacketId = "00000000-0000-4000-8000-0000000000aa";

const validPacket = {
  packetVersion: DIAGNOSTICS_PACKET_VERSION,
  packetId: basePacketId,
  domain: "provider",
  failureCode: "provider-handshake-timeout",
  summary: "Provider handshake exceeded the negotiated deadline.",
  hostVersions: [{ component: "@octant/server", version: "1.4.2" }],
  candidateVersions: [{ component: "@octant/server", version: "1.5.0-rc.1" }],
  correlations: [{ correlationId: baseCorrelationId, observedAt: "2026-08-03T12:00:00.000Z" }],
  recovery: [{ action: "Retry after confirming provider reachability.", automated: false }],
  redactions: ["credential"],
  redacted: true,
  generatedAt: "2026-08-03T12:00:01.000Z",
} as const;

describe("DiagnosticFailureDomain", () => {
  it("accepts every supported domain", () => {
    for (const domain of [
      "provider",
      "storage",
      "network",
      "remote-auth",
      "migration",
      "confinement",
      "process-cleanup",
    ] as const) {
      expect(decodeDiagnosticFailureDomain(domain)).toBe(domain);
    }
  });

  it("rejects an unmodeled domain", () => {
    expect(() => decodeDiagnosticFailureDomain("telemetry")).toThrow();
  });
});

describe("DiagnosticFailureCode", () => {
  it("accepts a bounded provider-neutral token", () => {
    expect(decodeDiagnosticFailureCode("storage-write-denied")).toBe("storage-write-denied");
  });

  it("rejects free text with spaces or uppercase", () => {
    expect(() => decodeDiagnosticFailureCode("Storage write denied")).toThrow();
  });
});

describe("DiagnosticRedactionTag", () => {
  it("accepts every redaction class", () => {
    for (const tag of [
      "credential",
      "private-key",
      "pairing-material",
      "session-material",
      "sensitive-root",
      "private-content",
      "raw-store",
    ] as const) {
      expect(decodeDiagnosticRedactionTag(tag)).toBe(tag);
    }
  });
});

describe("DiagnosticSafeText", () => {
  it("accepts already-redacted text with placeholders", () => {
    const text = "Connection refused after presenting [redacted:credential].";
    expect(decodeDiagnosticSafeText(text)).toBe(text);
  });

  it("rejects a raw private key block", () => {
    expect(() =>
      decodeDiagnosticSafeText("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END"),
    ).toThrow();
  });

  it("rejects a credentialed URL", () => {
    expect(() =>
      decodeDiagnosticSafeText("Failed to reach https://user:s3cr3t@example.com/session"),
    ).toThrow();
  });

  it("rejects an sk- style token", () => {
    expect(() =>
      decodeDiagnosticSafeText("Provider rejected key sk-abcdefghijklmnop123456"),
    ).toThrow();
  });

  it("rejects a multipart sk-proj- provider key", () => {
    expect(() =>
      decodeDiagnosticSafeText("Provider rejected key sk-proj-abcdefghijklmnop"),
    ).toThrow();
  });

  it("rejects a Linear personal API key", () => {
    expect(() =>
      decodeDiagnosticSafeText("Rejected lin_api_abcdefghijklmnop1234 for the workspace"),
    ).toThrow();
  });

  it.each([
    "Provider rejected ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890.",
    "Remote credential AKIAABCDEFGHIJKLMNOP was rejected.",
    "Provider returned eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature-data.",
    `Gemini rejected key AIza${"a".repeat(35)}.`,
  ])("rejects bearerless opaque credentials: %s", (value) => {
    expect(() => decodeDiagnosticSafeText(value)).toThrow();
  });

  it("rejects a short natural-language password assignment", () => {
    expect(() => decodeDiagnosticSafeText("My password is 1234 while signing in.")).toThrow();
  });

  it.each(["The pairing code is 8F3K-2Q9Z expired.", "The pairing ticket is ticket-1234 expired."])(
    "rejects natural-language pairing material: %s",
    (value) => {
      expect(() => decodeDiagnosticSafeText(value)).toThrow();
    },
  );

  it("rejects an absolute home root", () => {
    expect(() => decodeDiagnosticSafeText("Denied writing to /Users/alex/secret")).toThrow();
  });

  it("rejects multi-line content that is not a single safe phrase", () => {
    expect(() => decodeDiagnosticSafeText("Line one\nLine two of a private thread")).toThrow();
  });

  it("rejects structured JSON/log content with disallowed characters", () => {
    expect(() =>
      decodeDiagnosticSafeText('{"thread":"private excerpt","body":"secret plans"}'),
    ).toThrow();
  });

  it("rejects non-ASCII private prose that matches no secret pattern", () => {
    expect(() => decodeDiagnosticSafeText("私的なスレッドの内容")).toThrow();
  });

  it("rejects free text longer than the bounded safe length", () => {
    expect(() => decodeDiagnosticSafeText("a".repeat(600))).toThrow();
  });
});

describe("DiagnosticEvidencePacket", () => {
  it("decodes a complete redacted packet", () => {
    const packet = decodeDiagnosticEvidencePacket(validPacket);
    expect(packet.domain).toBe("provider");
    expect(packet.redacted).toBe(true);
    expect(packet.hostVersions).toHaveLength(1);
  });

  it("rejects a packet whose redacted flag is false", () => {
    expect(() => decodeDiagnosticEvidencePacket({ ...validPacket, redacted: false })).toThrow();
  });

  it("rejects a packet carrying an unredacted secret in its summary", () => {
    expect(() =>
      decodeDiagnosticEvidencePacket({
        ...validPacket,
        summary: "Bearer: abcdef123456 was rejected",
      }),
    ).toThrow();
  });

  it("rejects unknown excess properties (no raw store dump)", () => {
    expect(() =>
      decodeDiagnosticEvidencePacket({ ...validPacket, rawStore: { rows: [] } }),
    ).toThrow();
  });

  it("carries debug session counts and end reasons only in a version 3 packet", () => {
    const debugSessions = {
      since: "2026-07-21",
      started: 3,
      ended: [
        { endReason: "stopped", count: 2 },
        { endReason: "host-restarted", count: 1 },
      ],
    };
    const packet = decodeDiagnosticEvidencePacket({
      ...validPacket,
      packetVersion: DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS,
      debugSessions,
    });
    expect(packet.debugSessions).toEqual(debugSessions);
    // A version 2 reader refuses the field, so a packet with it says so.
    for (const packetVersion of [
      DIAGNOSTICS_PACKET_VERSION,
      DIAGNOSTICS_PACKET_VERSION_WITH_JOURNAL_GROWTH,
    ]) {
      expect(() =>
        decodeDiagnosticEvidencePacket({ ...validPacket, packetVersion, debugSessions }),
      ).toThrow();
    }
    expect(() =>
      decodeDiagnosticEvidencePacket({
        ...validPacket,
        packetVersion: DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS,
      }),
    ).toThrow();
    // Counts by closed reason only: no session, thread, or Project can ride along.
    for (const changed of [
      { ...debugSessions, ended: [{ endReason: "stopped", count: 1, threadId: "t" }] },
      { ...debugSessions, ended: [{ endReason: "the adapter said hello", count: 1 }] },
      {
        ...debugSessions,
        ended: [
          { endReason: "stopped", count: 1 },
          { endReason: "stopped", count: 1 },
        ],
      },
      { ...debugSessions, sessions: [] },
    ]) {
      expect(() =>
        decodeDiagnosticEvidencePacket({
          ...validPacket,
          packetVersion: DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS,
          debugSessions: changed,
        }),
      ).toThrow();
    }
  });

  it("rejects a packet with empty required evidence arrays", () => {
    for (const key of ["hostVersions", "candidateVersions", "correlations", "recovery"] as const) {
      expect(() => decodeDiagnosticEvidencePacket({ ...validPacket, [key]: [] })).toThrow();
    }
  });

  it("rejects a version fact carrying a credential as its identity", () => {
    expect(() =>
      decodeDiagnosticEvidencePacket({
        ...validPacket,
        hostVersions: [{ component: "sk-proj-abcdefghijklmnop", version: "1.0.0" }],
      }),
    ).toThrow();
  });

  it("rejects a version fact carrying a credential as its version", () => {
    expect(() =>
      decodeDiagnosticEvidencePacket({
        ...validPacket,
        candidateVersions: [{ component: "@octant/server", version: "sk-abcdefghijklmnop1234" }],
      }),
    ).toThrow();
  });
});

describe("DiagnosticsExportFailure", () => {
  it("decodes every closed failure category", () => {
    for (const category of [
      "invalid-input",
      "incomplete",
      "unredactable",
      "misleading-success",
      "unsupported-domain",
      "persistence-failed",
    ] as const) {
      const failure = decodeDiagnosticsExportFailure({ category, message: "reason" });
      expect(failure.category).toBe(category);
    }
  });
});

describe("DiagnosticsExportRequest", () => {
  it("accepts a domain and a bounded summary", () => {
    const request = decodeDiagnosticsExportRequest({
      correlationId: baseCorrelationId,
      domain: "provider",
      summary: "Chat provider stopped responding after the last turn.",
    });
    expect(request.domain).toBe("provider");
  });

  it("rejects an unsupported domain", () => {
    expect(() =>
      decodeDiagnosticsExportRequest({ domain: "not-a-domain", summary: "x" }),
    ).toThrow();
  });

  it("requires the reported failure correlation", () => {
    expect(() => decodeDiagnosticsExportRequest({ domain: "provider", summary: "x" })).toThrow();
  });

  it("rejects an empty summary", () => {
    expect(() => decodeDiagnosticsExportRequest({ domain: "provider", summary: "" })).toThrow();
  });

  it("rejects a summary over the bound", () => {
    expect(() =>
      decodeDiagnosticsExportRequest({ domain: "provider", summary: "a".repeat(2_001) }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeDiagnosticsExportRequest({
        correlationId: baseCorrelationId,
        domain: "provider",
        summary: "x",
        packetId: basePacketId,
      }),
    ).toThrow();
  });
});

describe("DiagnosticsExportContentDigest", () => {
  it("accepts a lowercase 64-character hex digest", () => {
    expect(decodeDiagnosticsExportContentDigest("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects an uppercase or short digest", () => {
    expect(() => decodeDiagnosticsExportContentDigest("A".repeat(64))).toThrow();
    expect(() => decodeDiagnosticsExportContentDigest("a".repeat(63))).toThrow();
  });
});

describe("DiagnosticsExportReceipt", () => {
  const validReceipt = {
    packetId: basePacketId,
    domain: "provider",
    failureCode: "provider-support-export",
    redactions: ["credential"],
    contentDigest: "a".repeat(64),
    generatedAt: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T12:00:01.000Z",
  } as const;

  it("decodes a bounded receipt", () => {
    const receipt = decodeDiagnosticsExportReceipt(validReceipt);
    expect(receipt.packetId).toBe(basePacketId);
  });

  it("cannot represent free text: summary, recovery, and version facts are not fields", () => {
    const receipt = decodeDiagnosticsExportReceipt(validReceipt);
    expect(Object.keys(receipt)).toEqual([
      "packetId",
      "domain",
      "failureCode",
      "redactions",
      "contentDigest",
      "generatedAt",
      "createdAt",
    ]);
  });

  it("rejects excess properties, including a summary field", () => {
    expect(() =>
      decodeDiagnosticsExportReceipt({ ...validReceipt, summary: "should never be here" }),
    ).toThrow();
  });
});

describe("DiagnosticsExportOutcome", () => {
  it("decodes an exported outcome carrying both a packet and a receipt", () => {
    const outcome = decodeDiagnosticsExportOutcome({
      kind: "exported",
      packet: validPacket,
      receipt: {
        packetId: basePacketId,
        domain: "provider",
        failureCode: "provider-support-export",
        redactions: ["credential"],
        contentDigest: "a".repeat(64),
        generatedAt: "2026-08-10T12:00:00.000Z",
        createdAt: "2026-08-10T12:00:01.000Z",
      },
    });
    expect(outcome.kind).toBe("exported");
  });

  it("decodes a failed outcome without a packet or receipt", () => {
    const outcome = decodeDiagnosticsExportOutcome({
      kind: "failed",
      failure: { category: "incomplete", message: "missing facts" },
    });
    expect(outcome.kind).toBe("failed");
  });

  it("rejects a failed outcome that also carries a packet", () => {
    expect(() =>
      decodeDiagnosticsExportOutcome({
        kind: "failed",
        failure: { category: "incomplete", message: "missing facts" },
        packet: validPacket,
      }),
    ).toThrow();
  });
});

describe("JournalGrowth", () => {
  const days = Array.from(
    { length: 14 },
    (_, index) => `2026-10-${String(3 + index).padStart(2, "0")}`,
  );
  const growth = {
    generatedAt: "2026-10-16T09:30:00.000Z",
    days,
    kinds: [{ kind: "chat-thread", counts: [1, ...Array.from({ length: 13 }, () => 0)], total: 1 }],
    journalHead: 1,
    databaseBytes: 4096,
  };

  it("decodes a report of counts per kind per day and rides on a packet", () => {
    expect(decodeJournalGrowth(growth).kinds[0]?.total).toBe(1);
    expect(
      decodeDiagnosticEvidencePacket({ ...validPacket, packetVersion: 2, journalGrowth: growth })
        .journalGrowth?.journalHead,
    ).toBe(1);
    expect(decodeDiagnosticEvidencePacket(validPacket).journalGrowth).toBeUndefined();
  });

  it("refuses payload fields, a short window, and a kind that is not a plain name", () => {
    expect(() => decodeJournalGrowth({ ...growth, payload: "x" })).toThrow();
    expect(() => decodeJournalGrowth({ ...growth, days: days.slice(1) })).toThrow();
    expect(() =>
      decodeJournalGrowth({
        ...growth,
        kinds: [{ kind: "/Users/me/secret thread", counts: growth.kinds[0]?.counts, total: 1 }],
      }),
    ).toThrow();
    expect(() =>
      decodeJournalGrowth({
        ...growth,
        kinds: [{ ...growth.kinds[0], threadTitle: "Private" }],
      }),
    ).toThrow();
  });

  it("accepts both packet versions but only version 2 may carry the section", () => {
    expect(decodeDiagnosticEvidencePacket(validPacket).packetVersion).toBe(1);
    expect(decodeDiagnosticEvidencePacket({ ...validPacket, packetVersion: 2 }).packetVersion).toBe(
      2,
    );
    expect(() =>
      decodeDiagnosticEvidencePacket({ ...validPacket, journalGrowth: growth }),
    ).toThrow();
    const hostHealth = {
      slowStatementCount: 1,
      slowStatementWorstMs: 40,
      eventLoopLagCount: 0,
      eventLoopLagWorstMs: 0,
    };
    expect(() => decodeDiagnosticEvidencePacket({ ...validPacket, hostHealth })).toThrow();
    const v2 = { ...validPacket, packetVersion: 2 };
    expect(decodeDiagnosticEvidencePacket({ ...v2, hostHealth }).hostHealth).toEqual(hostHealth);
    expect(
      decodeDiagnosticEvidencePacket({ ...v2, hostHealth, journalGrowth: growth }).packetVersion,
    ).toBe(2);
    expect(() => decodeDiagnosticEvidencePacket({ ...validPacket, packetVersion: 3 })).toThrow();
  });
});
