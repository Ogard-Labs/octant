import type { AgentProfile } from "@octant/contracts/agent-profile";
import type {
  AgentRunAuthority,
  AutomationAuthorityProfileReceipt,
  AutomationBindingReceipt,
  AutomationDigest,
  AutomationExecutionProfileReceipt,
  AutomationMode,
} from "@octant/contracts";
import type {
  CodeBootstrap,
  CodeCheckoutIdentity,
  WorktreeReceiptId,
} from "@octant/contracts/code";
import {
  decodeBindingReceiptId,
  type BindingReceiptId,
  type BindingRevisionId,
  type ProjectId,
  type ProjectSummary,
} from "@octant/contracts/projects";
import type {
  AutomationAuthorityProfileOption,
  AutomationEditorCatalog,
  AutomationExecutionProfileOption,
  AutomationProjectOption,
} from "./automationCenterModel";

export interface AutomationProviderChoice {
  readonly providerInstanceId: string;
  readonly modelId: string;
}

/**
 * Prepared Code checkout facts already observed for a Project (for example via
 * `prepare-code-project-checkout`). When complete and available, these let the
 * editor catalog include a Code Project without requiring an ordinary thread.
 */
export interface PreparedCodeCheckoutFact {
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly checkout: CodeCheckoutIdentity;
}

export interface BuildAutomationEditorCatalogInput {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly actorId: string;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly profiles: ReadonlyArray<AgentProfile>;
  readonly providerChoicesByMode: {
    readonly work: ReadonlyArray<AutomationProviderChoice>;
    readonly code: ReadonlyArray<AutomationProviderChoice>;
  };
  /**
   * Optional Code bootstrap facts. Code Projects are included when a managed
   * checkout with an ownership receipt can be linked to the Project through an
   * ordinary thread, or when {@link preparedCodeCheckouts} supplies complete
   * durable checkout facts. Incomplete facts stay omitted rather than invented.
   */
  readonly codeBootstrap?: CodeBootstrap | null | undefined;
  /**
   * Optional prepared checkout observations keyed by Project. Prefer these
   * over inventing repository/checkout IDs from ProjectSummary alone.
   */
  readonly preparedCodeCheckouts?: ReadonlyArray<PreparedCodeCheckoutFact>;
}

/**
 * Build the Automation definition editor catalog from server-authoritative
 * client state already loaded in App (Projects, agent profiles, provider
 * choices, and optional Code bootstrap / prepared checkout facts). Incomplete
 * binding facts are skipped honestly; Full access profiles never appear.
 * Fail-closed: any unexpected decode/hash error yields an empty catalog
 * rather than throwing into React.
 */
export function buildAutomationEditorCatalog(
  input: BuildAutomationEditorCatalogInput,
): AutomationEditorCatalog {
  try {
    const projects: AutomationProjectOption[] = [];
    for (const project of input.projects) {
      if (project.lifecycle !== "active") continue;
      if (project.type !== "work" && project.type !== "code") continue;
      try {
        const option = projectOptionFromSummary(
          input.hostId,
          project,
          input.codeBootstrap,
          input.preparedCodeCheckouts,
        );
        if (option !== undefined) projects.push(option);
      } catch {
        // Skip Projects whose binding facts cannot be decoded honestly.
      }
    }

    const executionProfiles: AutomationExecutionProfileOption[] = [];
    const authorityProfiles: AutomationAuthorityProfileOption[] = [];
    const seenAuthority = new Set<string>();

    for (const profile of input.profiles) {
      if (profile.defaultExecutionPolicy !== "approval-gated") continue;

      try {
        const authority = authorityOptionFromProfile(profile);
        if (authority !== undefined && !seenAuthority.has(String(authority.receipt.profileId))) {
          seenAuthority.add(String(authority.receipt.profileId));
          authorityProfiles.push(authority);
        }

        for (const project of projects) {
          if (!profile.compatibleModes.includes(project.mode)) continue;
          const execution = executionOptionFromProfile(input, profile, project);
          if (execution !== undefined) executionProfiles.push(execution);
        }
      } catch {
        // Skip profiles that cannot produce approval-gated receipts.
      }
    }

    return {
      hosts: [{ hostId: input.hostId, label: input.hostLabel }],
      projects,
      executionProfiles,
      authorityProfiles,
      actorId: input.actorId,
    };
  } catch {
    return {
      hosts: [{ hostId: input.hostId, label: input.hostLabel }],
      projects: [],
      executionProfiles: [],
      authorityProfiles: [],
      actorId: input.actorId,
    };
  }
}

