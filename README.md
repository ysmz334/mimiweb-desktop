# mimiweb-desktop

**日本語** | [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/ysmz334/mimiweb-desktop)](https://github.com/ysmz334/mimiweb-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ysmz334/mimiweb-desktop/total)](https://github.com/ysmz334/mimiweb-desktop/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078d6)

**「あとで読む」は、もう読まない。積読記事を、耳で消化する。**

気になった記事を保存したまま、読まずに溜めていませんか？
mimiweb-desktop は、溜まった Web 記事を VOICEVOX（日本語）・Piper（英語）の高品質音声で読み上げる、Windows 向けのフリーソフトウェアです。
URL を登録するだけ。PC 作業や家事のあいだに、積読が耳から消化されていきます。

![再生中のビューア：読み上げ位置をハイライト追従](docs/images/screenshot-viewer.png)

---

## こんな人のためのアプリです

- 「あとで読む」サービスやブックマークに記事が溜まり続けている
- PC 作業中・家事中に耳が空いていて、その時間で記事を消化したい
- ブラウザの読み上げ機能では声の質や記事管理に物足りなさを感じる

## 積読を消化するための機能

**溜める** — URL 登録だけ。クリップボード監視でコピーした URL を自動検出。本文はリーダービューで自動抽出（複数ページ記事も自動連結）

**見つける** — 「積読期間」フィルタで *1週間・1ヶ月・3ヶ月以上放置している記事* を掘り起こし。未再生バッジ・キーワード検索・お気に入り

**聴く** — VOICEVOX による自然な日本語読み上げ、Piper TTS による英語読み上げ（言語自動検出）。読み上げ中の文章をハイライト追従するテキストビューア。再生キューはドラッグ＆ドロップで並び替え

**時短する** — 「要点」モード：TF-IDF で抽出した重要文だけを読み上げ。バックグラウンド合成で待ち時間なし

**振り返る** — GitHub 風カレンダーヒートマップで消化の積み重ねを可視化。再生履歴・統計・ワードクラウド（TF-IDF キーワード分析）

そのほか：ライト / ダークテーマ、キーバインドカスタマイズ、完全ローカル動作（記事データ・音声・履歴を外部サーバーに送信しません）

## スクリーンショット

> 画面内の記事はすべて紹介用のサンプルです。

**「1ヶ月以上前 × 未再生」フィルタで、放置している記事を掘り起こす：**

![積読フィルタで未再生記事を絞り込んだ記事一覧](docs/images/screenshot-articles.png)

**カレンダーヒートマップで「耳読書」の積み重ねを可視化：**

![再生活動のカレンダーヒートマップと統計](docs/images/screenshot-history.png)

**ダークテーマ：**

![ダークテーマの記事一覧](docs/images/screenshot-dark.png)

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

1. [最新リリース](https://github.com/ysmz334/mimiweb-desktop/releases/latest)から `mimiweb-desktop-x.x.x-windows-x64-setup.exe` をダウンロード
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
（ソースコードは本リポジトリで全公開しており、配布物のチェックサムも各リリースに掲載しています）

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

[GitHub の Issues](https://github.com/ysmz334/mimiweb-desktop/issues) よりお知らせください。
ログファイル（`%APPDATA%\com.mimiweb.desktop\logs\`）を添付いただくと解決が早まります。
