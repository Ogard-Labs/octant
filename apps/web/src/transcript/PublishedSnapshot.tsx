import type { ThreadPublishedPage } from "@octant/contracts";
import { importCanvasHtmlPage } from "@octant/domain";
import { useMemo } from "react";
import { DesignBlock } from "../canvas/blocks/DesignBlock";
import type { DesignRunRuntime } from "../canvas/blocks/designRunningFrame";
import { ChatRichText } from "../chat/ChatRichText";

type Snapshot = NonNullable<ThreadPublishedPage["snapshot"]>;

/**
 * What a published page held when the person approved publishing it: the
 * host's snapshot of the Project file, drawn here so the thread shows it
 * without Octant ever fetching or framing the live page. An HTML page goes
 * through the same importer and design policy as an HTML page brought into a
 * Canvas: nothing it would load is drawn, and a page that runs script waits
 * for Run in the running tier's sandbox. Markdown is read as Markdown. Edits
 * made on the service afterwards never reach it, so it says so.
 */
export function PublishedSnapshot(props: {
  readonly snapshot: Snapshot;
  readonly title: string;
  readonly runRuntime?: DesignRunRuntime;
}) {
  return (
    <section aria-label={`Snapshot of ${props.title}`} className="published-snapshot">
      <p className="published-snapshot__label">
        Published snapshot · as it was when published; later edits on claude.ai are not shown.
      </p>
      {props.snapshot.format === "markdown" ? (
        <div className="published-snapshot__markdown">
          <ChatRichText body={props.snapshot.content} />
        </div>
      ) : (
        <HtmlSnapshot
          content={props.snapshot.content}
          title={props.title}
          {...(props.runRuntime === undefined ? {} : { runRuntime: props.runRuntime })}
        />
      )}
    </section>
  );
}

function HtmlSnapshot(props: {
  readonly content: string;
  readonly title: string;
  readonly runRuntime?: DesignRunRuntime;
}) {
  const imported = useMemo(
    () => importCanvasHtmlPage(props.content, { title: props.title }),
    [props.content, props.title],
  );
  if (imported.status === "refused") {
    return <p className="published-snapshot__note">{imported.message}</p>;
  }
  return (
    <DesignBlock
      block={imported.block}
      {...(props.runRuntime === undefined ? {} : { runRuntime: props.runRuntime })}
    />
  );
}
