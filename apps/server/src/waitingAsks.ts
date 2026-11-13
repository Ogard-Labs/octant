import type {
  ImageGenerationOffer,
  OctantMode,
  ProjectMemoryProposal,
  RoutineAgentRequest,
} from "@octant/contracts";
import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import {
  decodeWaitingAsk,
  MAX_WAITING_ASK_DETAIL_LENGTH,
  MAX_WAITING_ASK_TEXT_LENGTH,
  type WaitingAsk,
  type WaitingAskKind,
} from "@octant/contracts/pending-requests";

/** What a row names an ask's thread by, as the reader's own lists hold it. */
export interface WaitingAskThread {
  readonly mode: OctantMode;
  readonly title: string;
  readonly projectId?: string;
}

/**
 * The asks each holding service would let one reader answer. Every list is
 * that service's own `list` for the reader, so its rule on who may answer (the
 * raising window, a window that can reach a host-run turn's thread, a paired
 * device for its own turns) decides what is here; nothing below widens it.
 */
export interface WaitingAskViews {
  readonly toolApprovals: ReadonlyArray<ExtensionToolApproval>;
  readonly browserApprovals: ReadonlyArray<BrowserToolApproval>;
  readonly memoryProposals: ReadonlyArray<ProjectMemoryProposal>;
  readonly routineProposals: ReadonlyArray<RoutineAgentRequest>;
  readonly imageOffers: ReadonlyArray<ImageGenerationOffer>;
}

interface AskWords {
  readonly kind: WaitingAskKind;
  readonly askId: string;
  readonly threadId: string;
  readonly requestedAt: string;
  readonly text: string;
  readonly detail?: string;
  /**
   * The card shows nothing beyond `text` and `detail`, and its answer is a
   * plain approve or decline. False where the card offers a choice a row does
   * not (a model, a schedule), asks the person to act (a sign-in), or names
   * the outside content that marked the thread.
   */
  readonly wholeAsk: boolean;
}

/**
 * Every waiting ask as a Needs you row, oldest first. An ask whose thread the
 * reader's lists do not hold (hidden, deleted, or in a mode that is off) is
 * left out: a row that opens nothing helps nobody, and the ask still waits in
 * its service.
 */
export function waitingAsksFrom(
  views: WaitingAskViews,
  readThread: (threadId: string) => WaitingAskThread | undefined,
): ReadonlyArray<WaitingAsk> {
  const words: ReadonlyArray<AskWords> = [
    ...views.toolApprovals.map(toolApprovalWords),
    ...views.browserApprovals.map(browserApprovalWords),
    ...views.memoryProposals.map(memoryProposalWords),
    ...views.routineProposals.map(routineProposalWords),
    ...views.imageOffers.map(imageOfferWords),
  ];
  const asks: WaitingAsk[] = [];
  for (const ask of words) {
    const thread = readThread(ask.threadId);
    if (thread === undefined) continue;
    const text = ask.text.trim();
    const detail = ask.detail?.trim() ?? "";
    // Words past a bound are never cut to fit: a row either carries the whole
    // ask or sends the person to the card that does.
    const fits =
      text.length <= MAX_WAITING_ASK_TEXT_LENGTH && detail.length <= MAX_WAITING_ASK_DETAIL_LENGTH;
    asks.push(
      decodeWaitingAsk({
        kind: ask.kind,
        askId: ask.askId,
        mode: thread.mode,
        ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
        threadId: ask.threadId,
        threadTitle: thread.title,
        requestedAt: ask.requestedAt,
        text: text.slice(0, MAX_WAITING_ASK_TEXT_LENGTH).trim(),
        ...(detail.length > 0 && detail.length <= MAX_WAITING_ASK_DETAIL_LENGTH ? { detail } : {}),
        ...(ask.wholeAsk && fits ? { inPlace: true } : {}),
      }),
    );
  }
  return asks.sort(
    (left, right) =>
      left.requestedAt.localeCompare(right.requestedAt) || left.askId.localeCompare(right.askId),
  );
}

function toolApprovalWords(approval: ExtensionToolApproval): AskWords {
  return {
    kind: "tool-approval",
    askId: approval.approvalId,
    threadId: approval.threadId,
    requestedAt: approval.requestedAt,
    text: `Run ${approval.mcpToolName} from ${approval.serverName}?`,
    detail: approval.inputJson,
    wholeAsk: approval.outsideContent === undefined,
  };
}

/**
 * A Browser ask is never answered from a row. Its card in the thread words
 * what the answer authorizes (which account a profile page acts as, that
 * uploaded files leave the computer, what a script may reach, who is asking),
 * and a row that restated that in words of its own could say less than the
 * card. The row names the site, the profile and the asker, and opens the
 * thread.
 */
