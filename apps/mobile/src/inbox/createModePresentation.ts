import { MOBILE_COPY } from "../copy";

export type MobileCreateMode = "chat" | "work" | "code";

export interface MobileCreateModePresentation {
  readonly description: string;
  readonly placeholder?: string;
  readonly showsComposer: boolean;
}

export function mobileCreateModePresentation(
  mode: MobileCreateMode,
  input: {
    readonly placementLabel?: string | undefined;
    readonly workProjectName?: string | undefined;
    readonly codeProjectName?: string | undefined;
  },
): MobileCreateModePresentation {
  if (mode === "code") {
    const host = input.placementLabel ?? "your selected host";
    const project = input.codeProjectName ?? "a bound repository";
    return {
      description: `Build in ${project} on ${host} · approval gated.`,
      placeholder: MOBILE_COPY.composerCode,
      showsComposer: true,
    };
  }

  const host = input.placementLabel ?? "your selected host";
  if (mode === "work") {
    const project = input.workProjectName ?? "a host project";
    return {
      description: `Work in ${project} on ${host}.`,
      placeholder: MOBILE_COPY.composerWork,
      showsComposer: true,
    };
  }

  return {
    description: `Conversation on ${host}.`,
    placeholder: MOBILE_COPY.composerChat,
    showsComposer: true,
  };
}
