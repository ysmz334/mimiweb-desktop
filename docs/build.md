# ビルド・配布ガイド

## 前提条件

| ツール | バージョン | 確認コマンド |
|--------|-----------|-------------|
| Node.js | 18 以上 | `node -v` |
| Rust / Cargo | stable | `rustc --version` |
| Tauri CLI | 2.x (`@tauri-apps/cli`) | `npx tauri --version` |
| NSIS | 3.x | `makensis /VERSION` |

NSIS は [nsis.sourceforge.io](https://nsis.sourceforge.io/) からインストールするか、  
`winget install NSIS.NSIS` で取得してください。

---

## インストーラ（NSIS）のビルド

```powershell
npm run build:installer
```

内部で `npm run tauri build` を呼び出します。  
実行順序: TypeScript コンパイル → Vite フロントエンドビルド → Rust リリースビルド → NSIS パッケージング

**出力先:**

```
src-tauri/target/release/bundle/nsis/mimiweb-desktop_{version}_x64-setup.exe
```

- インストーラサイズ: 約 4 MB（VOICEVOX エンジン非同梱）
- インストール先: カレントユーザー（管理者権限不要）
- エンジンは初回起動時に自動ダウンロードされます

---

## ポータブル ZIP のビルド

```powershell
npm run build:portable
```

内部で `scripts/build-portable.ps1 -BuildFirst` を呼び出します。  
`npm run tauri build` を実行してから ZIP を作成します。

**すでにリリースビルド済みの場合（ビルドをスキップしたいとき）:**

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
```

**出力先:**

```
dist/mimiweb-desktop-{version}-windows-x64.zip
  └── mimiweb-desktop.exe
```

---

## バージョン管理

バージョンは `src-tauri/tauri.conf.json` の `version` フィールドで一元管理します。

```json
{
  "version": "0.1.0"
}
```

`package.json` の `version` フィールドはビルドに使用しません。  
リリース時は `tauri.conf.json` のみ更新してください。

---

## ビルド所要時間の目安

| フェーズ | 初回 | 2回目以降（差分） |
|---------|------|-----------------|
| TypeScript + Vite | 約 10 秒 | 約 5 秒 |
| Rust リリースビルド | 約 10 分 | 約 1〜2 分 |
| NSIS パッケージング | 約 5 秒 | 約 5 秒 |

Rust のインクリメンタルビルドは `src-tauri/target/` キャッシュに依存します。  
`target/` を削除した場合は初回所要時間に戻ります。

---

## ビルドの設定ファイル

| ファイル | 役割 |
|---------|------|
| `src-tauri/tauri.conf.json` | バンドル設定（バージョン・アイコン・NSIS オプション） |
| `src-tauri/Cargo.toml` | Rust 依存クレート |
| `vite.config.ts` | フロントエンドビルド設定 |
| `scripts/build-portable.ps1` | ポータブル ZIP 作成スクリプト |

---

## トラブルシューティング

**`makensis` が見つからない**  
→ NSIS をインストールして `PATH` に追加してください。

**`リリースバイナリが見つかりません`（ポータブルビルド時）**  
→ `npm run build:installer` を先に実行するか、`-BuildFirst` スイッチを使ってください。

**Rust ビルドエラー**  
→ `rustup update stable` で Rust を最新の stable に更新してください。

**フロントエンドの型エラー**  
→ `npm install` を実行して依存関係を確認してください。