function browserApprovalWords(approval: BrowserToolApproval): AskWords {
  const base = {
    askId: String(approval.approvalId),
    threadId: String(approval.threadId),
    requestedAt: approval.requestedAt,
  };
  // A page in a profile acts as the person's account there, so the row always
  // says which profile. Only an account profile carries a label of its own.
  const profile =
    approval.profile === undefined
      ? undefined
      : approval.profile.kind === "personal"
        ? "Personal"
        : approval.profile.kind === "project"
          ? "Project"
          : (approval.profileLabel ?? "Account");
  const where =
    profile === undefined
      ? approval.origin
      : `${approval.origin} in the ${profile} profile, signed in as you`;
  const extensions =
    approval.extensionCount === undefined
      ? undefined
      : `${String(approval.extensionCount)} ${approval.extensionCount === 1 ? "extension is" : "extensions are"} on in this profile.`;
  if (approval.signIn !== undefined) {
    return {
      ...base,
      kind: "browser-sign-in",
      text: `Sign in at ${where}`,
      ...(approval.signIn.reason === undefined ? {} : { detail: approval.signIn.reason }),
      wholeAsk: false,
    };
  }
  if (approval.upload !== undefined) {
    const files = approval.upload.files;
    return {
      ...base,
      kind: "browser-approval",
      text: `Upload ${String(files.length)} ${files.length === 1 ? "file" : "files"} to ${where}?`,
      detail: lines(...files.map((file) => `${file.name} (${bytes(file.sizeBytes)})`), extensions),
      wholeAsk: false,
    };
  }
  if (approval.download !== undefined) {
    const { name, sizeBytes, mediaType, source } = approval.download;
    return {
      ...base,
      kind: "browser-approval",
      text: `Save ${name} from ${where}?`,
      detail: lines(
        `${bytes(sizeBytes)}, ${mediaType}`,
        source === undefined ? undefined : `Came through ${source.origins.join(", then ")}`,
        extensions,
      ),
      wholeAsk: false,
    };
  }
  if (approval.script !== undefined) {
    return {
      ...base,
      kind: "browser-approval",
      text: `Run a script on ${where}?`,
      detail: lines(approval.script.source, extensions),
      wholeAsk: false,
    };
  }
  // In Code the thread's own agent asks for a site through its turn's
  // approval, so a site ask held here came from a program in one of the
  // thread's terminals. Who is asking is part of what the person approves.
  if (approval.mode === "code") {
    return {
      ...base,
      kind: "browser-approval",
      text: `A program in a terminal, not this thread's agent, asks to open ${where} in the Browser`,
      ...(extensions === undefined ? {} : { detail: extensions }),
      wholeAsk: false,
    };
  }
  return {
    ...base,
    kind: "browser-approval",
    text:
      profile === undefined
        ? `Let the agent use ${where} in the Browser?`
        : `Let the agent use ${where}?`,
    ...(extensions === undefined ? {} : { detail: extensions }),
    wholeAsk: false,
  };
}

function memoryProposalWords(proposal: ProjectMemoryProposal): AskWords {
  const { change } = proposal;
  const base = {
    kind: "memory-proposal" as const,
    askId: String(proposal.proposalId),
    threadId: proposal.threadId,
    requestedAt: proposal.requestedAt,
    wholeAsk: proposal.outsideContent === undefined,
  };
  switch (change.kind) {
    case "create":
      return { ...base, text: "Add to Project memory?", detail: change.content };
    case "supersede":
      return {
        ...base,
        text: "Replace a Project memory entry?",
        detail: lines(`Now: ${change.previousContent}`, `Would become: ${change.content}`),
      };
    case "retract":
      return {
        ...base,
        text: "Remove a Project memory entry?",
        detail: lines(change.content, `Why: ${change.reason}`),
      };
  }
}

function routineProposalWords(request: RoutineAgentRequest): AskWords {
  const base = {
    kind: "routine-proposal" as const,
    askId: String(request.proposalId),
    threadId: String(request.threadId),
    requestedAt: request.requestedAt,
    // The card shows the schedule and the task; a row names the routine only.
    wholeAsk: false,
  };
  if ("kind" in request) {
    const verb = request.change === "pause" ? "Pause" : "Archive";
    return { ...base, text: `${verb} the routine ${request.displayName}?` };
  }
  return { ...base, text: `Create the routine ${request.displayName}?` };
}

function imageOfferWords(offer: ImageGenerationOffer): AskWords {
  const base = {
    kind: "image-offer" as const,
    askId: String(offer.offerId),
    threadId: String(offer.scopeId),
    requestedAt: offer.requestedAt,
    // Generating takes the person's choice of model; saving names a path the
    // card shows beside the picture.
    wholeAsk: false,
  };
  return offer.kind === "save"
    ? { ...base, text: `Save a generated image as ${offer.relativePath}?` }
    : {
        ...base,
        text:
          offer.variantCount === 1
            ? "Generate an image?"
            : `Generate ${String(offer.variantCount)} images?`,
        detail: offer.prompt,
      };
}

function lines(...parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined).join("\n");
}

function bytes(count: number): string {
  return `${String(count)} ${count === 1 ? "byte" : "bytes"}`;
}
