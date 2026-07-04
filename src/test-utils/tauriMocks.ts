import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

type InvokeMap = Record<string, unknown>;
type Options = { throws?: string[] };

/**
 * invoke() モックを設定する。
 * responses の各キーがコマンド名、値がレスポンスデータ。
 * options.throws にコマンド名を指定すると、そのコマンドは値を reject で返す。
 */
export function setupInvokeMap(responses: InvokeMap, options: Options = {}): void {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    const key = String(cmd);
    if (!(key in responses)) {
      throw new Error(`Unmocked Tauri command: "${key}"`);
    }
    if (options.throws?.includes(key)) {
      throw responses[key];
    }
    return responses[key] as never;
  });
}
