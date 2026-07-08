import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest は globals: false のため RTL の自動 cleanup が働かない。
// テスト間で document.body に前のレンダー結果が残らないよう明示的に unmount する
afterEach(() => {
  cleanup();
});
