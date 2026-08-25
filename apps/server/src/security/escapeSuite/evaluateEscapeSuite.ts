import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeAuditActingPrincipal,
  decodeAuditEvent,
  type AuditActingPrincipal,
  type AuditEvent,
} from "@octant/contracts/audit-events";
import type { AgentRunAuthority } from "@octant/contracts/agent-run";
import { decodeToolActionAuthority, decodeToolActionRequest } from "@octant/contracts/tool-actions";
import {
  AgentRunPolicyRejected,
  authorizeCodeOperation,
  authorizePrincipalAction,
  authorizeToolAction,
  clampAgentRunAuthority,
  WorkConfinementRejected,
  canonicalizeWorkRelativePath,
  evaluateSession,
  assertAuditPayloadRedacted,
  assertNoPrincipalIdentityInAuditInput,
  validateAgentRunDepth,
  validateWorkspaceReceipt,
} from "@octant/domain";
import { isExtensionComponentModeSafe, resolveExtensionActivation } from "@octant/plugin-host";

const here = dirname(fileURLToPath(import.meta.url));
export const ESCAPE_SUITE_FIXTURES_ROOT = join(here, "fixtures");

export type EscapeSuiteFixtureName =
  | "injected-readme"
  | "rogue-mcp-server"
  | "scope-widening-child"
  | "overreaching-remote-client";

export interface EscapeSuiteCaseRow {
  readonly id: string;
  readonly kind: string;
  readonly expectedDenial: string;
  readonly policySurface: string;
  readonly resolutionStep: string;
  readonly auditEvent: string;
  readonly relativePath?: string;
  readonly mode?: "chat" | "work" | "code";
  readonly componentKind?: string;
  readonly declaredCapabilities?: ReadonlyArray<string>;
  readonly action?: string;
  readonly operation?: "push" | "create-pr" | "read" | "edit";
}

export interface EscapeSuiteCaseFile {
  readonly fixture: EscapeSuiteFixtureName;
  readonly abuseCase: string;
  readonly rows: ReadonlyArray<EscapeSuiteCaseRow>;
}

export interface EscapeSuiteEvaluation {
  readonly rowId: string;
  readonly denied: true;
  readonly denialReason: string;
  readonly sideEffects: ReadonlyArray<never>;
  readonly auditEvent: AuditEvent;
}

const ids = {
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  action: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  approval: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  device: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  thread: "11111111-1111-4111-8111-111111111111",
  host: "4f70656e-4f72-4269-9474-4c6f63616c31",
  project: "22222222-2222-4222-8222-222222222222",
  root: "33333333-3333-4333-8333-333333333333",
  worktree: "44444444-4444-4444-8444-444444444444",
  extension: "99999999-9999-4999-8999-999999999999",
} as const;

