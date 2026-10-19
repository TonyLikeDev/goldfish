; Windows installer tweaks (electron-builder picks this file up automatically).

; Updates and uninstall delete the install folder with everything in it, so the folder page greys out
; Install for a folder that already holds other files. $1 is where instFilesPre (assistedInstaller.nsh)
; installs: the chosen folder if its path contains "Goldfish", else a Goldfish folder inside it.
; customHeader is inserted after assistedInstaller.nsh, which defines StrContains; this file comes before it.
!ifndef BUILD_UNINSTALLER
  ; ponytail: English in every installer language (the app is English-only); use a LangString if Goldfish gets translated
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Pick an empty folder or an existing Goldfish folder. Goldfish creates its own folder inside any other folder you choose."
!endif
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function .onVerifyInstDir
      StrCpy $1 $INSTDIR
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${if} $0 == ""
        StrCpy $1 "$INSTDIR\${APP_FILENAME}"
      ${endIf}
      ${DirState} $1 $0
      ${if} $0 == 1
      ${andIfNot} ${FileExists} "$1\${APP_EXECUTABLE_FILENAME}"
        Abort
      ${endIf}
    FunctionEnd
  !endif
!macroend

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
; but keep it when an update reinstalls the app. Same for electron-updater's download cache
; (package.json "name" + "-updater"), which is per user even for an all-users install.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    SetShellVarContext current
    RMDir /r "$LOCALAPPDATA\goldfish-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend
