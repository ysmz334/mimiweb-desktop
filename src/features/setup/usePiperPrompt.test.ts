import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { usePiperPrompt } from "./usePiperPrompt";

describe("usePiperPrompt — Piper 誘導バナーの状態管理 (6.2)", () => {
  it("en / mixed の記事で表示要求が反映され、ja は無視される", () => {
    const { result } = renderHook(() => usePiperPrompt(false));

    act(() => { result.current.requestPiperPrompt("registered", "ja"); });
    expect(result.current.piperPrompt).toBeNull();

    act(() => { result.current.requestPiperPrompt("registered", "en"); });
    expect(result.current.piperPrompt).toBe("registered");

    act(() => { result.current.requestPiperPrompt("fallback", "mixed"); });
    expect(result.current.piperPrompt).toBe("fallback");
  });

  it("dismiss するとセッション中は再表示しない", () => {
    const { result } = renderHook(() => usePiperPrompt(false));

    act(() => { result.current.requestPiperPrompt("fallback", "mixed"); });
    expect(result.current.piperPrompt).toBe("fallback");

    act(() => { result.current.dismissPiperPrompt(); });
    expect(result.current.piperPrompt).toBeNull();

    // 以降の表示要求（再生再開・別記事の登録など）は無視される
    act(() => { result.current.requestPiperPrompt("fallback", "mixed"); });
    act(() => { result.current.requestPiperPrompt("registered", "en"); });
    expect(result.current.piperPrompt).toBeNull();
  });

  it("Piper が導入されると表示中のバナーが自動で閉じる", () => {
    const { result, rerender } = renderHook(
      ({ installed }: { installed: boolean | null }) => usePiperPrompt(installed),
      { initialProps: { installed: false as boolean | null } }
    );

    act(() => { result.current.requestPiperPrompt("fallback", "en"); });
    expect(result.current.piperPrompt).toBe("fallback");

    rerender({ installed: true });
    expect(result.current.piperPrompt).toBeNull();
  });
});
