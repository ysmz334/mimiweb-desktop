import { render, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";

const {
  mockDownloadEngine,
  mockRetryVoicevoxConnection,
  mockDownloadPiper,
} = vi.hoisted(() => ({
  mockDownloadEngine: vi.fn(),
  mockRetryVoicevoxConnection: vi.fn(),
  mockDownloadPiper: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  downloadEngine: mockDownloadEngine,
  retryVoicevoxConnection: mockRetryVoicevoxConnection,
  downloadPiper: mockDownloadPiper,
}));

import { EngineSetupScreen } from "./EngineSetupScreen";

const START_LABEL = "ダウンロードして使用を開始する";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockResolvedValue(vi.fn());
  mockDownloadEngine.mockResolvedValue(undefined);
  mockRetryVoicevoxConnection.mockResolvedValue(undefined);
  mockDownloadPiper.mockResolvedValue(undefined);
});

describe("EngineSetupScreen — 2エンジン同時導入 (7)", () => {
  it("両エンジンのチェックボックスがデフォルトでオンになっている", () => {
    const { getByRole } = render(<EngineSetupScreen onDone={vi.fn()} />);

    const vv = getByRole("checkbox", { name: /VOICEVOX/ }) as HTMLInputElement;
    const piper = getByRole("checkbox", { name: /Piper/ }) as HTMLInputElement;
    expect(vv.checked).toBe(true);
    expect(piper.checked).toBe(true);
  });

  it("両チェックで開始すると VOICEVOX → Piper の順に導入され完走する", async () => {
    const calls: string[] = [];
    mockDownloadEngine.mockImplementation(async () => { calls.push("vv-download"); });
    mockRetryVoicevoxConnection.mockImplementation(async () => { calls.push("vv-start"); });
    mockDownloadPiper.mockImplementation(async () => { calls.push("piper-download"); });

    const onDone = vi.fn();
    const { getByRole } = render(<EngineSetupScreen onDone={onDone} />);

    fireEvent.click(getByRole("button", { name: START_LABEL }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["vv-download", "vv-start", "piper-download"]);
  });

  it("Piper のチェックを外すと VOICEVOX のみ導入される（従来挙動）", async () => {
    const onDone = vi.fn();
    const { getByRole } = render(<EngineSetupScreen onDone={onDone} />);

    fireEvent.click(getByRole("checkbox", { name: /Piper/ }));
    fireEvent.click(getByRole("button", { name: START_LABEL }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mockDownloadEngine).toHaveBeenCalledTimes(1);
    expect(mockDownloadPiper).not.toHaveBeenCalled();
  });

  it("Piper の失敗は警告表示に留め、アプリの利用開始を妨げない", async () => {
    mockDownloadPiper.mockRejectedValue(new Error("network error"));
    const onDone = vi.fn();
    const { getByRole, findByText } = render(<EngineSetupScreen onDone={onDone} />);

    fireEvent.click(getByRole("button", { name: START_LABEL }));

    // 警告文（後から設定タブで導入できる旨）が表示される
    await findByText(/後から設定タブ/);
    expect(onDone).not.toHaveBeenCalled();

    // 続行ボタンでアプリを開始できる
    fireEvent.click(getByRole("button", { name: "このまま開始する" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("VOICEVOX のチェックを外すと開始できないことが明示される", () => {
    const { getByRole, getByText } = render(<EngineSetupScreen onDone={vi.fn()} />);

    fireEvent.click(getByRole("checkbox", { name: /VOICEVOX/ }));

    const start = getByRole("button", { name: START_LABEL }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(getByText(/VOICEVOX は.*必須/)).toBeTruthy();

    // 再チェックで開始可能に戻る
    fireEvent.click(getByRole("checkbox", { name: /VOICEVOX/ }));
    expect(start.disabled).toBe(false);
  });
});