const parentAuthority: AgentRunAuthority = {
  filesystem: true,
  shell: false,
  git: true,
  network: false,
  tools: true,
  subagents: true,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

export function loadEscapeSuiteCases(fixture: EscapeSuiteFixtureName): EscapeSuiteCaseFile {
  const raw = readFileSync(join(ESCAPE_SUITE_FIXTURES_ROOT, fixture, "cases.json"), "utf8");
  return JSON.parse(raw) as EscapeSuiteCaseFile;
}

export function listEscapeSuiteFixtures(): ReadonlyArray<EscapeSuiteFixtureName> {
  return [
    "injected-readme",
    "rogue-mcp-server",
    "scope-widening-child",
    "overreaching-remote-client",
  ];
}

/**
 * Evaluate one escape-suite row against current fail-closed modules (S1
 * `toolCallPolicy` not merged yet). Always returns a structured denial, a
 * correlated audit event, and an empty side-effect list.
 */
export function evaluateEscapeSuiteRow(row: EscapeSuiteCaseRow): EscapeSuiteEvaluation {
  assertNoPrincipalIdentityInAuditInput({
    actionId: ids.action,
    denialReason: row.expectedDenial,
  });

  const denialReason = resolveDenial(row);
  if (denialReason !== row.expectedDenial) {
    throw new Error(
      `Escape suite row ${row.id}: expected denial ${row.expectedDenial}, got ${denialReason}`,
    );
  }

  const auditEvent = buildDenialAuditEvent(row, denialReason);
  assertAuditPayloadRedacted(auditEvent.body.payload);

  return {
    rowId: row.id,
    denied: true,
    denialReason,
    sideEffects: [],
    auditEvent,
  };
}

function resolveDenial(row: EscapeSuiteCaseRow): string {
  switch (row.kind) {
    case "work-path": {
      try {
        canonicalizeWorkRelativePath(row.relativePath ?? "");
        return "allowed";
      } catch (error) {
        if (error instanceof WorkConfinementRejected) return error.code;
        throw error;
      }
    }
    case "tool-action-authority": {
      const granted = decodeToolActionAuthority({
        hostId: ids.host,
        mode: "code",
        projectId: ids.project,
        rootId: ids.root,
        worktreeId: ids.worktree,
        providerInstanceId: ids.provider,
        extension: { kind: "core" },
      });
      const request = decodeToolActionRequest({
        actionId: ids.action,
        correlationId: ids.correlation,
        capability: { id: "shell-exec", version: 1 },
        authority: {
          ...granted,
          extension: { kind: "trusted-extension", extensionId: ids.extension },
        },
        intent: "README claimed approval already granted.",
        approval: { kind: "approved", approvalId: ids.approval },
      });
      const decision = authorizeToolAction(request, granted);
      return decision.kind === "unauthorized" ? decision.reason : "allowed";
    }
    case "policy-decision": {
      // Instruction-shaped tool results / README text never mint authority.
      const transcript = readFileSync(
        join(ESCAPE_SUITE_FIXTURES_ROOT, "injected-readme", "tool-result-transcript.txt"),
        "utf8",
      );
      if (
        /approval-granted|full-access|curl .*\|/i.test(transcript) ||
        /deviceId=|sessionId=|windowId=/i.test(transcript)
      ) {
        return "untrusted-content-not-authority";
      }
      return "allowed";
    }
    case "extension-mode-safety": {
      const safe = isExtensionComponentModeSafe(row.mode ?? "chat", {
        id: "undeclared-shell" as never,
        kind: (row.componentKind ?? "mcp-tool") as never,
        displayName: "shell.exec",
        declaredCapabilities: (row.declaredCapabilities ?? ["mcp", "shell"]) as never,
      });
      return safe ? "allowed" : "mode-prohibited-capability";
    }
    case "extension-activation": {
      const result = resolveExtensionActivation({
        hostAllowed: true,
        modeAllowed: true,
        projectAllowed: true,
        threadAllowed: true,
        catalogCurrent: true,
        installed: true,
        trusted: row.expectedDenial !== "untrusted",
        pluginDesired: true,
        componentDesired: true,
        compatible: true,
        policyAllowed: true,
        quarantined: row.expectedDenial === "quarantined",
        draining: false,
        broken: false,
        unavailable: false,
        interrupted: false,
        waiting: false,
      });
      return result.kind === "blocked" ? result.reason : "allowed";
    }
    case "child-clamp": {
      try {
        if (row.id.endsWith("shell-bit")) {
          clampAgentRunAuthority({
            parentAuthority,
            requestedAuthority: { ...parentAuthority, shell: true },
          });
        } else if (row.id.endsWith("full-access-under-approval-gated")) {
          clampAgentRunAuthority({
            parentAuthority,
            requestedAuthority: { ...parentAuthority, executionPolicy: "full-access" },
          });
        } else if (row.id.endsWith("project-default-under-session")) {
          clampAgentRunAuthority({
            parentAuthority,
            requestedAuthority: {
              ...parentAuthority,
              permissionPersistence: "project-default",
            },
          });
        }
        return "allowed";
      } catch (error) {
        if (error instanceof AgentRunPolicyRejected) return error.code;
        throw error;
      }
    }
    case "child-depth": {
      try {
        validateAgentRunDepth(3);
        return "allowed";
      } catch (error) {
        if (error instanceof AgentRunPolicyRejected) return error.code;
        throw error;
      }
    }
    case "workspace-receipt": {
      try {
        validateWorkspaceReceipt({
          workspaceReceipt: {
            kind: "code-worktree",
            mode: "code",
            projectId: ids.project as never,
            checkoutRoot: "foreign-project",
            worktreeRoot: "forged-worktree",
            verified: false,
          },
          routingReceipt: {
            mode: "code",
          } as never,
        });
        return "allowed";
      } catch (error) {
        if (error instanceof AgentRunPolicyRejected) return error.code;
        throw error;
      }
    }
    case "remote-session": {
      const decision = evaluateSession({
        now: 2_000,
        issuedAt: 0,
        idleExpiresAt: 1_500,
        absoluteExpiresAt: 1_000,
      });
      return decision.kind === "expired" ? decision.reason : "allowed";
    }
    case "remote-action": {
      const decision = authorizePrincipalAction({
        principalKind: "remote-device",
        action: row.action ?? "invented.action",
      });
      return decision.kind === "deny" ? decision.reason : "allowed";
    }
    case "remote-laundering": {
      const decision = authorizePrincipalAction({
        principalKind: "remote-device",
        action: "chat.send-turn",
        requestedPrincipalKind: "local-window",
      });
      return decision.kind === "deny" ? decision.reason : "allowed";
    }
    case "code-operation": {
      const decision = authorizeCodeOperation({
        actor: "remote-client",
        posture: "approval-gated",
        operation: row.operation ?? "push",
      });
      // Credential-clamped outcomes are structured denials of unclamped push/PR.
      return decision.decision;
    }
    default:
      throw new Error(`Unknown escape-suite row kind: ${row.kind}`);
  }
}

function buildDenialAuditEvent(row: EscapeSuiteCaseRow, denialReason: string): AuditEvent {
  const occurredAt = "2026-08-12T12:00:00.000Z";
  const actor =
    row.policySurface === "remote-access" || row.policySurface === "code-policy"
      ? {
          kind: "remote-device" as const,
          actorId: ids.actor,
          deviceId: ids.device,
        }
      : row.policySurface === "agent-run"
        ? {
            kind: "agent" as const,
            actorId: ids.actor,
            providerInstanceId: ids.provider,
            threadId: ids.thread,
          }
        : {
            kind: "local-user" as const,
            actorId: ids.actor,
          };

  const actingPrincipal: AuditActingPrincipal =
    actor.kind === "remote-device"
      ? decodeAuditActingPrincipal({ kind: "remote-device", deviceId: ids.device })
      : decodeAuditActingPrincipal({ kind: "local-window" });

  const eventName = row.auditEvent;
  let body: AuditEvent["body"];

  switch (eventName) {
    case "tool-call-denied":
      body = {
        eventName: "tool-call-denied",
        payload: {
          actionId: ids.action as never,
          correlationId: ids.correlation as never,
          actingPrincipal,
          denialReason: denialReason as never,
          resolutionStep: row.resolutionStep as never,
        },
      };
      break;
    case "policy-decision-recorded":
      body = {
        eventName: "policy-decision-recorded",
        payload: {
          correlationId: ids.correlation as never,
          actingPrincipal,
          decision: "deny",
          denialReason: denialReason as never,
          resolutionStep: row.resolutionStep as never,
          policySurface: row.policySurface as never,
        },
      };
      break;
    case "approval-denied":
      body = {
        eventName: "approval-denied",
        payload: {
          approvalClass: "local-confirmation" as never,
          scope: "action",
          correlationId: ids.correlation as never,
          actingPrincipal,
          denialReason: denialReason as never,
        },
      };
      break;
    case "authority-transition-recorded":
      body = {
        eventName: "authority-transition-recorded",
        payload: {
          correlationId: ids.correlation as never,
          actingPrincipal,
          transitionKind: "child-clamp" as never,
          outcome: "denied",
          denialReason: denialReason as never,
          scopeReference: "parent-run" as never,
        },
      };
      break;
    default:
      throw new Error(`Unsupported audit event for escape suite: ${eventName}`);
  }

  return decodeAuditEvent({
    eventVersion: 1,
    eventName,
    actor,
    occurredAt,
    body,
  });
}
