import { describe, it, expect } from "vitest";
import { buildFullText } from "./viewerUtils";

describe("buildFullText", () => {
  it("タイトルも本文もない場合は空文字を返す", () => {
    expect(buildFullText(null, null)).toBe("");
  });

  it("タイトルなし・本文のみの場合は本文をそのまま返す", () => {
    expect(buildFullText(null, "本文のみ。")).toBe("本文のみ。");
  });

  it("タイトルあり・本文先頭にタイトルが含まれない場合はタイトルを冒頭に付与する", () => {
    expect(buildFullText("T", "本文")).toBe("T。本文");
  });

  it("タイトルあり・本文先頭にタイトルが含まれる場合は重複を除去してタイトルを付与する", () => {
    expect(buildFullText("T", "T。本文")).toBe("T。本文");
  });

  it("Readability 形式: タイトルが本文先頭にあり、以降に記事本文が続く場合も正しく結合する", () => {
    expect(buildFullText("AI入門", "AI入門。第一章の内容。")).toBe("AI入門。第一章の内容。");
  });

  it("タイトルあり・本文なしの場合はタイトル+句点を返す", () => {
    expect(buildFullText("タイトル", null)).toBe("タイトル。");
  });

  it("本文先頭に空白がある場合もタイトル重複を正しく除去する", () => {
    expect(buildFullText("見出し", "  見出し\n本文が続く。")).toBe("見出し。本文が続く。");
  });

  it("タイトルが本文の途中に含まれる場合は重複除去せずそのままタイトルを付与する", () => {
    expect(buildFullText("入門", "はじめに。入門とは。")).toBe("入門。はじめに。入門とは。");
  });
});
