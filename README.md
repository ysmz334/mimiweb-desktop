# mimiweb-desktop

Web記事を「ながら聴き」できる Windows 向けデスクトップアプリです。  
URL を登録するだけで、VOICEVOX（日本語）・Piper TTS（英語）による高品質な読み上げが始まります。

> **フリーソフトウェア** — 無料でご利用いただけます。

---

## 主な機能

- **日本語記事**: VOICEVOX による自然な日本語読み上げ
- **英語記事**: Piper TTS (en_US-ryan-high) による英語読み上げ・言語自動検出
- **記事管理**: URL 登録・手動またはクリップボード自動検出
- **テキストビューア**: 読み上げ中の文章をハイライト追従・自動スクロール
- **バックグラウンド合成**: 再生中に後続文章を先行合成してキャッシュ
- **ワードクラウド**: TF-IDF キーワード分析（日本語形態素解析 / 英語 Porter2 語幹処理）
- **履歴・統計**: カレンダーヒートマップ付き再生履歴
- **再生キュー**: ドラッグ＆ドロップ並び替え
- **ライト / ダークテーマ**
- **キーバインドカスタマイズ**

---

## 動作環境

| 項目 | 要件 |
|---|---|
| OS | Windows 10 / 11 (64bit) |
| WebView2 | Windows 11 は標準搭載。Windows 10 は [こちら](https://developer.microsoft.com/ja-jp/microsoft-edge/webview2/) からインストール |
| ディスク | 約 1 GB（VOICEVOX エンジン含む） |

---

## インストール

### インストーラー版（推奨）

1. 最新リリースから `mimiweb-desktop-x.x.x-windows-x64-setup.exe` をダウンロード
2. 実行してインストール
3. デスクトップのショートカットから起動

### ポータブル版

1. `mimiweb-desktop-x.x.x-windows-x64.zip` をダウンロード
2. 任意のフォルダに展開
3. `mimiweb-desktop.exe` を直接実行

### チェックサム確認（任意）

```powershell
(Get-FileHash "mimiweb-desktop-x.x.x-windows-x64.zip" -Algorithm SHA256).Hash
```

`SHA256SUMS.txt` に記載のハッシュ値と一致することを確認してください。

---

## 初回セットアップ

### VOICEVOX エンジン（日本語 TTS）

起動時にエンジン未検出の場合、自動でセットアップ画面が表示されます。  
「ダウンロードして使用を開始する」ボタンを押すと自動取得・展開します（約 400 MB）。

### Piper TTS（英語 TTS）

英語記事の読み上げが必要な場合のみ必要です。  
「設定」タブ → 「英語 TTS (Piper)」→「ダウンロード」ボタンでインストールします（約 100 MB）。

---

## ご注意

### Windows SmartScreen 警告について

コード署名証明書を取得していないため、初回インストール時に  
「Windows によって PC が保護されました」という警告が表示されます。

「詳細情報」→「実行」をクリックすることでインストールできます。

### VOICEVOX キャラクターの利用規約

VOICEVOX の各キャラクター音声ライブラリには、キャラクターごとに個別の利用規約があります。  
使用前に [VOICEVOX 公式サイト](https://voicevox.hiroshiba.jp/) および各キャラクターの規約をご確認ください。

---

## データの保存場所

すべてのデータはローカルに保存されます。外部サーバーへのデータ送信は行いません（バージョンチェックを除く）。

| データ | 保存場所 |
|---|---|
| データベース | `%APPDATA%\com.mimiweb.desktop\mimiweb.db` |
| ログ | `%APPDATA%\com.mimiweb.desktop\logs\` |
| 音声キャッシュ | ブラウザの IndexedDB（WebView2） |

アプリのアンインストール後も `%APPDATA%\com.mimiweb.desktop\` フォルダが残ります。  
不要な場合は手動で削除してください。

---

## ソースからビルド

開発環境のセットアップ手順・インストーラ / ポータブル版のビルド方法は  
[docs/build.md](./docs/build.md) を参照してください。

---

## ライセンス

このアプリケーション自体のソースコードは **MIT License** のもとで公開されています。  
詳細は [LICENSE](./LICENSE) を参照してください。

> フリーソフトウェアとして無料でご利用いただけます。

### 使用ライブラリ

| ライブラリ | ライセンス |
|---|---|
| [Piper TTS](https://github.com/rhasspy/piper) | MIT © Rhasspy contributors |
| [en_US-ryan-high voice](https://huggingface.co/rhasspy/piper-voices) | **CC BY 4.0** © Rhasspy contributors |
| [VOICEVOX](https://voicevox.hiroshiba.jp/) | MIT © Hiroshiba Kazuyuki |
| [@mozilla/readability](https://github.com/mozilla/readability) | Apache 2.0 © Mozilla Foundation |
| [lamejs](https://github.com/zhuker/lamejs) | LGPL 3.0 © zhuker |
| [Tauri](https://tauri.app/) | MIT / Apache 2.0 © Tauri Programme |
| [lindera](https://github.com/lindera/lindera) | MIT / Apache 2.0 |
| [rust-stemmers](https://github.com/CurrySoftware/rust-stemmers) | MIT / Apache 2.0 |
| [d3-cloud](https://github.com/jasondavies/d3-cloud) | MIT © Jason Davies |
| [React](https://react.dev/) | MIT © Meta Platforms, Inc. |

詳細は [NOTICE.md](./NOTICE.md) を参照してください。

---

## 開発について

本アプリは、Anthropic の AI コーディングエージェント
[Claude Code](https://www.anthropic.com/claude-code) と対話しながら開発されました。

---

## 不具合報告・要望

GitHub の Issues よりお知らせください。  
ログファイル（`%APPDATA%\com.mimiweb.desktop\logs\`）を添付いただくと解決が早まります。
