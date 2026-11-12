import { describe, expect, it } from "vitest";
import { browserFrameAdmitted } from "./browserAutomationPolicy";
import {
  answerBrowserDialog,
  BROWSER_FRAME_HOP,
  formatBrowserPageSnapshot,
  readFramedBrowserSnapshot,
  splitBrowserFrameTarget,
  type BrowserPageSnapshot,
} from "./browserPageSnapshot";

const top: BrowserPageSnapshot = {
  nodes: [
    { depth: 0, role: "heading", name: "Shop", level: 1 },
    { depth: 0, role: "iframe", name: "Pay", frame: "#pay" },
    { depth: 0, role: "iframe", name: "Ad", frame: "#ad" },
    { depth: 0, role: "button", name: "Back", ref: "e1" },
  ],
  refs: [{ ref: "e1", selector: "#back", role: "button", name: "Back" }],
  truncated: false,
};

describe("a page outline read across frames", () => {
  it("lists a readable frame's content under its line and leaves out one it may not read", async () => {
    const snapshot = await readFramedBrowserSnapshot<string>(
      "top",
      {
        read: async (frame, limits) =>
          frame === "top"
            ? top
            : {
                nodes: [
                  { depth: 0, role: "button", name: "Pay now", ref: `e${limits.refOffset + 1}` },
                ],
                refs: [
                  {
                    ref: `e${limits.refOffset + 1}`,
                    selector: "#go",
                    role: "button",
                    name: "Pay now",
                  },
                ],
                truncated: false,
              },
        child: async (_frame, selector) =>
          selector === "#pay"
            ? { status: "included", frame: "pay" }
            : { status: "excluded", origin: "https://ads.example" },
      },
      { maxRefs: 400, maxNodes: 800 },
    );
    expect(formatBrowserPageSnapshot(snapshot)).toBe(
      [
        '- heading "Shop" [level=1]',
        '- iframe "Pay"',
        '  - button "Pay now" [ref=e2]',
        '- iframe "https://ads.example" not included',
        '- button "Back" [ref=e1]',
      ].join("\n"),
    );
    expect(snapshot.refs.find((ref) => ref.ref === "e2")?.selector).toBe(
      `#pay${BROWSER_FRAME_HOP}#go`,
    );
    expect(splitBrowserFrameTarget(`#pay${BROWSER_FRAME_HOP}#go`)).toEqual({
      frames: ["#pay"],
      element: "#go",
    });
  });

  it("spends one line budget on the whole page, frames included", async () => {
    const snapshot = await readFramedBrowserSnapshot<string>(
      "top",
      {
        read: async (frame) =>
          frame === "top"
            ? top
            : {
                nodes: Array.from({ length: 5 }, () => ({ depth: 0, role: "text", name: "x" })),
                refs: [],
                truncated: false,
              },
        child: async () => ({ status: "included", frame: "inner" }),
      },
      { maxRefs: 400, maxNodes: 6 },
    );
    expect(snapshot.nodes).toHaveLength(6);
    expect(snapshot.truncated).toBe(true);
  });
});

describe("which frames the agent may read", () => {
  const approved = ["https://shop.example"];
  it("reads any web frame of a Private page", () => {
    expect(
      browserFrameAdmitted("https://ads.example/x", { allowedOrigins: approved, signedIn: false }),
    ).toBe(true);
  });
  it("reads a signed-in page's frame on another origin only when that origin is approved", () => {
    expect(
      browserFrameAdmitted("https://ads.example/x", { allowedOrigins: approved, signedIn: true }),
    ).toBe(false);
    expect(
      browserFrameAdmitted("https://shop.example/pay", {
        allowedOrigins: approved,
        signedIn: true,
      }),
    ).toBe(true);
    expect(browserFrameAdmitted("about:srcdoc", { allowedOrigins: approved, signedIn: true })).toBe(
      true,
    );
  });
  it("never reads a frame that is not a web page", () => {
    expect(
      browserFrameAdmitted("chrome-error://chromewebdata/", {
        allowedOrigins: approved,
        signedIn: false,
      }),
    ).toBe(false);
  });
});

describe("a page dialog's answer", () => {
  it("takes the agent's answer for the dialog its action raises, and the fixed rule without one", () => {
    expect(answerBrowserDialog("confirm", "Delete?", undefined)).toEqual({
      answer: "dismissed",
      answeredBy: "rule",
    });
    expect(answerBrowserDialog("confirm", "Delete?", { action: "accept" })).toEqual({
      answer: "accepted",
      answeredBy: "agent",
    });
    expect(answerBrowserDialog("beforeunload", "", { action: "dismiss" })).toEqual({
      answer: "dismissed",
      answeredBy: "agent",
    });
    expect(answerBrowserDialog("prompt", "Your name?", { action: "accept", text: "Ada" })).toEqual({
      answer: "accepted",
      answeredBy: "agent",
      promptText: "Ada",
    });
    // Text means nothing to a dialog that takes none.
    expect(answerBrowserDialog("alert", "Saved", { action: "accept", text: "Ada" })).toEqual({
      answer: "accepted",
      answeredBy: "agent",
    });
  });
  it("withholds text from a prompt that asks for a credential, as a credential field refuses typing", () => {
    for (const message of ["Enter your password", "API key?", "One-time passcode", "Card number"]) {
      expect(answerBrowserDialog("prompt", message, { action: "accept", text: "hunter2" })).toEqual(
        { answer: "dismissed", answeredBy: "rule", textWithheld: "credential-protected" },
      );
    }
    // A word that only contains a credential word is not one.
    for (const message of ["Discard changes? Type YES to confirm.", "Enter the postcard message"]) {
      expect(answerBrowserDialog("prompt", message, { action: "accept", text: "YES" })).toEqual({
        answer: "accepted",
        answeredBy: "agent",
        promptText: "YES",
      });
    }
    // Declining such a prompt types nothing, so the agent's answer stands.
    expect(answerBrowserDialog("prompt", "Enter your password", { action: "dismiss" })).toEqual({
      answer: "dismissed",
      answeredBy: "agent",
    });
  });
});
