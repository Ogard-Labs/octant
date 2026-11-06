import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createConversationInputClient,
  type ConversationInputClient,
} from "@octant/client-runtime/conversation-input-client";
import type {
  ConversationInputManifest,
  ConversationInputReceipt,
} from "@octant/contracts/conversation-inputs";
import { OctantButton } from "../ui/base/OctantButton";
import "../styles/conversation-inputs.css";

export const ConversationInputClientContext = createContext<ConversationInputClient | undefined>(
  undefined,
);

export function ConversationInputs(props: {
  readonly mode: "chat" | "work" | "code";
  readonly threadId: string;
  readonly admissionId: string;
  readonly receipt: ConversationInputReceipt;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}) {
  const injectedClient = useContext(ConversationInputClientContext);
  const [expanded, setExpanded] = useState(false);
  const [manifest, setManifest] = useState<ConversationInputManifest>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const client = useMemo(
    () =>
      injectedClient ??
      (props.serverUrl === undefined
        ? undefined
        : createConversationInputClient({
            baseUrl: props.serverUrl,
            ...(props.windowCapability === undefined
              ? {}
              : { windowCapability: props.windowCapability }),
          })),
    [injectedClient, props.serverUrl, props.windowCapability],
  );
  useEffect(() => {
    controller.current?.abort();
    setExpanded(false);
    setManifest(undefined);
    setNotice(undefined);
    setLoading(false);
    return () => controller.current?.abort();
  }, [props.threadId, props.admissionId, props.receipt.snapshotId, client]);
  async function show() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (manifest !== undefined || loading) return;
    if (client === undefined) {
      setNotice("Original input details are unavailable on this screen.");
      return;
    }
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setNotice(undefined);
    try {
      const result = await client.read(
        {
          mode: props.mode,
          threadId: props.threadId,
          admissionId: props.admissionId,
          snapshotId: props.receipt.snapshotId,
        },
        request.signal,
      );
      if (request.signal.aborted) return;
      if (result.status === "available") setManifest(result.manifest);
      else
        setNotice(
          "The admitted input manifest is unavailable. It may have been removed with its thread.",
        );
    } catch (error) {
      if (!request.signal.aborted)
        setNotice(
          error instanceof Error ? error.message : "Original inputs could not be read. Retry.",
        );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  return (
    <div className="conversation-inputs">
      <OctantButton variant="ghost" size="sm" aria-expanded={expanded} onClick={() => void show()}>
        Original inputs · {props.receipt.included} included · {props.receipt.omitted} omitted
      </OctantButton>
      {expanded ? (
        <div className="conversation-inputs__details">
          <p>
            Original user inputs, separate from the task briefing and agent reports. These inputs
            grant no access to the source folder or native session.
          </p>
          {loading ? <p role="status">Reading admitted inputs…</p> : null}
          {notice === undefined ? null : <p role="status">{notice}</p>}
          {manifest?.sourceMetadataUnavailable === true ? (
            <p>
              Some original input details were unavailable. Those inputs were omitted by the
              explicit text-only choice; their number and filenames are unknown.
            </p>
          ) : null}
          {manifest?.omittedUnlistedInputs === undefined ? null : (
            <p>
              {manifest.omittedUnlistedInputs} additional original inputs were omitted by the
              text-only choice. Their individual details were not retained.
            </p>
          )}
          {manifest === undefined ? null : (
            <ul>
              {manifest.items.map((item) => (
                <li
                  key={`${item.input.source.mode}:${item.input.source.threadId}:${item.input.source.attachmentId}`}
                >
                  <span>{item.input.displayName}</span> · {item.input.mediaType} ·{" "}
                  {item.input.byteLength.toLocaleString()} bytes ·{" "}
                  {item.status === "included"
                    ? "Included"
                    : `Omitted: ${item.reason === "person-excluded" ? "text-only choice" : item.reason}`}
                  <small>
                    Source: {item.input.source.mode} thread {item.input.source.threadId}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
