import { describe, expect, it } from "vitest";
import { createTerminalSender, type TerminalSend } from "./terminalSender";

function host() {
  const sent: TerminalSend[] = [];
  const answers: Array<() => void> = [];
  const send = (item: TerminalSend) =>
    new Promise<void>((resolve) => {
      sent.push(item);
      answers.push(resolve);
    });
  const answer = async () => {
    answers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { sent, send, answer };
}

describe("sending a shell what the phone types", () => {
  it("sends one request at a time, in order, with what was typed meanwhile in the next", async () => {
    const { sent, send, answer } = host();
    const sender = createTerminalSender(send);
    sender.write("l");
    sender.write("s");
    sender.write("\r");
    expect(sent).toEqual([{ kind: "write", data: "l" }]);
    await answer();
    expect(sent).toEqual([
      { kind: "write", data: "l" },
      { kind: "write", data: "s\r" },
    ]);
  });

  it("sends only the last of several sizes waiting, after the typing before it", async () => {
    const { sent, send, answer } = host();
    const sender = createTerminalSender(send);
    sender.write("a");
    sender.resize(40, 20);
    sender.resize(50, 25);
    sender.write("b");
    await answer();
    await answer();
    await answer();
    expect(sent).toEqual([
      { kind: "write", data: "a" },
      { kind: "resize", columns: 50, rows: 25 },
      { kind: "write", data: "b" },
    ]);
  });

  it("sends nothing more once the shell is stopped", async () => {
    const { sent, send, answer } = host();
    const sender = createTerminalSender(send);
    sender.write("a");
    sender.write("b");
    sender.close();
    await answer();
    sender.write("c");
    expect(sent).toEqual([{ kind: "write", data: "a" }]);
  });
});
