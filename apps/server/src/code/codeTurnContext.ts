import {
  decodeContextEntry,
  decodeProviderInstanceId,
  type CodeThread,
  type ContextEntry,
  type ProviderAttachmentInput,
  type ProviderContextBlock,
  type ProviderContextBreakdown,
  type ProviderContextPart,
  type ProviderRuntimeEvent,
  type ProviderSentContextAccounting,
  type ProviderToolDefinition,
} from "@octant/contracts";
import {
  attributeProfileInstructions,
  attributeProfileSkillInstructions,
  type ProfileContextAttribution,
} from "@octant/domain/agent-profile-policy";

export interface CodeProfileSkillContribution {
  readonly qualifiedId: string;
  readonly displayName: string;
  readonly text: string;
}

export interface ComposedCodeProfileContext {
  readonly entries: ReadonlyArray<ContextEntry>;
  readonly blocks: ReadonlyArray<ProviderContextBlock>;
  /** The same blocks, split into what the window accounting names apart. */
  readonly sent: CodeTurnSentContext;
}

/**
 * The context blocks of a turn that are Octant's instructions or skills. They
 * are the same blocks the turn's context carries, named apart only so the
 * window accounting can count each; the provider never sees this split.
 */
export interface CodeTurnSentContext {
  readonly instructions: ReadonlyArray<ProviderContextBlock>;
  readonly skills: ReadonlyArray<ProviderContextBlock>;
}

/**
 * Compose snapshotted profile instructions and admitted skills as attributed
 * Code context. A thread without a snapshot contributes nothing, so a thread
 * that never bound a profile is unchanged.
 */
export function composeCodeProfileContext(input: {
  readonly thread: Pick<CodeThread, "id" | "providerInstanceId" | "profileId" | "profileContext">;
  readonly skills?: ReadonlyArray<CodeProfileSkillContribution>;
  readonly uuid: () => string;
}): ComposedCodeProfileContext {
  const snapshot = input.thread.profileContext;
  if (snapshot === undefined)
    return { entries: [], blocks: [], sent: { instructions: [], skills: [] } };

  const attributions: ProfileContextAttribution[] = [];
  if (snapshot.instructions !== undefined && input.thread.profileId !== undefined) {
    attributions.push(
      attributeProfileInstructions({
        profileId: String(input.thread.profileId),
        displayName: snapshot.displayName,
        instructions: snapshot.instructions,
      }),
    );
  }
  for (const skill of input.skills ?? []) {
    attributions.push(
      attributeProfileSkillInstructions({
        qualifiedId: skill.qualifiedId,
        displayName: skill.displayName,
        text: skill.text,
      }),
    );
  }

  const providerInstanceId = decodeProviderInstanceId(input.thread.providerInstanceId);
  const entries: ContextEntry[] = [];
  const blocks: ProviderContextBlock[] = [];
  const instructions: ProviderContextBlock[] = [];
  const skills: ProviderContextBlock[] = [];
  for (const attribution of attributions) {
    const tokens = Math.max(16, Math.ceil(attribution.text.length / 4));
    entries.push(
      decodeContextEntry({
        id: input.uuid(),
        source: { kind: attribution.sourceKind, referenceId: attribution.referenceId },
        category: attribution.category,
        label: attribution.label,
        eligibility: {
          providerInstanceId,
          status: "eligible",
          reason: "selected-provider",
        },
        posture: attribution.sourceKind === "instruction" ? "required" : "compressible",
        retention: "active",
        priority: attribution.sourceKind === "instruction" ? 100 : 20,
        originalSize: tokens,
        includedSize: tokens,
        tokens: { kind: "known", tokens, accuracy: "conservative-heuristic" },
        state: "included",
        introducedAtTurn: 1,
        reuseCount: 0,
        preview: { redacted: true, label: attribution.label },
      }),
    );
    const block = { kind: "instructions", text: attribution.text } as const;
    blocks.push(block);
    (attribution.sourceKind === "instruction" ? instructions : skills).push(block);
  }
  return { entries, blocks, sent: { instructions, skills } };
}

