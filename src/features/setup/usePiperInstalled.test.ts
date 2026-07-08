import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockCheckPiperInstalled } = vi.hoisted(() => ({
  mockCheckPiperInstalled: vi.fn(),
}));

vi.mock("@/lib/tauriCommands", () => ({
  checkPiperInstalled: mockCheckPiperInstalled,
}));

import { usePiperInstalled } from "./usePiperInstalled";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePiperInstalled — Piper 可用性の単一判定点 (6.1)", () => {
  it("起動時は null で始まり、checkPiperInstalled の結果を反映する", async () => {
    mockCheckPiperInstalled.mockResolvedValue(true);
    const { result } = renderHook(() => usePiperInstalled());

    expect(result.current.piperInstalled).toBeNull();
    await waitFor(() => expect(result.current.piperInstalled).toBe(true));
  });

  it("チェック失敗時は false として扱う", async () => {
    mockCheckPiperInstalled.mockRejectedValue(new Error("ipc error"));
    const { result } = renderHook(() => usePiperInstalled());

    await waitFor(() => expect(result.current.piperInstalled).toBe(false));
  });

  it("refreshPiperInstalled で再取得し、導入直後の状態切替が反映される", async () => {
    mockCheckPiperInstalled.mockResolvedValue(false);
    const { result } = renderHook(() => usePiperInstalled());
    await waitFor(() => expect(result.current.piperInstalled).toBe(false));

    // 設定タブから Piper を導入した直後を模擬
    mockCheckPiperInstalled.mockResolvedValue(true);
    await act(async () => {
      await result.current.refreshPiperInstalled();
    });

    expect(result.current.piperInstalled).toBe(true);
  });
});
