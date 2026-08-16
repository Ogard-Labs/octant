import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { DiscoveryCandidate, DiscoverySnapshot, ProviderInstance } from "@octant/contracts";
import { ProviderDiscoverySection } from "./ProviderDiscoverySection";

const codexCandidate: DiscoveryCandidate = {
  driverKind: "codex",
  displayName: "Codex CLI",
  binaryPath: "/usr/local/bin/codex",
  version: "codex-cli 0.1.0",
  readiness: "ready",
  pathSummary: "/usr/local/bin/codex",
  onboardingGuidance: "Run codex login.",
  detectedAt: "2026-07-25T10:00:00.000Z",
} as unknown as DiscoveryCandidate;

const claudeCandidate: DiscoveryCandidate = {
  driverKind: "claude",
  displayName: "Claude Code",
  binaryPath: "/usr/local/bin/claude",
  readiness: "unauthenticated",
  pathSummary: "/usr/local/bin/claude",
  onboardingGuidance: "Authenticate with Claude Code.",
  detectedAt: "2026-07-25T10:00:00.000Z",
} as unknown as DiscoveryCandidate;

const ollamaCandidate: DiscoveryCandidate = {
  driverKind: "ollama",
  displayName: "Ollama",
  binaryPath: "/usr/local/bin/ollama",
  readiness: "ready",
  pathSummary: "/usr/local/bin/ollama",
  onboardingGuidance: "Start Ollama locally.",
  detectedAt: "2026-07-25T10:00:00.000Z",
} as unknown as DiscoveryCandidate;

const baseSnapshot: DiscoverySnapshot = {
  hostId: "local",
  candidates: [codexCandidate, claudeCandidate],
  scannedAt: "2026-07-25T10:00:00.000Z",
  scanDurationMs: 200,
  status: "completed",
} as unknown as DiscoverySnapshot;

const defaultProps = {
  snapshot: baseSnapshot,
  scanning: false,
  instances: [] as ReadonlyArray<ProviderInstance>,
  onScan: vi.fn(async () => {}),
  onConnect: vi.fn(async () => true),
  connectingPaths: new Set<string>(),
};

describe("ProviderDiscoverySection", () => {
  it("renders detected candidates", () => {
    render(<ProviderDiscoverySection {...defaultProps} />);
    expect(screen.getByText("Codex CLI")).toBeDefined();
    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.getByText("codex-cli 0.1.0")).toBeDefined();
  });

  it("shows readiness badges", () => {
    render(<ProviderDiscoverySection {...defaultProps} />);
    expect(screen.getByText("Ready")).toBeDefined();
    expect(screen.getByText("Authentication required")).toBeDefined();
  });

  it("shows onboarding guidance for unauthenticated candidates", () => {
    render(<ProviderDiscoverySection {...defaultProps} />);
    expect(screen.getByText("Authenticate with Claude Code.")).toBeDefined();
  });

  it("shows scanning state", () => {
    render(<ProviderDiscoverySection {...defaultProps} snapshot={undefined} scanning />);
    expect(screen.getByText("Scanning for installed runtimes…")).toBeDefined();
    expect(screen.getByText("Scanning…")).toBeDefined();
  });

  it("shows empty state when no new candidates", () => {
    const emptySnapshot = { ...baseSnapshot, candidates: [] };
    render(<ProviderDiscoverySection {...defaultProps} snapshot={emptySnapshot} />);
    expect(screen.getByText(/Installed providers are already listed below/)).toBeDefined();
    expect(screen.getByText(/Add provider manually/)).toBeDefined();
    expect(screen.queryByText(/under Advanced/)).toBeNull();
  });

  it("filters out already-configured candidates", () => {
    const configuredInstance = {
      id: "00000000-0000-4000-8000-000000000901",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    } as unknown as ProviderInstance;
    render(<ProviderDiscoverySection {...defaultProps} instances={[configuredInstance]} />);
    // Codex is configured, so only Claude should show
    expect(screen.queryByText("Codex CLI")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeDefined();
  });

  it("keeps disabled auto-registered candidates out of Detected cards", () => {
    const configuredDisabledInstance = {
      id: "00000000-0000-4000-8000-000000000902",
      driverKind: "codex",
      enabled: false,
      configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    } as unknown as ProviderInstance;
    render(<ProviderDiscoverySection {...defaultProps} instances={[configuredDisabledInstance]} />);

    expect(screen.queryByText("Codex CLI")).toBeNull();
    expect(screen.getByText("Claude Code")).toBeDefined();
  });

  it("hides detected candidates when the driver family is already configured", () => {
    const snapshot = { ...baseSnapshot, candidates: [ollamaCandidate] };
    const configuredOllama = {
      id: "00000000-0000-4000-8000-000000000903",
      driverKind: "ollama",
      enabled: false,
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    } as unknown as ProviderInstance;

    render(
      <ProviderDiscoverySection
        {...defaultProps}
        snapshot={snapshot}
        instances={[configuredOllama]}
      />,
    );

    expect(screen.queryByText("Ollama")).toBeNull();
    expect(screen.getByText(/Installed providers are already listed below/)).toBeDefined();
  });

  it("calls onScan when Check again is clicked", () => {
    const onScan = vi.fn(async () => {});
    render(<ProviderDiscoverySection {...defaultProps} onScan={onScan} />);
    fireEvent.click(screen.getByText("Check again"));
    expect(onScan).toHaveBeenCalledOnce();
  });

  it("calls onConnect when Connect is clicked", () => {
    const onConnect = vi.fn(async () => true);
    render(<ProviderDiscoverySection {...defaultProps} onConnect={onConnect} />);
    const connectButtons = screen.getAllByText("Enable");
    fireEvent.click(connectButtons[0]!);
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("shows cancelled status with retry", () => {
    const cancelledSnapshot = { ...baseSnapshot, status: "cancelled" as const, candidates: [] };
    render(<ProviderDiscoverySection {...defaultProps} snapshot={cancelledSnapshot} />);
    expect(screen.getByText(/Scan was cancelled/)).toBeDefined();
  });

  it("shows partial status notice", () => {
    const partialSnapshot = {
      ...baseSnapshot,
      status: "partial" as const,
      message: "Scan exceeded its time budget.",
    };
    render(<ProviderDiscoverySection {...defaultProps} snapshot={partialSnapshot} />);
    expect(screen.getByText(/Scan exceeded its time budget/)).toBeDefined();
  });

  it("shows failed status with retry", () => {
    const failedSnapshot = { ...baseSnapshot, status: "failed" as const, candidates: [] };
    render(<ProviderDiscoverySection {...defaultProps} snapshot={failedSnapshot} />);
    expect(screen.getByText(/Discovery scan failed/)).toBeDefined();
  });

  it("surfaces controller failures with a retry action", () => {
    const onScan = vi.fn(async () => {});
    render(
      <ProviderDiscoverySection
        {...defaultProps}
        message="Provider inventory refresh failed."
        onScan={onScan}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Provider inventory refresh failed.");
    fireEvent.click(screen.getByRole("button", { name: "Retry provider discovery" }));
    expect(onScan).toHaveBeenCalledOnce();
  });
});
