export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type KeyBindingId =
  | "playPause"
  | "seekForward"
  | "seekBackward"
  | "prevSentence"
  | "nextSentence"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "speedDown"
  | "speedUp"
  | "viewerSearch"
  | "navBack"
  | "navForward";

export type Keybindings = Record<KeyBindingId, KeyBinding>;

export const BINDING_LABELS: Record<KeyBindingId, string> = {
  playPause:    "再生 / 一時停止",
  seekForward:  "10秒進む",
  seekBackward: "10秒戻る",
  prevSentence: "前の文へ",
  nextSentence: "次の文へ",
  volumeUp:     "音量アップ",
  volumeDown:   "音量ダウン",
  mute:         "ミュート切替",
  speedDown:    "速度を下げる",
  speedUp:      "速度を上げる",
  viewerSearch: "テキスト内検索 (Ctrl+F)",
  navBack:      "前の画面に戻る",
  navForward:   "次の画面に進む",
};

export const DEFAULT_KEYBINDINGS: Keybindings = {
  playPause:    { key: " " },
  seekForward:  { key: "ArrowRight" },
  seekBackward: { key: "ArrowLeft" },
  prevSentence: { key: "[" },
  nextSentence: { key: "]" },
  volumeUp:     { key: "ArrowUp" },
  volumeDown:   { key: "ArrowDown" },
  mute:         { key: "m" },
  speedDown:    { key: "," },
  speedUp:      { key: "." },
  viewerSearch: { key: "f", ctrl: true },
  navBack:      { key: "ArrowLeft", alt: true },
  navForward:   { key: "ArrowRight", alt: true },
};

export const BINDING_ORDER: KeyBindingId[] = [
  "playPause", "seekForward", "seekBackward",
  "prevSentence", "nextSentence",
  "volumeUp", "volumeDown", "mute",
  "speedDown", "speedUp",
  "viewerSearch",
  "navBack", "navForward",
];

const KEY_DISPLAY: Record<string, string> = {
  " ":          "Space",
  "ArrowRight": "→",
  "ArrowLeft":  "←",
  "ArrowUp":    "↑",
  "ArrowDown":  "↓",
  "Enter":      "Enter",
  "Escape":     "Esc",
  "Backspace":  "BackSpace",
  "Tab":        "Tab",
  "Delete":     "Delete",
};

export function keyLabel(b: KeyBinding): string {
  const mods: string[] = [];
  if (b.ctrl)  mods.push("Ctrl");
  if (b.shift) mods.push("Shift");
  if (b.alt)   mods.push("Alt");
  const key = KEY_DISPLAY[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return [...mods, key].join("+");
}

export function matchesBinding(e: KeyboardEvent, b: KeyBinding): boolean {
  return (
    e.key === b.key &&
    !!e.ctrlKey  === !!b.ctrl  &&
    !!e.shiftKey === !!b.shift &&
    !!e.altKey   === !!b.alt
  );
}

const STORAGE_KEY = "mimiweb.keybindings";

function fromStorage(): Keybindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_KEYBINDINGS };
    return { ...DEFAULT_KEYBINDINGS, ...(JSON.parse(raw) as Partial<Keybindings>) };
  } catch {
    return { ...DEFAULT_KEYBINDINGS };
  }
}

let _current: Keybindings = fromStorage();

export function getCurrentKeybindings(): Keybindings {
  return _current;
}

export function updateKeybindings(kb: Keybindings): void {
  _current = kb;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(kb));
}

export function isCustomized(): boolean {
  return BINDING_ORDER.some((id) => keyLabel(_current[id]) !== keyLabel(DEFAULT_KEYBINDINGS[id]));
}