/**
 * The tool definitions Octant registers with a provider-run session, counted as
 * a part of that session's window. A tool definition travels with every request,
 * so it holds a place in the window however long the thread runs; this is the
 * one thing a runtime that reports no categories lets Octant count as it was
 * sent. The size is still an estimate: it takes the serialized definition at four
 * characters to a token, with the same floor per tool as Work's planned input,
 * and says so as a conservative heuristic.
 */
export function estimateOctantToolsPart(
  definitions: ReadonlyArray<ProviderToolDefinition>,
): ProviderContextBreakdown | undefined {
  if (definitions.length === 0) return undefined;
  const tokens = definitions.reduce(
    (sum, tool) => sum + Math.max(16, Math.ceil(JSON.stringify(tool).length / 4)),
    0,
  );
  return {
    parts: [
      {
        kind: "octant-tools",
        tokens,
        accuracy: "conservative-heuristic",
        count: definitions.length,
      },
    ],
  };
}

/**
 * The kinds of part that are copies of what Octant sends with every turn's
 * prompt. Unlike tool definitions, which travel beside each request once, these
 * are inside the prompt, so a runtime that keeps its prompts holds one copy per
 * turn.
 */
const SENT_KINDS = ["octant-instructions", "skills", "attachments"] as const;
type SentKind = (typeof SENT_KINDS)[number];

/**
 * What earlier turns of the same provider session left in its window: the
 * copies Octant counted, or the reason it stopped counting.
 */
export type CarriedSentContext =
  | {
      readonly status: "counted";
      readonly parts: ReadonlyArray<ProviderContextPart>;
    }
  | Extract<ProviderSentContextAccounting, { readonly status: "uncounted" }>;

/** This turn's copies, and what the session already held. */
export interface CodeTurnContextAccount {
  readonly turn: ReadonlyArray<ProviderContextPart>;
  readonly carried: CarriedSentContext;
}

/**
 * The size of one copy of what this turn sends inside its prompt. A block is
 * sent as JSON beside the request (`renderProviderTurnPrompt`), so its size is
 * that JSON at four characters to a token, with the floor per entry Work's
 * planned input uses. No tokenizer ships with Octant, so every figure here is a
 * conservative heuristic, never an exact or model-family count.
 */
export function estimateSentContextParts(input: {
  readonly sent?: CodeTurnSentContext | undefined;
  readonly attachments?: ReadonlyArray<ProviderAttachmentInput> | undefined;
}): ReadonlyArray<ProviderContextPart> {
  const blockTokens = (blocks: ReadonlyArray<ProviderContextBlock>) =>
    blocks.reduce(
      (sum, block) => sum + Math.max(16, Math.ceil(JSON.stringify(block).length / 4)),
      0,
    );
  const parts: ProviderContextPart[] = [];
  const push = (kind: SentKind, tokens: number) => {
    if (tokens > 0) parts.push({ kind, tokens, accuracy: "conservative-heuristic" });
  };
  push("octant-instructions", blockTokens(input.sent?.instructions ?? []));
  push("skills", blockTokens(input.sent?.skills ?? []));
  push(
    "attachments",
    (input.attachments ?? []).reduce(
      (sum, attachment) => sum + estimateImageTokens(attachment.bytes),
      0,
    ),
  );
  return parts;
}

/**
 * The most an image is taken to cost. Providers scale a large picture down
 * before the model reads it and charge by area or by tile, and the published
 * rules differ by family: Anthropic fits it in 1568 px and about 1.15
 * megapixels, at width × height / 750 (about 1,600 at most); OpenAI's tiled
 * rule tops out near 1,100 for a high-detail image. Octant does not know which
 * family a runtime routes to, so it takes the area rule with that cap, the
 * larger of the two, and the cap whenever the size cannot be read.
 */
const IMAGE_TOKEN_CAP = 1_600;

export function estimateImageTokens(bytes: Uint8Array): number {
  const size = imageSize(bytes);
  if (size === undefined) return IMAGE_TOKEN_CAP;
  const scale = Math.min(
    1,
    1_568 / Math.max(size.width, size.height),
    Math.sqrt(1_150_000 / (size.width * size.height)),
  );
  const area = Math.floor(size.width * scale) * Math.floor(size.height * scale);
  return Math.max(1, Math.min(IMAGE_TOKEN_CAP, Math.ceil(area / 750)));
}