function projectOptionFromSummary(
  hostId: string,
  project: Extract<ProjectSummary, { type: "work" | "code" }>,
  codeBootstrap: CodeBootstrap | null | undefined,
  preparedCodeCheckouts: ReadonlyArray<PreparedCodeCheckoutFact> | undefined,
): AutomationProjectOption | undefined {
  const bindingRevisionId = project.bindingRevisionId;
  if (bindingRevisionId === undefined || String(bindingRevisionId).trim() === "") {
    return undefined;
  }

  if (project.type === "work") {
    const binding: AutomationBindingReceipt = {
      kind: "work",
      hostId: hostId as never,
      projectId: project.id,
      projectVersion: project.version,
      bindingRevisionId,
      bindingReceiptId: durableWorkBindingReceiptId(String(project.id), String(bindingRevisionId)),
    };
    return {
      projectId: project.id,
      name: project.name,
      mode: "work",
      projectVersion: project.version,
      binding,
    };
  }

  const codeBinding = codeBindingFromCompleteFacts(
    hostId,
    project,
    codeBootstrap,
    preparedCodeCheckouts,
  );
  if (codeBinding === undefined) return undefined;
  return {
    projectId: project.id,
    name: project.name,
    mode: "code",
    projectVersion: project.version,
    binding: codeBinding,
  };
}

/**
 * Resolve a Code Automation binding only when checkout facts are complete.
 * Prefer ProjectSummary bindingRevision-backed durable receipts over ephemeral
 * ownership/picker IDs once the managed/prepared checkout gate has passed.
 */
function codeBindingFromCompleteFacts(
  hostId: string,
  project: Extract<ProjectSummary, { type: "code" }>,
  codeBootstrap: CodeBootstrap | null | undefined,
  preparedCodeCheckouts: ReadonlyArray<PreparedCodeCheckoutFact> | undefined,
): AutomationBindingReceipt | undefined {
  const fromThread = codeBindingFromBootstrap(hostId, project, codeBootstrap);
  if (fromThread !== undefined) return fromThread;
  return codeBindingFromPrepared(hostId, project, preparedCodeCheckouts);
}

function codeBindingFromBootstrap(
  hostId: string,
  project: Extract<ProjectSummary, { type: "code" }>,
  codeBootstrap: CodeBootstrap | null | undefined,
): AutomationBindingReceipt | undefined {
  if (codeBootstrap === undefined || codeBootstrap === null) return undefined;
  const thread = codeBootstrap.threads.find(
    (candidate) =>
      String(candidate.projectId) === String(project.id) &&
      String(candidate.bindingRevisionId) === String(project.bindingRevisionId),
  );
  if (thread === undefined) return undefined;
  const checkout = codeBootstrap.checkouts.find(
    (candidate) => String(candidate.id) === String(thread.checkoutId),
  );
  if (checkout === undefined || checkout.kind !== "managed-worktree") return undefined;
  if (checkout.availability !== "available") return undefined;
  // Ownership receipt proves the managed grant is complete; the stored
  // Automation receipt prefers durable Project/binding/checkout identity.
  if (
    checkout.ownershipReceiptId === undefined ||
    String(checkout.ownershipReceiptId).trim() === ""
  ) {
    return undefined;
  }
  return {
    kind: "code",
    hostId: hostId as never,
    projectId: project.id,
    projectVersion: project.version,
    bindingRevisionId: project.bindingRevisionId,
    repositoryId: thread.repositoryId,
    checkoutId: thread.checkoutId,
    worktreeReceiptId: durableCodeWorktreeReceiptId({
      projectId: String(project.id),
      bindingRevisionId: String(project.bindingRevisionId),
      repositoryId: String(thread.repositoryId),
      checkoutId: String(thread.checkoutId),
    }),
  };
}

function codeBindingFromPrepared(
  hostId: string,
  project: Extract<ProjectSummary, { type: "code" }>,
  preparedCodeCheckouts: ReadonlyArray<PreparedCodeCheckoutFact> | undefined,
): AutomationBindingReceipt | undefined {
  if (preparedCodeCheckouts === undefined || preparedCodeCheckouts.length === 0) {
    return undefined;
  }
  const prepared = preparedCodeCheckouts.find(
    (candidate) =>
      String(candidate.projectId) === String(project.id) &&
      String(candidate.bindingRevisionId) === String(project.bindingRevisionId),
  );
  if (prepared === undefined) return undefined;
  const checkout = prepared.checkout;
  if (checkout.availability !== "available") return undefined;
  if (checkout.kind === "managed-worktree") {
    if (
      checkout.ownershipReceiptId === undefined ||
      String(checkout.ownershipReceiptId).trim() === ""
    ) {
      return undefined;
    }
  } else if (checkout.kind !== "existing-worktree") {
    return undefined;
  }
  return {
    kind: "code",
    hostId: hostId as never,
    projectId: project.id,
    projectVersion: project.version,
    bindingRevisionId: project.bindingRevisionId,
    repositoryId: checkout.repositoryId,
    checkoutId: checkout.id,
    worktreeReceiptId: durableCodeWorktreeReceiptId({
      projectId: String(project.id),
      bindingRevisionId: String(project.bindingRevisionId),
      repositoryId: String(checkout.repositoryId),
      checkoutId: String(checkout.id),
    }),
  };
}

