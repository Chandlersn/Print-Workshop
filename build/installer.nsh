!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; The directory page can accept a drive root. The app itself must still
    ; live in a subdirectory so an uninstall never targets the whole drive.
    AllowRootDirInstall true
  !endif
!macroend

!macro customInit
  ; The interactive directory page appends APP_FILENAME in instFilesPre.
  ; Silent /D=X:\ skips that page, so normalize the initial root here too.
  StrLen $0 $INSTDIR
  ${If} $0 == 3
    StrCpy $1 $INSTDIR 1 1
    ${If} $1 == ":"
      StrCpy $1 $INSTDIR 1 2
      ${If} $1 == "\"
        StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
