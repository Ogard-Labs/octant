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

const DISMISSED_KEY = "octant.project-trust-prompt.not-now.v1";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function dismissalKey(projectId: ProjectId, provider: KeyProviderDriverKind): string {
  return `${String(projectId)}:${provider}`;
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

/** "This Project has its own Claude Code settings and MCP servers." */
export function projectTrustSentence(
  provider: KeyProviderDriverKind,
  found: ReadonlyArray<ProjectCodeKind>,
): string {
  return `This Project has its own ${keyProviderLabel(provider)} ${listWords(found.map((kind) => KIND_WORDS[kind]))}. They load once you trust this Project for ${keyProviderLabel(provider)}.`;
}

/**
 * The one trust prompt a Work or Code thread shows when its Project holds its
 * key provider's own Project code and the Project does not trust that
 * provider: the person's own setup already loads, and the Project's code
 * waits for one trust per Project and provider (maintainer decision,
 * 2026-11-14). Trust sends the same Project command as Project settings;
 * Not now hides the prompt for this viewer, and Project settings still offers
 * the trust. A window that cannot send the command sees the words without the
 * Trust button, and the host refuses the command from anyone but the host's
 * own person anyway.
 */
export function useProjectTrustNotice(input: {
  readonly mode: "work" | "code";
  readonly threadId: string;
  readonly projectId: ProjectId | undefined;
  readonly providerInstanceId: ProviderInstanceId | undefined;
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
  const { projectId, providerInstanceId, threadId, mode } = input;
  const scope = `${threadId}:${String(providerInstanceId)}`;

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
    // The trust list is read again so a trust given elsewhere settles the answer.
  }, [readProjectCode, projectId, providerInstanceId, threadId, mode, scope, trustedKey]);

  const projectCode: ThreadProjectCode =
    read?.scope === scope ? read.projectCode : { status: "none" };
  const setNativeProviders = services?.setProjectNativeProviders;
  const provider = projectCode.status === "none" ? undefined : projectCode.provider;
  const trust = useCallback(async () => {
    if (setNativeProviders === undefined || provider === undefined) return;
    if (projectId === undefined) return;
    const next = new Set<KeyProviderDriverKind>([...trustedKinds, provider]);
    setPending(true);
    try {
      await setNativeProviders(
        projectId,
        KEY_PROVIDER_DRIVER_KINDS.filter((kind) => next.has(kind)),
      );
    } finally {
      setPending(false);
    }
  }, [setNativeProviders, provider, trustedKinds, projectId]);

  if (projectId === undefined || projectCode.status !== "untrusted") return undefined;
  if (trustedKinds.includes(projectCode.provider)) return undefined;
  const key = dismissalKey(projectId, projectCode.provider);
  if (dismissed.includes(key)) return undefined;
  const name = keyProviderLabel(projectCode.provider);
  return {
    key: "project-trust",
    tone: "neutral",
    // A quiet offer: it is read where it stands, not announced over the thread.
    role: "status",
    label: `Trust this Project for ${name}`,
    text: projectTrustSentence(projectCode.provider, projectCode.found),
    action: (
      <>
        {setNativeProviders === undefined ? null : (
          <OctantButton
            disabled={pending}
            onClick={() => void trust()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Trust for {name}
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
