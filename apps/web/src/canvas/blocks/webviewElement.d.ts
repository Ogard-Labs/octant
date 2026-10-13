import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * Electron's guest page element. Octant draws a running Canvas prototype
       * in one in the desktop app, where the main process decides what it may
       * load.
       */
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
      };
    }
  }
}
