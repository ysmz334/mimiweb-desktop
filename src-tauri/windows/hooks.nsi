; インストール前フック: 既存データが残っている場合に削除を提案
!macro NSIS_HOOK_PREINSTALL
  ; サイレントモード（自動アップデート等）では削除しない
  IfSilent mimiweb_install_skip_delete

  ; どちらかのデータフォルダが存在する場合のみダイアログを表示
  IfFileExists "$APPDATA\com.mimiweb.desktop\*.*" mimiweb_install_has_data 0
  IfFileExists "$LOCALAPPDATA\com.mimiweb.desktop\*.*" mimiweb_install_has_data mimiweb_install_skip_delete

  mimiweb_install_has_data:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "既存のアプリデータが見つかりました。$\n$\n  ・登録記事・再生履歴・設定$\n  ・音声キャッシュ$\n$\nインストール前にデータを削除しますか？$\n$\n「いいえ」を選ぶとデータが保持され、インストール後も引き継がれます。" \
    IDNO mimiweb_install_skip_delete

  RMDir /r "$APPDATA\com.mimiweb.desktop"
  RMDir /r "$LOCALAPPDATA\com.mimiweb.desktop"

  mimiweb_install_skip_delete:
!macroend

; アンインストール後フック: アプリデータの削除を選択的に実行
!macro NSIS_HOOK_POSTUNINSTALL
  ; サイレントモード（自動アップデート等）では削除しない
  IfSilent mimiweb_skip_delete

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "アプリデータを削除しますか？$\n$\n  ・登録記事・再生履歴・設定$\n  ・音声キャッシュ$\n$\n「いいえ」を選ぶとデータが保持され、再インストール後も引き継がれます。" \
    IDNO mimiweb_skip_delete

  RMDir /r "$APPDATA\com.mimiweb.desktop"
  RMDir /r "$LOCALAPPDATA\com.mimiweb.desktop"

  mimiweb_skip_delete:
!macroend
