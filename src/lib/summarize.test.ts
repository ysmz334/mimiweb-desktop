import { describe, it, expect } from "vitest";
import { selectKeySentenceIndices } from "./summarize";

describe("selectKeySentenceIndices", () => {
  it("短い記事（3文以下）は全文を返す", () => {
    const r = selectKeySentenceIndices(["a", "b"], [], 0.35);
    expect(r.size).toBe(2);
    expect(r.has(0)).toBe(true);
    expect(r.has(1)).toBe(true);
  });

  it("先頭文（タイトル）は常に含まれる", () => {
    const sentences = ["タイトル", "x1", "y2", "z3", "w4", "v5"];
    const r = selectKeySentenceIndices(sentences, [{ word: "存在しない", score: 1 }], 0.2);
    expect(r.has(0)).toBe(true);
  });

  it("高スコアのキーワードを含む文が選ばれる", () => {
    const sentences = [
      "イントロ",
      "猫が座った",
      "無関係な文",
      "猫が走った",
      "埋め草1",
      "埋め草2",
    ];
    const kws = [{ word: "猫", score: 1 }];
    const r = selectKeySentenceIndices(sentences, kws, 0.35);
    // count = round(6*0.35)=2 → スコア上位2文（猫を含む idx1,3）＋ 先頭 idx0
    expect(r.has(1)).toBe(true);
    expect(r.has(3)).toBe(true);
    expect(r.has(0)).toBe(true);
  });

  it("キーワードが空でも先頭文だけは返す", () => {
    const sentences = ["a", "b", "c", "d", "e"];
    const r = selectKeySentenceIndices(sentences, [], 0.35);
    expect(r.has(0)).toBe(true);
    expect(r.size).toBeGreaterThanOrEqual(1);
  });
});
