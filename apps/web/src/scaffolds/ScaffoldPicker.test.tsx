import { decodeScaffoldEntry } from "@octant/contracts/scaffolds";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScaffoldPicker } from "./ScaffoldPicker";

const webApp = decodeScaffoldEntry({
  id: "web-app",
  displayName: "Web app",
  summary: "A browser app with a dev server and a build.",
  target: "web-app",
  generator: {
    kind: "pinned-package",
    runner: "bun",
    packageName: "create-vite",
    version: "9.1.2",
    presetArguments: ["--template", "react-ts"],
  },
  requiresTool: "bunx",
  produces: ["package.json", "src/main.tsx"],
});

const nativeApp = decodeScaffoldEntry({
  id: "native-apple-app",
  displayName: "Native Swift package",
  summary: "A Swift package the Apple toolchain builds directly.",
  target: "native-apple-app",
  generator: {
    kind: "toolchain",
    tool: "swift",
    presetArguments: ["package", "init", "--type", "executable"],
  },
  requiresTool: "swift",
  produces: ["Package.swift"],
});

function picker(overrides: Partial<Parameters<typeof ScaffoldPicker>[0]> = {}) {
  const onStart = vi.fn();
  render(
    <ScaffoldPicker
      busy={false}
      entries={[webApp, nativeApp]}
      onStart={onStart}
      runnable={
        new Map([
          ["web-app", true],
          ["native-apple-app", false],
        ])
      }
      {...overrides}
    />,
  );
  return { onStart };
}

describe("choosing a scaffold to start a project from", () => {
  it("says which scaffold this machine cannot run, and why", () => {
    picker();

    expect(screen.getByRole("button", { name: /Native Swift package/ })).toBeDisabled();
    expect(screen.getByText(/Needs swift, which is not on this machine/)).toBeInTheDocument();
  });

  it("shows the exact command before it is started", async () => {
    const user = userEvent.setup();
    picker();

    await user.click(screen.getByRole("button", { name: /Web app/ }));
    await user.type(screen.getByLabelText("New directory"), "storefront");

    expect(
      screen.getByText("bunx --bun create-vite@9.1.2 storefront --template react-ts"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Writes package.json, src\/main.tsx/)).toBeInTheDocument();
  });

  it("starts nothing until a directory has been named", async () => {
    const user = userEvent.setup();
    const { onStart } = picker();

    await user.click(screen.getByRole("button", { name: /Web app/ }));
    expect(screen.getByRole("button", { name: "Start it" })).toBeDisabled();

    await user.type(screen.getByLabelText("New directory"), "storefront");
    await user.click(screen.getByRole("button", { name: "Start it" }));

    expect(onStart).toHaveBeenCalledWith(webApp, "storefront");
  });

  it("shows the host's refusal in the words the host used", () => {
    picker({ message: "Something already exists at that name. Choose another." });

    expect(screen.getByRole("status")).toHaveTextContent("already exists");
  });
});
