import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changeListeners: [] as Array<() => void>,
  changeDispose: vi.fn(),
  createModel: vi.fn(),
  editorDispose: vi.fn(),
  editorCreate: vi.fn(),
  editorFocus: vi.fn(),
  editorUpdateOptions: vi.fn(),
  getModel: vi.fn(),
  installEnvironment: vi.fn(),
  model: undefined as unknown as {
    dispose: () => void;
    getValue: () => string;
    onDidChangeContent: (listener: () => void) => { dispose: () => void };
    setValue: (value: string) => void;
  },
  modelDispose: vi.fn(),
  modelGetValue: vi.fn(),
  modelSetValue: vi.fn(),
  value: "stale",
}));

mocks.model = {
  dispose: mocks.modelDispose,
  getValue: mocks.modelGetValue,
  onDidChangeContent: (listener) => {
    mocks.changeListeners.push(listener);
    return { dispose: mocks.changeDispose };
  },
  setValue: mocks.modelSetValue,
};

vi.mock("monaco-editor", () => ({
  Uri: { parse: vi.fn(() => ({ scheme: "octant-code" })) },
  editor: {
    create: mocks.editorCreate.mockImplementation(() => ({
      dispose: mocks.editorDispose,
      focus: mocks.editorFocus,
      updateOptions: mocks.editorUpdateOptions,
    })),
    createModel: mocks.createModel,
    getModel: mocks.getModel,
  },
}));

vi.mock("./monacoEnvironment", () => ({
  installMonacoEnvironment: mocks.installEnvironment,
}));

import { mount } from "./monacoRuntime";

describe("Monaco runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.changeListeners.length = 0;
    mocks.value = "stale";
    mocks.modelGetValue.mockImplementation(() => mocks.value);
    mocks.modelSetValue.mockImplementation((value: string) => {
      mocks.value = value;
      for (const listener of mocks.changeListeners) listener();
    });
    mocks.getModel.mockReturnValue(mocks.model);
    mocks.createModel.mockReturnValue(mocks.model);
  });

  it("synchronizes an existing opaque model to the latest authoritative value", () => {
    const session = mount(document.createElement("div"), {
      language: "markdown",
      modelUri: "octant-code://checkout-opaque/file-opaque",
      onChange: vi.fn(),
      readOnly: false,
      value: "latest",
    });

    expect(mocks.modelSetValue).toHaveBeenCalledWith("latest");
    session.dispose();
    expect(mocks.modelDispose).not.toHaveBeenCalled();
  });

  it("mounts the editor with the Octant dark presentation", () => {
    const session = mount(document.createElement("div"), options());

    expect(mocks.editorCreate).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ theme: "vs-dark" }),
    );
    session.dispose();
  });

  it("projects editor typography at mount and on live updates", () => {
    const session = mount(
      document.createElement("div"),
      options({
        typography: {
          fontFamily: "Source Code Pro",
          fontSize: 15,
          fontWeight: 500,
          lineHeight: 1.8,
          fontLigatures: false,
        },
      }),
    );

    expect(mocks.editorCreate).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        fontFamily: "Source Code Pro",
        fontSize: 15,
        fontWeight: "500",
        lineHeight: 1.8,
        fontLigatures: false,
      }),
    );
    session.setTypography?.({
      fontFamily: "Fira Code",
      fontSize: 16,
      fontWeight: 600,
      lineHeight: 2,
      fontLigatures: true,
    });
    expect(mocks.editorUpdateOptions).toHaveBeenLastCalledWith({
      fontFamily: "Fira Code",
      fontSize: 16,
      fontWeight: "600",
      lineHeight: 2,
      fontLigatures: true,
    });
    session.dispose();
  });

  it("retains a shared model until every pane using its opaque URI is disposed", () => {
    mocks.getModel.mockReturnValueOnce(null);
    const first = mount(document.createElement("div"), options());
    const second = mount(document.createElement("div"), options());

    first.dispose();
    expect(mocks.modelDispose).not.toHaveBeenCalled();

    second.dispose();
    expect(mocks.modelDispose).toHaveBeenCalledOnce();
  });

  it("does not report controlled values as user edits", () => {
    const onChange = vi.fn();
    const session = mount(document.createElement("div"), options({ onChange }));

    onChange.mockClear();
    session.setValue("authoritative");
    expect(onChange).not.toHaveBeenCalled();

    mocks.value = "user edit";
    for (const listener of mocks.changeListeners) listener();
    expect(onChange).toHaveBeenCalledWith("user edit");
    session.dispose();
  });
});

function options(
  overrides: Partial<Parameters<typeof mount>[1]> = {},
): Parameters<typeof mount>[1] {
  return {
    language: "markdown",
    modelUri: "octant-code://checkout-opaque/file-opaque",
    onChange: vi.fn(),
    readOnly: false,
    value: "stale",
    ...overrides,
  };
}
