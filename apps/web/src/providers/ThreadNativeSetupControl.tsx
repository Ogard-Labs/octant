import {
  KEY_PROVIDER_DRIVER_KINDS,
  type ProviderInstanceId,
  type ProviderInstance,
  type ThreadNativeSetupChoice,
} from "@octant/contracts";
import { ChevronDown, Blocks } from "lucide-react";
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";

/** What the control needs from the host: the choice per thread, and the accounts that can have one. */
export interface ThreadNativeSetupServices {
  readonly instances: ReadonlyArray<Pick<ProviderInstance, "id" | "driverKind">>;
  readonly read: (threadId: string) => Promise<ThreadNativeSetupChoice>;
  readonly change: (
    threadId: string,
    providerInstanceId: ProviderInstanceId,
    choice: ThreadNativeSetupChoice,
  ) => Promise<ThreadNativeSetupChoice>;
}

const ThreadNativeSetupContext = createContext<ThreadNativeSetupServices | undefined>(undefined);

export function ThreadNativeSetupProvider(props: {
  readonly services: ThreadNativeSetupServices | undefined;
  readonly children: ReactNode;
}) {
  return (
    <ThreadNativeSetupContext.Provider value={props.services}>
      {props.children}
    </ThreadNativeSetupContext.Provider>
  );
}

const OPTIONS: ReadonlyArray<{
  readonly id: ThreadNativeSetupChoice;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    id: "inherit",
    label: "Account default",
    detail: "Follows this account’s switch, the Project’s trust, and the thread’s level.",
  },
  {
    id: "on",
    label: "On",
    detail: "Loads the provider’s own subagents, web tools, skills, and tool servers here.",
  },
  {
    id: "off",
    label: "Off",
    detail: "Loads none of the provider’s own setup in this thread, even at Full access.",
  },
];

const DEFAULT_OPTION = OPTIONS[0] ?? {
  id: "inherit" as const,
  label: "Account default",
  detail: "",
};

/**
 * Turns a key provider's own setup on or off for one thread, or leaves it to
 * the account. Shown only where the host allows the change: a window on this
 * host, for a thread whose provider is one of the four key providers. The
 * choice takes effect on the thread's next turn.
 */
export function ThreadNativeSetupControl(props: {
  readonly threadId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly disabled?: boolean;
}) {
  const services = useContext(ThreadNativeSetupContext);
  const idPrefix = useId();
  const [choice, setChoice] = useState<ThreadNativeSetupChoice>("inherit");
  const eligible =
    services?.instances.some(
      (instance) =>
        instance.id === props.providerInstanceId &&
        (KEY_PROVIDER_DRIVER_KINDS as ReadonlyArray<string>).includes(instance.driverKind),
    ) === true;
  useEffect(() => {
    if (services === undefined || !eligible) return;
    let current = true;
    void services
      .read(props.threadId)
      .then((read) => {
        if (current) setChoice(read);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [services, eligible, props.threadId]);
  if (services === undefined || !eligible) return null;
  const selected = OPTIONS.find((option) => option.id === choice) ?? DEFAULT_OPTION;
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label="Provider’s own setup"
        aria-description={selected.detail}
        className="code-composer-choice__trigger"
        disabled={props.disabled === true}
        render={<OctantButton size="sm" variant="ghost" />}
        title={selected.detail}
      >
        <Blocks aria-hidden="true" />
        <span>
          {choice === "inherit" ? "Own setup" : `Own setup ${selected.label.toLowerCase()}`}
        </span>
        <ChevronDown aria-hidden="true" />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner side="top">
          <OctantMenuPopup>
            <OctantMenuRadioGroup
              value={choice}
              onValueChange={(value) => {
                const next = OPTIONS.find((option) => option.id === value);
                if (next === undefined || next.id === choice) return;
                void services
                  .change(props.threadId, props.providerInstanceId, next.id)
                  .then(setChoice)
                  .catch(() => undefined);
              }}
            >
              {OPTIONS.map((option) => (
                <OctantMenuRadioItem
                  aria-describedby={`${idPrefix}-${option.id}-note`}
                  aria-labelledby={`${idPrefix}-${option.id}-label`}
                  closeOnClick
                  key={option.id}
                  value={option.id}
                >
                  <span className="flex min-w-0 flex-col">
                    <span id={`${idPrefix}-${option.id}-label`}>{option.label}</span>
                    <span
                      className="text-xs text-muted-foreground"
                      id={`${idPrefix}-${option.id}-note`}
                    >
                      {option.detail}
                    </span>
                  </span>
                </OctantMenuRadioItem>
              ))}
            </OctantMenuRadioGroup>
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}