/** Width and height from a PNG, GIF, JPEG or WebP header, or nothing. */
function imageSize(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    offset + length > bytes.length
      ? ""
      : String.fromCharCode(...bytes.subarray(offset, offset + length));
  const valid = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;
  if (bytes.length >= 24 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR")
    return valid(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && ascii(0, 3) === "GIF")
    return valid(view.getUint16(6, true), view.getUint16(8, true));
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X")
      return valid(
        1 + (view.getUint16(24, true) | (view.getUint8(26) << 16)),
        1 + (view.getUint16(27, true) | (view.getUint8(29) << 16)),
      );
    if (chunk === "VP8 ")
      return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      return valid(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    return undefined;
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (view.getUint8(offset) !== 0xff) return undefined;
      const marker = view.getUint8(offset + 1);
      const length = view.getUint16(offset + 2);
      // Start-of-frame markers carry the size; C4, C8 and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return valid(view.getUint16(offset + 7), view.getUint16(offset + 5));
      offset += 2 + length;
    }
  }
  return undefined;
}

/**
 * What the session held before this turn. A turn that opens a new provider
 * session starts with nothing. A fork's first turn starts from another thread's
 * conversation, whose copies this thread never counted. A resumed session
 * carries what the last report of its previous turn said; a previous turn with
 * no report, or one from before Octant counted, leaves the session uncounted.
 */
export function carriedSentContext(input: {
  readonly freshSession: boolean;
  readonly forkSeeded: boolean;
  readonly priorTurn: boolean;
  /** The latest usage report of the thread, when it belongs to the prior turn. */
  readonly previousBreakdown?: ProviderContextBreakdown | undefined;
}): CarriedSentContext {
  if (input.forkSeeded) return { status: "uncounted", reason: "history-unknown" };
  if (input.freshSession || !input.priorTurn) return { status: "counted", parts: [] };
  const accounting = input.previousBreakdown?.sentContext;
  if (accounting === undefined) return { status: "uncounted", reason: "history-unknown" };
  if (accounting.status === "uncounted") return accounting;
  return {
    status: "counted",
    parts: (input.previousBreakdown?.parts ?? []).filter((part) =>
      (SENT_KINDS as ReadonlyArray<string>).includes(part.kind),
    ),
  };
}

/**
 * The parts Octant counts in the window of a runtime that reported none.
 *
 * Tool definitions are one copy whatever the session's length. What Octant
 * sends inside the prompt is one copy per turn while the runtime keeps its
 * prompts, so it is counted only while every copy is accounted for: the
 * runtime says it keeps them, has not compacted the window, and no earlier
 * turn of the session went uncounted. Otherwise those copies stay in the
 * remainder and the breakdown says why; nothing Octant sent is guessed at.
 */
export function octantWindowBreakdown(input: {
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
  readonly account?: CodeTurnContextAccount | undefined;
  readonly promptRetention?: Extract<
    ProviderRuntimeEvent,
    { readonly kind: "usage" }
  >["promptRetention"];
}): ProviderContextBreakdown | undefined {
  const tools = estimateOctantToolsPart(input.tools)?.parts ?? [];
  const { account } = input;
  if (account === undefined) return tools.length === 0 ? undefined : { parts: tools };
  const { carried, turn } = account;
  const sentContext = (): ProviderSentContextAccounting => {
    if (carried.status === "uncounted") return carried;
    if (carried.parts.length === 0 && turn.length === 0) return { status: "counted" };
    if (input.promptRetention === undefined)
      return { status: "uncounted", reason: "retention-unknown" };
    if (input.promptRetention === "compacted") return { status: "uncounted", reason: "compacted" };
    return { status: "counted" };
  };
  const accounting = sentContext();
  const sent: ProviderContextPart[] = [];
  if (accounting.status === "counted" && carried.status === "counted") {
    for (const kind of SENT_KINDS) {
      const tokens = [...carried.parts, ...turn]
        .filter((part) => part.kind === kind)
        .reduce((sum, part) => sum + part.tokens, 0);
      if (tokens > 0) sent.push({ kind, tokens, accuracy: "conservative-heuristic" });
    }
  }
  return { parts: [...tools, ...sent], sentContext: accounting };
}