function executionOptionFromProfile(
  input: BuildAutomationEditorCatalogInput,
  profile: AgentProfile,
  project: AutomationProjectOption,
): AutomationExecutionProfileOption | undefined {
  const choice = resolveProviderChoice(input, profile, project.mode);
  if (choice === undefined) return undefined;
  const receipt: AutomationExecutionProfileReceipt = {
    profileId: profile.id as never,
    profileVersion: profile.version,
    hostId: input.hostId as never,
    mode: project.mode,
    projectId: project.projectId,
    providerInstanceId: choice.providerInstanceId as never,
    modelId: choice.modelId as never,
    executionPolicy: profile.defaultExecutionPolicy,
    permissionPersistence: profile.defaultPermissionPersistence,
  };
  return { label: profile.displayName, receipt };
}

function authorityOptionFromProfile(
  profile: AgentProfile,
): AutomationAuthorityProfileOption | undefined {
  const includesWork = profile.compatibleModes.includes("work");
  const authority = authorityFromProfile(profile, includesWork ? "work" : "code");
  if (authority.executionPolicy === "full-access") return undefined;
  const digest = automationAuthorityDigest(authority);
  const receipt: AutomationAuthorityProfileReceipt = {
    profileId: profile.id as never,
    profileVersion: profile.version,
    requested: authority,
    effective: authority,
    effectiveAuthorityDigest: digest,
  };
  return { label: profile.displayName, receipt };
}

function authorityFromProfile(profile: AgentProfile, mode: AutomationMode): AgentRunAuthority {
  // Approval-gated only. Work never carries shell/Git; Code may.
  return {
    filesystem: true,
    shell: mode === "code",
    git: mode === "code",
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "approval-gated",
    permissionPersistence: profile.defaultPermissionPersistence,
  };
}

function resolveProviderChoice(
  input: BuildAutomationEditorCatalogInput,
  profile: AgentProfile,
  mode: AutomationMode,
): AutomationProviderChoice | undefined {
  const choices = input.providerChoicesByMode[mode];
  const constrained = profile.modelConstraints.map(String);
  for (const choice of choices) {
    if (constrained.length === 0 || constrained.includes(String(choice.modelId))) {
      return choice;
    }
  }
  return undefined;
}

/**
 * Durable opaque Work binding receipt derived from the Project + binding
 * revision identity. The ephemeral folder-picker receipt is consumed at
 * Project create/relink and is not retained on ProjectSummary; Automations
 * need a contract-valid BindingReceiptId that names the exact revision facts
 * already available to the renderer.
 */
export function durableWorkBindingReceiptId(
  projectId: string,
  bindingRevisionId: string,
): BindingReceiptId {
  const bytes = sha256Bytes(
    `octant.automation-work-binding-receipt.v1\0${projectId}\0${bindingRevisionId}`,
  );
  return decodeBindingReceiptId(bytesToBase64Url(bytes));
}

/**
 * Durable Code worktree receipt derived from Project + binding revision +
 * checkout identity. Prefer this over ephemeral picker/ownership IDs once
 * managed or prepared checkout facts have proven the grant is complete.
 */
export function durableCodeWorktreeReceiptId(input: {
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly repositoryId: string;
  readonly checkoutId: string;
}): WorktreeReceiptId {
  const digest = sha256Hex(
    `octant.automation-code-worktree-receipt.v1\0${input.projectId}\0${input.bindingRevisionId}\0${input.repositoryId}\0${input.checkoutId}`,
  ).slice(0, 32);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
  return uuid as WorktreeReceiptId;
}

/** Real SHA-256 digest of the authority snapshot (matches server digesting). */
export function automationAuthorityDigest(authority: AgentRunAuthority): AutomationDigest {
  return sha256Hex(JSON.stringify(authority)) as AutomationDigest;
}

function sha256Hex(value: string): string {
  return Array.from(sha256Bytes(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/**
 * Synchronous SHA-256 for renderer catalog assembly. Keeping this sync lets
 * App memoize the catalog without an effect/setState loop.
 */
function sha256Bytes(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const K = SHA256_K;
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = bytes.length * 8;
  const withPadding = new Uint8Array(((bytes.length + 9 + 63) & ~63) >>> 0);
  withPadding.set(bytes);
  withPadding[bytes.length] = 0x80;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 4, bitLength);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rightRotate(w[i - 15]!, 7) ^ rightRotate(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rightRotate(w[i - 2]!, 17) ^ rightRotate(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rightRotate(e!, 6) ^ rightRotate(e!, 11) ^ rightRotate(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rightRotate(a!, 2) ^ rightRotate(a!, 13) ^ rightRotate(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, hash[i]!);
  return out;
}

function rightRotate(value: number, amount: number): number {
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
