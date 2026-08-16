import { Schema } from "effect";
import { BrowserContextPolicy } from "./browserAutomation";
import { ComputerUsePolicy } from "./computerUse";
import { ExtensionCapability } from "./extensions";
import {
  ToolActionCapability,
  ToolCapabilityId,
  type ToolActionCapability as ToolActionCapabilityType,
} from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Approval categories from rewrite design §8.4 — independent axes enforced at
 * policy step 7 (thread elevation / approval / taint).
 */
export const ToolApprovalClass = Schema.Literal(
  "project-file-writes",
  "shell-commands",
  "network-access",
  "external-application",
  "destructive-irreversible",
  "credential-secret-access",
  "access-outside-project",
  "privilege-expansion",
);
export type ToolApprovalClass = typeof ToolApprovalClass.Type;

/**
 * Per-thread network egress levels resolved by the tool-call policy engine.
 * Code approval-gated defaults to `provider-endpoints-only` (approved 2026-08-12).
 */
export const ToolNetworkEgressPolicy = Schema.Literal(
  "none",
  "provider-endpoints-only",
  "unrestricted",
);
export type ToolNetworkEgressPolicy = typeof ToolNetworkEgressPolicy.Type;

export const ToolCatalogOwner = Schema.Literal("core", "extension-namespaced");
export type ToolCatalogOwner = typeof ToolCatalogOwner.Type;

export const ToolCatalogCapabilityClass = Schema.Union(
  ExtensionCapability,
  Schema.Literal("validation"),
);
export type ToolCatalogCapabilityClass = typeof ToolCatalogCapabilityClass.Type;

const McpToolArguments = Schema.Struct({
  mcpToolName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  providerToolName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  inputJson: Schema.String.pipe(Schema.maxLength(64 * 1024)),
  requiredCapabilityClass: ExtensionCapability,
}).annotations(strict);
export type McpToolArguments = typeof McpToolArguments.Type;

const ValidationToolArguments = Schema.Struct({
  intent: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4 * 1024))),
}).annotations(strict);

export type ClosedToolCatalogEntry = {
  readonly capabilityId: ToolCapabilityId;
  readonly version: number;
  readonly name: string;
  readonly owner: ToolCatalogOwner;
  readonly modes: ReadonlyArray<"chat" | "work" | "code">;
  readonly requiredCapabilityClass: ToolCatalogCapabilityClass;
  readonly approvalClass: ToolApprovalClass;
  /** Classes that remain irreversible under thread taint. */
  readonly irreversibleUnderTaint: boolean;
  readonly requiresAppManagedTools: boolean;
  readonly decodeArguments: (value: unknown) => unknown;
};

function entry(input: {
  readonly capabilityId: string;
  readonly version: number;
  readonly owner: ToolCatalogOwner;
  readonly modes: ReadonlyArray<"chat" | "work" | "code">;
  readonly requiredCapabilityClass: ToolCatalogCapabilityClass;
  readonly approvalClass: ToolApprovalClass;
  readonly irreversibleUnderTaint: boolean;
  readonly requiresAppManagedTools: boolean;
  readonly decodeArguments: (value: unknown) => unknown;
}): ClosedToolCatalogEntry {
  const capabilityId = Schema.decodeUnknownSync(ToolCapabilityId)(input.capabilityId);
  return {
    capabilityId,
    version: input.version,
    name: input.capabilityId,
    owner: input.owner,
    modes: input.modes,
    requiredCapabilityClass: input.requiredCapabilityClass,
    approvalClass: input.approvalClass,
    irreversibleUnderTaint: input.irreversibleUnderTaint,
    requiresAppManagedTools: input.requiresAppManagedTools,
    decodeArguments: input.decodeArguments,
  };
}

const decodeBrowserContextPolicy = Schema.decodeUnknownSync(BrowserContextPolicy);
const decodeComputerUsePolicy = Schema.decodeUnknownSync(ComputerUsePolicy);
const decodeMcpToolArguments = Schema.decodeUnknownSync(McpToolArguments);
const decodeValidationToolArguments = Schema.decodeUnknownSync(ValidationToolArguments);

/**
 * Closed Octant-owned tool catalog. Capability ids and argument schemas are
 * grounded in existing `@octant/contracts` tool surfaces so callers cannot
 * invent a parallel drifting catalogue. Providers/extensions/prompts cannot add
 * entries; MCP tools resolve only as `extension-namespaced`.
 */
export const CLOSED_TOOL_CATALOG: ReadonlyArray<ClosedToolCatalogEntry> = [
  entry({
    capabilityId: "browser-automation",
    version: 1,
    owner: "core",
    modes: ["work", "code"],
    requiredCapabilityClass: "browser",
    approvalClass: "network-access",
    irreversibleUnderTaint: false,
    requiresAppManagedTools: true,
    decodeArguments: (value) => decodeBrowserContextPolicy(value),
  }),
  entry({
    capabilityId: "computer-use",
    version: 1,
    owner: "core",
    modes: ["work", "code"],
    requiredCapabilityClass: "computer-use",
    approvalClass: "external-application",
    irreversibleUnderTaint: true,
    requiresAppManagedTools: true,
    decodeArguments: (value) => decodeComputerUsePolicy(value),
  }),
  entry({
    capabilityId: "repository-validation",
    version: 1,
    owner: "core",
    modes: ["work", "code"],
    requiredCapabilityClass: "validation",
    approvalClass: "project-file-writes",
    irreversibleUnderTaint: false,
    requiresAppManagedTools: true,
    decodeArguments: (value) => decodeValidationToolArguments(value ?? {}),
  }),
  entry({
    capabilityId: "mcp-tool",
    version: 1,
    owner: "extension-namespaced",
    modes: ["chat", "work", "code"],
    requiredCapabilityClass: "mcp",
    approvalClass: "privilege-expansion",
    irreversibleUnderTaint: true,
    requiresAppManagedTools: true,
    decodeArguments: (value) => decodeMcpToolArguments(value),
  }),
];

const catalogByKey = new Map(
  CLOSED_TOOL_CATALOG.map((tool) => [`${tool.capabilityId}@${tool.version}`, tool] as const),
);

export function lookupClosedToolCatalogEntry(
  capability: Pick<ToolActionCapabilityType, "id" | "version">,
): ClosedToolCatalogEntry | undefined {
  return catalogByKey.get(`${capability.id}@${capability.version}`);
}

export function listClosedToolCatalog(): ReadonlyArray<ClosedToolCatalogEntry> {
  return CLOSED_TOOL_CATALOG;
}

export const decodeToolApprovalClass = Schema.decodeUnknownSync(ToolApprovalClass);
export const decodeToolNetworkEgressPolicy = Schema.decodeUnknownSync(ToolNetworkEgressPolicy);
export const decodeToolActionCapabilityForCatalog = Schema.decodeUnknownSync(ToolActionCapability);
