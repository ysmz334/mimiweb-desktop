import { render, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";

const {
  mockCheckPiperInstalled,
  mockDownloadPiper,
  mockOnPiperSetupProgress,
} = vi.hoisted(() => ({
  mockCheckPiperInstalled: vi.fn(),
  mockDownloadPiper: vi.fn(),
  mockOnPiperSetupProgress: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  checkPiperInstalled: mockCheckPiperInstalled,
  downloadPiper: mockDownloadPiper,
  onPiperSetupProgress: mockOnPiperSetupProgress,
}));

import { PiperTtsSection } from "./SettingsPanel";

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPiperInstalled.mockResolvedValue(false);
  mockOnPiperSetupProgress.mockResolvedValue(vi.fn());
  vi.mocked(listen).mockResolvedValue(vi.fn());
});

describe("PiperTtsSection — インストール成功の通知経路 (6.1)", () => {
  it("Piper インストール成功時に onPiperInstalled コールバックが呼ばれる", async () => {
    mockDownloadPiper.mockResolvedValue(undefined);
    const onPiperInstalled = vi.fn();
    const { findByRole } = render(<PiperTtsSection onPiperInstalled={onPiperInstalled} />);

    const btn = await findByRole("button", { name: "ダウンロード" });
    fireEvent.click(btn);

    await waitFor(() => expect(onPiperInstalled).toHaveBeenCalledTimes(1));
  });

  it("インストール失敗時は onPiperInstalled を呼ばない", async () => {
    mockDownloadPiper.mockRejectedValue(new Error("network error"));
    const onPiperInstalled = vi.fn();
    const { findByRole, findByText } = render(
      <PiperTtsSection onPiperInstalled={onPiperInstalled} />
    );

    const btn = await findByRole("button", { name: "ダウンロード" });
    fireEvent.click(btn);

    await findByText(/network error/);
    expect(onPiperInstalled).not.toHaveBeenCalled();
  });
});
