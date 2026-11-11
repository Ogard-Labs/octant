import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ConversationInputPolicy } from "@octant/contracts/conversation-inputs";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import type { RemoteAccessAdministrationBridge } from "../shell/hostBridge";
import { providerModelLabel } from "../providers/providerModelLabel";
import { ModelPicker } from "../providers/ModelPicker";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { continuationLink } from "./continuationLink";
import "../styles/conversation-inputs.css";

export const ContinuityScreenContext = createContext<{
  readonly hostLabel?: string;
  readonly screenLabel?: string;
  readonly origin?: string;
  readonly bridge?: Pick<
    RemoteAccessAdministrationBridge,
    "getPrivateListenerStatus" | "getRemoteDeviceInventory"
  >;
}>({});

export function ContinueElsewhere(props: {
  readonly mode: "chat" | "work" | "code";
  readonly threadId: string;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selected: Pick<ModelPickerSelection, "providerInstanceId" | "modelId">;
  readonly disabled?: boolean;
  readonly policy: ConversationInputPolicy;
  readonly onPolicyChange: (policy: ConversationInputPolicy) => void;
  readonly onProviderChange: (selection: ModelPickerSelection) => void | Promise<void>;
}) {
  const screen = useContext(ContinuityScreenContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [screens, setScreens] = useState<ReadonlyArray<string>>([]);
  const [origin, setOrigin] = useState(screen.origin);
  const [source, setSource] = useState("");
  const [destinationScreen, setDestinationScreen] = useState<string>();
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
    setNotice(undefined);
  }, [props.mode, props.threadId]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOrigin(screen.origin);
    setScreens([]);
    if (screen.bridge !== undefined)
      void Promise.all([
        screen.bridge.getPrivateListenerStatus(),
        screen.bridge.getRemoteDeviceInventory(),
      ])
        .then(([listener, devices]) => {
          if (cancelled) return;
          setScreens(
            devices
              .filter((device) => device.state === "active")
              .map((device) => device.deviceLabel),
          );
          if (
            listener.state === "ready" &&
            listener.certificateSource === "pasted" &&
            listener.origin !== null
          )
            setOrigin(listener.origin);
        })
        .catch(() => {
          if (!cancelled)
            setNotice("Paired screens could not be read. The provider choice remains available.");
        });
    return () => {
      cancelled = true;
    };
  }, [open, screen.bridge, screen.origin]);
  const link =
    origin === undefined ? undefined : continuationLink(origin, props.mode, props.threadId);
  async function copyTaskLink(destination: string) {
    if (link === undefined || navigator.clipboard === undefined) {
      setNotice(
        "The link could not be copied. Use the task link or select the task in the paired app.",
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setDestinationScreen(destination);
      setNotice(
        `Task link copied for ${destination}. Open it there; execution remains on this host and no writer was cloned.`,
      );
    } catch {
      setNotice("The link could not be copied. Use the task link above.");
    }
  }
  return (
    <>
      <OctantButton
        ref={opener}
        variant="ghost"
        size="sm"
        disabled={props.disabled}
        onClick={() => {
          setSource(providerModelLabel(props.groups, props.selected));
          setDestinationScreen(undefined);
          setNotice(undefined);
          setOpen(true);
        }}
      >
        <span>Continue elsewhere</span>
        {props.policy === "text-only" ? (
          <span className="thread-info__value">Text only</span>
        ) : null}
      </OctantButton>
      <OctantDialog
        label="Continue elsewhere"
        open={open}
        onClose={() => setOpen(false)}
        restoreFocus={opener}
        className="continuation-dialog"
      >
        <h2>Continue elsewhere</h2>
        <dl>
          <dt>Execution host</dt>
          <dd>{screen.hostLabel ?? "Current host"}</dd>
          <dt>Controlling screen</dt>
          <dd>{screen.screenLabel ?? "This screen"}</dd>
          <dt>Source provider</dt>
          <dd>{source}</dd>
          <dt>Destination provider</dt>
          <dd>{providerModelLabel(props.groups, props.selected)}</dd>
        </dl>
        <p>
          The same task keeps its conversation, task state, checkout and pending feedback on this
          host. Nothing sends automatically.
        </p>
        <h3>Another provider</h3>
        <p>
          The next turn uses the existing handoff path. Original inputs are checked before sending;
          unsupported native continuity starts a disclosed handoff. Hidden reasoning and native
          writer identity do not move to another provider.
        </p>
        <div
          role="group"
          aria-label="Original inputs for next continuation"
          className="continuation-dialog__input-choice"
        >
          <OctantButton
            variant={props.policy === "preserve" ? "secondary" : "ghost"}
            aria-pressed={props.policy === "preserve"}
            onClick={() => props.onPolicyChange("preserve")}
          >
            Preserve original files and images
          </OctantButton>
          <OctantButton
            variant={props.policy === "text-only" ? "secondary" : "ghost"}
            aria-pressed={props.policy === "text-only"}
            onClick={() => props.onPolicyChange("text-only")}
          >
            Text only: omit files and images
          </OctantButton>
        </div>
        <p>
          {props.policy === "text-only"
            ? "Omitted on the next continuation: original files and images, by your explicit text-only choice."
            : "Original files and images are preserved. A missing or unsupported input refuses the turn before sending."}
        </p>
        <ModelPicker
          groups={props.groups}
          selectedProviderInstanceId={props.selected.providerInstanceId}
          selectedModelId={props.selected.modelId}
          disabled={busy || props.disabled === true}
          onSelect={(selection) => {
            setBusy(true);
            void Promise.resolve(props.onProviderChange(selection))
              .then(() =>
                setNotice(
                  "Provider selection requested. Review the current destination in the composer; your draft remains unsent.",
                ),
              )
              .catch(() =>
                setNotice("The provider change was refused. Your draft and inputs are kept."),
              )
              .finally(() => setBusy(false));
          }}
        />
        <h3>Another screen, same host</h3>
        {destinationScreen === undefined ? null : (
          <p>
            Destination screen: {destinationScreen}. Execution host:{" "}
            {screen.hostLabel ?? "Current host"}.
          </p>
        )}
        <p>
          Open this exact task from an already paired screen. Execution and the native writer stay
          on this host. Unsent drafts and local view state stay on this screen; host-held inputs and
          pending feedback remain with the task.
        </p>
        {screens.length === 0 ? (
          <p>No paired screens are listed here.</p>
        ) : (
          <ul>
            {screens.map((label, index) => (
              <li key={`${label}:${index}`}>
                {label} · paired{" "}
                <OctantButton
                  variant="ghost"
                  size="sm"
                  disabled={link === undefined}
                  onClick={() => void copyTaskLink(label)}
                >
                  Copy task link for {label}
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
        {link === undefined ? (
          <p>
            A browser task link is unavailable for this connection. Use the existing paired app and
            select this {props.mode} task: {props.threadId}.
          </p>
        ) : (
          <>
            <a className="continuation-dialog__link" href={link} target="_blank" rel="noreferrer">
              Open task link
            </a>
            <OctantButton
              variant="secondary"
              size="sm"
              onClick={() => void copyTaskLink("another paired screen")}
            >
              Copy task link
            </OctantButton>
          </>
        )}
        {notice === undefined ? null : <p role="status">{notice}</p>}
        <OctantButton variant="outline" onClick={() => setOpen(false)}>
          Close
        </OctantButton>
      </OctantDialog>
    </>
  );
}
