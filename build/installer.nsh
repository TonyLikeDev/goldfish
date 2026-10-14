; Windows installer tweaks (electron-builder picks this file up automatically).

; Finish page with two tick boxes: run Goldfish, and create a desktop shortcut.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function CreateDesktopShortcut
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION StartApp
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
  !insertmacro MUI_PAGE_FINISH
!macroend

; The desktop shortcut is opt-in, so electron-builder doesn't track it: remove it on uninstall,
; but keep it when an update reinstalls the app.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${endIf}
!macroend
