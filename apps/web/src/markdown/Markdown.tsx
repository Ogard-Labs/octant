import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "../transcript/CodeBlock";
import { AppWindow, ExternalLink, Link2 } from "lucide-react";
import {
  OctantContextMenuContent,
  OctantContextMenuItem,
  OctantContextMenuRoot,
  OctantContextMenuTrigger,
} from "../ui/base/OctantContextMenu";

/**
 * Transforms a run of plain text into nodes. The renderer applies it to text
 * that sits directly inside a block or an emphasis, and nowhere else — a URL
 * or a code span is not prose and must survive verbatim.
 */
export type MarkdownTextTransform = (text: string) => ReactNode;

export interface MarkdownProps {
  readonly body: string;
  readonly className?: string;
  /** Hide unsupported GitHub HTML instead of showing its source in a review. */
  readonly skipHtml?: boolean;
  readonly transformText?: MarkdownTextTransform;
}

/*
 * The transform reaches the parts through context rather than a closure,
 * because the component map has to be built once. Rebuilding it per render
 * gives every part a new function identity, which React reads as a different
 * component type: it then unmounts the old nodes and mounts new ones on every
 * render, silently dropping the text selection, focus, and scroll position
 * that pointed at them.
 */
const TextTransform = createContext<MarkdownTextTransform | undefined>(undefined);

/**
 * What a link inside rendered Markdown can do beyond opening externally. The
 * shell provides it: a thread surface offers an in-app Browser open bound to
 * its own thread, and every surface offers the host's external open. With no
 * provider the anchor still copies its URL and opens in a browser tab.
 */
export interface MarkdownLinkActions {
  readonly openInApp?: (url: string) => void;
  readonly openExternal: (url: string) => void;
}

export const MarkdownLinkActionsContext = createContext<MarkdownLinkActions | undefined>(undefined);

/**
 * The one Markdown renderer. Two hand-written parsers stood here before, each
 * supporting a different subset — one had lists, quotes and links but no
 * italics, the other had italics but none of those — so the same document read
 * differently depending on which surface showed it.
 *
 * Raw HTML is not rendered: `react-markdown` ignores it unless a rehype plugin
 * puts it back, and none is added here. That matters because most of what this
 * renders is model output.
 *
 * Memoized on its props because `react-markdown` parses `body` on every
 * render, and a streaming reply re-renders every earlier reply in the thread
 * once per text delta. `body` compares by value, so a finished reply keeps its
 * parse as long as the caller hands it a stable `transformText`.
 */
export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return (
    <div className={props.className}>
      <TextTransform value={props.transformText}>
        <ReactMarkdown
          components={components}
          skipHtml={props.skipHtml}
          remarkPlugins={remarkPlugins}
          urlTransform={onlyHttpUrls}
        >
          {props.body}
        </ReactMarkdown>
      </TextTransform>
    </div>
  );
});

const remarkPlugins = [remarkGfm];

/**
 * Applies the transform to this part's own text and leaves everything else
 * alone. Nested emphasis and list items reach their own part, so each handles
 * the text it directly owns and the recursion falls out of the component tree.
 */
function useProse(children: ReactNode): ReactNode {
  const transform = useContext(TextTransform);
  if (transform === undefined) return children;
  return Children.map(children, (child) => (typeof child === "string" ? transform(child) : child));
}

function Prose(props: { readonly children: ReactNode }) {
  return <>{useProse(props.children)}</>;
}

