import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserStep, BrowserThreadId } from "@octant/contracts";
import { browserProofTimeline, browserStepLine, type BrowserProofEntry } from "@octant/domain";
import { useState, type ReactNode } from "react";
import { getInjectedHostBridge, type OctantHostBridge } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { BrowserCaptureImage } from "./BrowserCaptureImage";
import {
  browserProofSaveMessage,
  canSaveBrowserProofScreenshots,
  saveBrowserProofScreenshots,
} from "./browserProofSave";

export interface BrowserProofPanelProps {
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
  readonly steps: ReadonlyArray<BrowserStep>;
  readonly captures: ReadonlyArray<BrowserCapture>;
  readonly className?: string;
  /** The desktop app's bridge; defaults to the one this window was given, if any. */
  readonly hostBridge?: OctantHostBridge | undefined;
}

/**
 * The agent's Browser check as a short numbered list: each step as the agent
 * took it, with every screenshot placed after the step that took it. Shown
 * folded, so a long check does not push the transcript away.
 */
export function BrowserProofPanel(props: BrowserProofPanelProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const bridge = props.hostBridge ?? getInjectedHostBridge();
  const canSave = props.captures.length > 0 && canSaveBrowserProofScreenshots(bridge);
  const entries = browserProofTimeline(props.steps, props.captures);

  const save = async () => {
    setSaving(true);
    setSaved(undefined);
    setFailure(undefined);
    try {
      const result = await saveBrowserProofScreenshots({
        client: props.client,
        threadId: props.threadId,
        captures: props.captures,
        bridge,
      });
      setSaved(browserProofSaveMessage(result));
    } catch (error) {
      setFailure(
        error instanceof Error && error.message.length > 0
          ? error.message
          : "The screenshots could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Browser proof"
      className={
        props.className === undefined ? "browser-proof" : `browser-proof ${props.className}`
      }
      data-testid="browser-proof"
    >
      <h3 className="oct-section-label">Browser proof</h3>
      <div className="browser-proof__bar">
        <OctantButton
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {open
            ? "Hide steps"
            : `Show ${props.steps.length} ${props.steps.length === 1 ? "step" : "steps"}`}
        </OctantButton>
        {canSave ? (
          <OctantButton
            disabled={saving}
            onClick={() => void save()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {saving ? "Saving…" : "Save screenshots…"}
          </OctantButton>
        ) : null}
      </div>
      {saved === undefined ? null : (
        <p className="oct-meta" role="status">
          {saved}
        </p>
      )}
      {failure === undefined ? null : <OctantAlert tone="warning">{failure}</OctantAlert>}
      {open ? (
        <ProofList
          captureImage={(capture) => (
            <BrowserCaptureImage
              capture={capture}
              className="browser-proof__shot"
              client={props.client}
              threadId={props.threadId}
            />
          )}
          entries={entries}
        />
      ) : null}
    </section>
  );
}

function ProofList(props: {
  readonly entries: ReadonlyArray<BrowserProofEntry>;
  readonly captureImage: (capture: BrowserCapture) => ReactNode;
}) {
  const leading: BrowserCapture[] = [];
  const items: Array<{ step: BrowserStep; number: number; captures: BrowserCapture[] }> = [];
  for (const entry of props.entries) {
    if (entry.kind === "step") {
      items.push({ step: entry.step, number: entry.number, captures: [] });
    } else {
      (items.at(-1)?.captures ?? leading).push(entry.capture);
    }
  }
  return (
    <>
      {leading.map((capture) => (
        <figure className="browser-proof__figure" key={capture.captureId}>
          {props.captureImage(capture)}
        </figure>
      ))}
      <ol className="browser-proof__steps">
        {items.map((item) => (
          <li className="browser-proof__step" key={item.step.stepId}>
            <span className={item.step.failure === undefined ? undefined : "browser-proof__failed"}>
              {browserStepLine(item.step)}
            </span>
            {item.step.profile === undefined ? null : (
              <span className="oct-meta">
                {" "}
                · {item.step.profile.kind === "personal" ? "Personal" : "Project"} profile
              </span>
            )}
            {item.captures.map((capture) => (
              <figure className="browser-proof__figure" key={capture.captureId}>
                {props.captureImage(capture)}
              </figure>
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}
