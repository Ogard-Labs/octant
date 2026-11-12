import { ComputerUseSetup, type ComputerUseSetupProps } from "../settings/ComputerUseSetup";
import { useComputerUseSetup, type ComputerBridge } from "../settings/useComputerUseSetup";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import type { PersonMemoryClient } from "@octant/client-runtime/person-memory-client";
import { type ComputerUseSettings } from "@octant/contracts/computer-use-plugin";
import type { AgentRunCreationPosture, SettingsDeepLink } from "@octant/contracts";
import { Brain, ChevronDown, Globe2, Monitor, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantCard,
  OctantCardContent,
  OctantCardHeader,
  OctantCardTitle,
} from "../ui/base/OctantCard";

export interface FirstTaskCapabilitiesProps {
  readonly browser: "supported" | "unsupported" | "unknown";
  readonly computerUse: ComputerUseSettings | undefined;
  readonly helpers: Pick<AgentRunSettingsClient, "current">;
  readonly memory: Pick<PersonMemoryClient, "read">;
  readonly bridge?: ComputerBridge;
  readonly onSettingsChange?: ComputerUseSetupProps["onSettingsChange"];
  readonly onOpenSettings?: (target: SettingsDeepLink) => void;
  readonly onDismiss: () => void;
}

export function FirstTaskCapabilities(props: FirstTaskCapabilitiesProps) {
  const setup = useComputerUseSetup(props.bridge, props.computerUse?.enabled ?? false);
  const [expanded, setExpanded] = useState<string | undefined>(
    props.computerUse?.setupPending ? "Computer use" : undefined,
  );
  const [read, setRead] = useState<{
    readonly memory: FirstTaskCapabilitiesProps["memory"];
    readonly helpers: FirstTaskCapabilitiesProps["helpers"];
    readonly bridge: FirstTaskCapabilitiesProps["bridge"];
    readonly memoryEnabled: boolean | undefined;
    readonly helperPosture: AgentRunCreationPosture | undefined;
  }>();
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    void Promise.allSettled([props.memory.read(abort.signal), props.helpers.current()]).then(
      ([memory, helpers]) => {
        if (!active) return;
        setRead({
          memory: props.memory,
          helpers: props.helpers,
          bridge: props.bridge,
          memoryEnabled: memory.status === "fulfilled" ? memory.value.settings.enabled : undefined,
          helperPosture: helpers.status === "fulfilled" ? helpers.value.creationPosture : undefined,
        });
      },
    );
    return () => {
      active = false;
      abort.abort();
    };
  }, [props.memory, props.helpers, props.bridge]);
  const current =
    read?.memory === props.memory && read.helpers === props.helpers && read.bridge === props.bridge
      ? read
      : undefined;
  const computer = setup.status;
  const computerEnabled = props.computerUse?.enabled ?? computer?.enabled;
  const computerState =
    computerEnabled === false
      ? "Off"
      : computer?.supported === false
        ? "Unavailable on this host"
        : computerEnabled === undefined
          ? "Not reported"
          : computer === undefined
            ? "On · Desktop availability not reported"
            : !computer.permissions.accessibility || !computer.permissions.screenRecording
              ? "On · Permissions needed"
              : computer.driver === "unavailable" || computer.driver === "failed"
                ? "On · Driver unavailable"
                : computer.verification === "passed" && computer.driver === "ready"
                  ? "Verified working · Each app still asks"
                  : "On · Not tested";
  const capabilities = [
    {
      title: "Browser",
      Icon: Globe2,
      state:
        props.browser === "supported"
          ? "Provider supports Browser tools"
          : props.browser === "unsupported"
            ? "Provider has no supported Browser transport"
            : "Not reported",
      description:
        "Read and interact with pages in the task's isolated Browser. Site approvals still apply.",
      preview: "Read a page → Summarize the findings",
      settings: { section: "providers" },
      action: "Review Browser provider",
    },
    {
      title: "Computer use",
      Icon: Monitor,
      state: computerState,
      description:
        "Work with supported apps when the task needs them. Enabling this does not approve an app or install a driver.",
      preview: "Find a control → Click and check the result",
      settings: { section: "computer-use", setting: "computer-use-enabled" },
      action: "Review computer use settings",
    },
    {
      title: "Helper agents",
      Icon: Users,
      state:
        current?.helperPosture === "automatic"
          ? "Automatic · Within host limits"
          : current?.helperPosture === "off"
            ? "Off"
            : current?.helperPosture === "ask"
              ? "Ask first"
              : "Not reported",
      description:
        "The task's agent can delegate bounded work when its provider and current policy allow it.",
      preview: "Main task → Research helper → Findings",
      settings: { section: "harness", setting: "subagent-creation-posture" },
      action: "Review helper agent settings",
    },
    {
      title: "Person memory",
      Icon: Brain,
      state:
        current?.memoryEnabled === true
          ? "On · Stored on this computer"
          : current?.memoryEnabled === false
            ? "Off"
            : "Not reported",
      description:
        "Carry preferences and earlier work into future threads. Review what is kept and which Projects are excluded.",
      preview: "A saved preference → A future thread",
      settings: { section: "memory", setting: "person-memory" },
      action: "Review memory settings",
    },
  ] as const;
  return (
    <OctantCard aria-label="Explore capabilities" className="first-run__capabilities">
      <OctantCardHeader>
        <OctantCardTitle>Explore capabilities</OctantCardTitle>
        <p className="text-sm text-muted-foreground">
          Optional. These are current settings, not new permissions. You can start a task without
          changing them.
        </p>
      </OctantCardHeader>
      <OctantCardContent className="grid min-w-0 gap-4">
        {capabilities.map(({ title, Icon, state, description, preview, settings, action }) => (
          <section key={title} className="flex min-w-0 flex-col gap-2">
            <h3 className="first-run__capability-title">
              <OctantButton
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={expanded === title}
                onClick={() => setExpanded((current) => (current === title ? undefined : title))}
              >
                <Icon aria-hidden="true" size={16} />
                {title}
                <ChevronDown aria-hidden="true" size={12} />
              </OctantButton>
            </h3>
            <p aria-label={`${title} status`} className="text-xs text-muted-foreground">
              {state}
            </p>
            {expanded !== title ? null : (
              <>
                <p className="text-sm">{description}</p>
                {title === "Computer use" &&
                props.onSettingsChange !== undefined &&
                props.computerUse !== undefined ? (
                  <ComputerUseSetup
                    setup={setup}
                    settings={props.computerUse}
                    onSettingsChange={props.onSettingsChange}
                    bridge={props.bridge}
                  />
                ) : (
                  <figure className="rounded-md border border-border p-2">
                    <div role="img" aria-label={`Static ${title} preview`} className="text-xs">
                      {preview}
                    </div>
                    <figcaption className="mt-2 text-xs text-muted-foreground">
                      Example only
                    </figcaption>
                  </figure>
                )}
                {props.onOpenSettings === undefined ? null : (
                  <OctantButton
                    type="button"
                    size="sm"
                    variant="link"
                    onClick={() => props.onOpenSettings?.(settings)}
                  >
                    {action}
                  </OctantButton>
                )}
              </>
            )}
          </section>
        ))}
        <p className="text-xs text-muted-foreground">
          Nothing runs in these previews. Installation, package trust and task access remain
          separate.
        </p>
        <OctantButton type="button" size="sm" variant="ghost" onClick={props.onDismiss}>
          Dismiss capability card
        </OctantButton>
      </OctantCardContent>
    </OctantCard>
  );
}