const components: Components = {
  // A fenced block always arrives wrapped in `pre`, which is how it is told
  // apart from an inline span without guessing from the class or a newline.
  pre: ({ children }) => {
    const fence = Children.toArray(children).find(isValidElement);
    const fenceProps = (fence?.props ?? {}) as {
      readonly className?: string;
      readonly children?: ReactNode;
    };
    const language = /language-([\w-]+)/.exec(fenceProps.className ?? "")?.[1];
    const code = collectText(fenceProps.children).replace(/\n$/, "");
    return <CodeBlock code={code} {...(language === undefined ? {} : { language })} />;
  },
  code: ({ children }) => <code>{children}</code>,
  // An image is named, never fetched. `![](https://…)` in model output or in an
  // agent-written document would otherwise reach that host the moment the text
  // rendered, with no one having clicked anything — and the URL itself carries
  // whatever the author put in it. Neither parser this replaced could render an
  // image at all, so loading one is not a behaviour anything here relies on.
  img: ({ alt, src }) => (
    <span className="markdown-image" title={typeof src === "string" ? src : undefined}>
      {alt === undefined || alt === "" ? "Image" : alt}
    </span>
  ),
  a: ({ href, children }) =>
    href === undefined || href === "" ? (
      <>{children}</>
    ) : (
      <MarkdownLink href={href}>{children}</MarkdownLink>
    ),
  p: ({ children }) => (
    <p>
      <Prose>{children}</Prose>
    </p>
  ),
  li: ({ children }) => (
    <li>
      <Prose>{children}</Prose>
    </li>
  ),
  h1: ({ children }) => (
    <h2>
      <Prose>{children}</Prose>
    </h2>
  ),
  h2: ({ children }) => (
    <h2>
      <Prose>{children}</Prose>
    </h2>
  ),
  h3: ({ children }) => (
    <h3>
      <Prose>{children}</Prose>
    </h3>
  ),
  h4: ({ children }) => (
    <h4>
      <Prose>{children}</Prose>
    </h4>
  ),
  h5: ({ children }) => (
    <h4>
      <Prose>{children}</Prose>
    </h4>
  ),
  h6: ({ children }) => (
    <h4>
      <Prose>{children}</Prose>
    </h4>
  ),
  strong: ({ children }) => (
    <strong>
      <Prose>{children}</Prose>
    </strong>
  ),
  em: ({ children }) => (
    <em>
      <Prose>{children}</Prose>
    </em>
  ),
  del: ({ children }) => (
    <del>
      <Prose>{children}</Prose>
    </del>
  ),
  td: ({ children }) => (
    <td>
      <Prose>{children}</Prose>
    </td>
  ),
  th: ({ children }) => (
    <th>
      <Prose>{children}</Prose>
    </th>
  ),
};

function collectText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string") return child;
      if (typeof child === "number") return String(child);
      if (isValidElement(child)) {
        return collectText((child.props as { readonly children?: ReactNode }).children);
      }
      return "";
    })
    .join("");
}

/**
 * Links reach the page only as `http` or `https`. Anything else — `javascript:`
 * most of all, but equally a `file:` path a model invented — renders as its own
 * text, with no anchor around it.
 */
function onlyHttpUrls(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

/**
 * A rendered link. The desktop shell refuses every popup the renderer asks
 * for, so a bare target=_blank anchor is inert there: activation goes through
 * the pane's link actions — the in-app Browser when the surface can host one,
 * the host's external open otherwise. Right-click offers both plus the URL
 * itself, because a link the agent wrote is also a thing the person copies.
 */
function MarkdownLink(props: { readonly href: string; readonly children: ReactNode }) {
  const actions = useContext(MarkdownLinkActionsContext);
  const [open, setOpen] = useState(false);
  const openExternal = () => {
    if (actions?.openExternal !== undefined) {
      actions.openExternal(props.href);
      return;
    }
    globalThis.open?.(props.href, "_blank", "noopener,noreferrer");
  };
  const copyUrl = () => {
    const writeText = globalThis.navigator?.clipboard?.writeText;
    if (writeText === undefined) return;
    void writeText.call(globalThis.navigator.clipboard, props.href).catch(() => undefined);
  };
  const anchor = (
    <a
      href={props.href}
      onClick={(event) => {
        event.preventDefault();
        if (actions?.openInApp !== undefined) {
          actions.openInApp(props.href);
          return;
        }
        openExternal();
      }}
      rel="noreferrer"
      target="_blank"
    >
      {props.children}
    </a>
  );
  return (
    <OctantContextMenuRoot onOpenChange={setOpen}>
      <OctantContextMenuTrigger
        aria-expanded={open}
        aria-haspopup="menu"
        className="window-no-drag"
        render={anchor}
      />
      <OctantContextMenuContent>
        <OctantContextMenuItem
          className="gap-2"
          closeOnClick
          disabled={actions?.openInApp === undefined}
          label="Open in Octant"
          onClick={() => actions?.openInApp?.(props.href)}
        >
          <span aria-hidden="true" className="flex size-4 items-center justify-center">
            <AppWindow size={14} />
          </span>
          <span className="flex min-w-0 flex-1">Open in Octant</span>
        </OctantContextMenuItem>
        <OctantContextMenuItem
          className="gap-2"
          closeOnClick
          label="Open in external browser"
          onClick={openExternal}
        >
          <span aria-hidden="true" className="flex size-4 items-center justify-center">
            <ExternalLink size={14} />
          </span>
          <span className="flex min-w-0 flex-1">Open in external browser</span>
        </OctantContextMenuItem>
        <OctantContextMenuItem className="gap-2" closeOnClick label="Copy URL" onClick={copyUrl}>
          <span aria-hidden="true" className="flex size-4 items-center justify-center">
            <Link2 size={14} />
          </span>
          <span className="flex min-w-0 flex-1">Copy URL</span>
        </OctantContextMenuItem>
      </OctantContextMenuContent>
    </OctantContextMenuRoot>
  );
}
