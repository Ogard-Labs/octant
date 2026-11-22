import {
  KEY_PROVIDER_DRIVER_KINDS,
  type KeyProviderDriverKind,
  type ProjectCodeKind,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadProjectCode,
} from "@octant/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ComposerNoticeItem } from "../composer/ComposerNotice";
import { OctantButton } from "../ui/base/OctantButton";
import { useThreadNativeSetupServices } from "./ThreadNativeSetupControl";
import { keyProviderLabel } from "./providerSettingsPresentation";

const KIND_WORDS: Readonly<Record<ProjectCodeKind, string>> = {
  settings: "settings",
  "mcp-servers": "MCP servers",
  skills: "skills",
  hooks: "hooks",
  plugins: "plugins",
  tools: "tools",
  agents: "agents",
  commands: "commands",
};

const DISMISSED_KEY = "octant.project-code-strict-prompt.not-now.v1";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function dismissalKey(projectId: ProjectId): string {
  return String(projectId);
}

function readDismissed(): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(entries: ReadonlyArray<string>): void {
  try {
    storage()?.setItem(DISMISSED_KEY, JSON.stringify(entries));
  } catch {
    // A viewer without storage sees the prompt again next time; nothing else depends on it.
  }
}

function listWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

/** "Strict holds this Project's own Claude Code settings and MCP servers until you allow them." */
export function projectTrustSentence(
  provider: KeyProviderDriverKind,
  found: ReadonlyArray<ProjectCodeKind>,
): string {
  return `Strict holds this Project's own ${keyProviderLabel(provider)} ${listWords(found.map((kind) => KIND_WORDS[kind]))} until you allow this Project's code. Its instruction files, such as AGENTS.md, already load.`;
}

/**
 * The one prompt a Strict Work or Code thread shows when its Project holds
 * its key provider's own Project code that the person has not allowed.
 * Adding the Project is already the person's trust decision for every agent
 * (maintainer decision, 2026-11-18), so the host answers untrusted only under
 * Strict, which asks once per Project before code the Project defines can
 * run. Allow lists every key provider under the Project's Trusted providers,
 * with the same command Project settings sends; Not now hides the prompt for
 * this Project in this viewer, and Project settings still offers the list. A
 * window that cannot send the command sees the words without the Allow
 * button, and the host refuses the command from anyone but the host's own
 * person anyway.
 */
export function useProjectTrustNotice(input: {
  readonly mode: "work" | "code";
  readonly threadId: string;
  readonly projectId: ProjectId | undefined;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  /**
   * The thread's Strict as it resolves now. The host's answer depends on it,
   * so a change reads the answer again: turning Strict on must show the
   * prompt a refused Codex start points to, and turning it off must drop it.
   */
  readonly strict: boolean;
}): ComposerNoticeItem | undefined {
  const services = useThreadNativeSetupServices();
  const readProjectCode = services?.readProjectCode;
  const project = services?.projects?.find(
    (candidate) => String(candidate.id) === String(input.projectId),
  );
  const liveTrust = project === undefined || project.type === "chat" ? undefined : project;
  const trustedKinds = liveTrust?.nativeProviders ?? [];
  const trustedKey = trustedKinds.join(",");
  // Kept with the thread and account it answers for, so a thread just opened
  // never shows the previous thread's prompt while its own read is in flight.
  const [read, setRead] = useState<
    { readonly scope: string; readonly projectCode: ThreadProjectCode } | undefined
  >(undefined);
  const [dismissed, setDismissed] = useState<ReadonlyArray<string>>(readDismissed);
  const [pending, setPending] = useState(false);
  const { projectId, providerInstanceId, threadId, mode, strict } = input;
  const scope = `${threadId}:${String(providerInstanceId)}:${strict ? "strict" : "open"}`;

  useEffect(() => {
    if (readProjectCode === undefined || projectId === undefined) return;
    if (providerInstanceId === undefined) return;
    let current = true;
    void readProjectCode(threadId, mode)
      .then((projectCode) => {
        if (current) setRead({ scope, projectCode });
      })
      .catch(() => {
        if (current) setRead({ scope, projectCode: { status: "none" } });
      });
    return () => {
      current = false;
    };
    // The trust list and Strict are read again so a trust given elsewhere, or
    // Strict turned on or off, settles the answer.
  }, [readProjectCode, projectId, providerInstanceId, threadId, mode, scope, trustedKey]);

  const projectCode: ThreadProjectCode =
    read?.scope === scope ? read.projectCode : { status: "none" };
  const setNativeProviders = services?.setProjectNativeProviders;
  const allow = useCallback(async () => {
    if (setNativeProviders === undefined || projectId === undefined) return;
    setPending(true);
    try {
      await setNativeProviders(projectId, KEY_PROVIDER_DRIVER_KINDS);
    } finally {
      setPending(false);
    }
  }, [setNativeProviders, projectId]);

  if (projectId === undefined || projectCode.status !== "untrusted") return undefined;
  if (trustedKinds.includes(projectCode.provider)) return undefined;
  const key = dismissalKey(projectId);
  if (dismissed.includes(key)) return undefined;
  return {
    key: "project-trust",
    tone: "neutral",
    // A quiet offer: it is read where it stands, not announced over the thread.
    role: "status",
    label: "Allow this Project's code",
    text: projectTrustSentence(projectCode.provider, projectCode.found),
    action: (
      <>
        {setNativeProviders === undefined ? null : (
          <OctantButton
            disabled={pending}
            onClick={() => void allow()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Allow Project code
          </OctantButton>
        )}
        <OctantButton
          onClick={() => {
            const next = [...readDismissed().filter((entry) => entry !== key), key];
            writeDismissed(next);
            setDismissed(next);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Not now
        </OctantButton>
      </>
    ),
  };
}
