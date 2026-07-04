import { useEffect, useState } from "react";
import {
  BINDING_LABELS,
  BINDING_ORDER,
  DEFAULT_KEYBINDINGS,
  getCurrentKeybindings,
  isCustomized,
  keyLabel,
  updateKeybindings,
  type KeyBinding,
  type KeyBindingId,
  type Keybindings,
} from "@/lib/keybindings";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function KbdChip({ binding, active }: { binding: KeyBinding; active?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        background: active ? "var(--accent)" : "var(--surface)",
        color: active ? "#fff" : "var(--text)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 4,
        padding: "2px 8px",
        fontFamily: "monospace",
        fontSize: 12,
        minWidth: 64,
        textAlign: "center",
        transition: "background 0.15s",
      }}
    >
      {keyLabel(binding)}
    </span>
  );
}

export function KeybindingsSection() {
  const [open, setOpen] = useState(false);
  const [kb, setKb] = useState<Keybindings>(() => getCurrentKeybindings());
  const [recording, setRecording] = useState<KeyBindingId | null>(null);
  const customized = isCustomized();

  // captureキー時は他のハンドラより先に処理（capture: true）
  useEffect(() => {
    if (recording === null) return;

    function capture(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") { setRecording(null); return; }
      if (MODIFIER_KEYS.has(e.key)) return;

      const binding: KeyBinding = {
        key: e.key,
        ctrl:  e.ctrlKey  || undefined,
        shift: e.shiftKey || undefined,
        alt:   e.altKey   || undefined,
      };

      const id = recording as KeyBindingId;
      setKb((prev) => {
        const updated: Keybindings = { ...prev, [id]: binding };
        updateKeybindings(updated);
        return updated;
      });
      setRecording(null);
    }

    window.addEventListener("keydown", capture, { capture: true });
    return () => window.removeEventListener("keydown", capture, { capture: true });
  }, [recording]);

  function handleReset() {
    const reset = { ...DEFAULT_KEYBINDINGS };
    setKb(reset);
    updateKeybindings(reset);
  }

  const btnStyle: React.CSSProperties = {
    fontSize: 11,
    padding: "2px 8px",
    lineHeight: "1.6",
    whiteSpace: "nowrap",
  };

  return (
    <fieldset style={{ marginBottom: 16 }}>
      <legend>キーバインド</legend>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 0",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--text-muted)", flex: 1 }}>
          {customized ? "カスタマイズ済み" : "デフォルト設定"}
        </span>
        <button
          style={{ fontSize: 13, padding: "3px 12px" }}
          onClick={() => { setOpen((v) => !v); setRecording(null); }}
        >
          {open ? "閉じる" : "編集する"}
        </button>
      </div>

      {open && (
        <div style={{ paddingBottom: 4 }}>
          {/* ヘッダー */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px 60px",
              gap: "0 8px",
              padding: "4px 2px",
              borderBottom: "1px solid var(--border)",
              marginBottom: 2,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>操作</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>キー</span>
            <span />
          </div>

          {BINDING_ORDER.map((id) => {
            const isRecording = recording === id;
            return (
              <div
                key={id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 60px",
                  gap: "0 8px",
                  alignItems: "center",
                  padding: "5px 2px",
                  borderRadius: 4,
                  background: isRecording ? "rgba(var(--accent-rgb, 59,130,246), 0.07)" : undefined,
                }}
              >
                <span style={{ fontSize: 13 }}>{BINDING_LABELS[id]}</span>

                {isRecording ? (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--accent, #3b82f6)",
                      fontStyle: "italic",
                      textAlign: "center",
                      animation: "pulse 1s infinite",
                    }}
                  >
                    キーを押して…
                  </span>
                ) : (
                  <div style={{ textAlign: "center" }}>
                    <KbdChip binding={kb[id]} />
                  </div>
                )}

                {isRecording ? (
                  <button style={btnStyle} onClick={() => setRecording(null)}>キャンセル</button>
                ) : (
                  <button style={btnStyle} onClick={() => setRecording(id)}>変更</button>
                )}
              </div>
            );
          })}

          {/* フッター */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              paddingTop: 8,
              marginTop: 4,
              borderTop: "1px solid var(--border)",
            }}
          >
            <button
              style={{ fontSize: 12, padding: "3px 10px", color: "var(--danger)", borderColor: "var(--danger)" }}
              onClick={handleReset}
            >
              すべてデフォルトに戻す
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}
