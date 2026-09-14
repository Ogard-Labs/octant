import { WebContentsView, type BrowserWindow } from "electron";
import type { CodeOperationApprovalViewPort } from "./codeOperationApprovalView";

export function createNativeCodeApprovalViewHost(
  preload: string,
  onDestroyed: (id: number) => void,
) {
  const nativeViews = new WeakMap<CodeOperationApprovalViewPort, WebContentsView>();
  function createCodeApprovalView(token: string): CodeOperationApprovalViewPort {
    const view = new WebContentsView({
      webPreferences: {
        additionalArguments: [`--octant-code-approval-token=${token}`],
        contextIsolation: true,
        nodeIntegration: false,
        preload,
        sandbox: true,
        webSecurity: true,
      },
    });
    const contents = view.webContents;
    const id = contents.id;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("data:text/html")) event.preventDefault();
    });
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("destroyed", () => {
      onDestroyed(id);
    });
    const port: CodeOperationApprovalViewPort = {
      webContents: {
        id,
        loadURL: (url) => contents.loadURL(url),
        send: (channel, value) => contents.send(channel, value),
        close: () => contents.close(),
        isDestroyed: () => contents.isDestroyed(),
      },
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (visible) => view.setVisible(visible),
    };
    nativeViews.set(port, view);
    return port;
  }

  function nativeView(port: CodeOperationApprovalViewPort): WebContentsView {
    const view = nativeViews.get(port);
    if (view === undefined) throw new Error("Code approval view does not belong to this host.");
    return view;
  }
  return {
    createView: createCodeApprovalView,
    attach: (
      window: {
        readonly contentView: Pick<
          BrowserWindow["contentView"],
          "addChildView" | "removeChildView"
        >;
      },
      view: CodeOperationApprovalViewPort,
    ) => window.contentView.addChildView(nativeView(view)),
    detach: (
      window: {
        readonly contentView: Pick<
          BrowserWindow["contentView"],
          "addChildView" | "removeChildView"
        >;
      },
      view: CodeOperationApprovalViewPort,
    ) => window.contentView.removeChildView(nativeView(view)),
  };
}
