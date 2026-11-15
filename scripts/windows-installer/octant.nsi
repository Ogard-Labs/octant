; Per-user Windows installer for the Octant desktop app.
;
; scripts/package-windows-installer.ts compiles this twice. The first build
; (WRITE_UNINSTALLER_TO) only writes the uninstaller, so the release workflow
; can sign it; the second (SIGNED_UNINSTALLER) carries that signed file and the
; app. Every name and path arrives as a define; the file lists are generated
; from the packaged directory, so the uninstaller removes exactly what this
; version installed and nothing else (docs/architecture.md, "Current Release
; Boundary").

Unicode true
ManifestDPIAware true
; No elevation: everything below lives in the current user's profile and
; HKCU, so the installer never asks for administrator rights and never
; touches another user's files.
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh

!macro OCTANT_REQUIRE NAME
  !ifndef ${NAME}
    !error "package-windows-installer.ts must define ${NAME}"
  !endif
!macroend
!insertmacro OCTANT_REQUIRE PRODUCT_NAME
!insertmacro OCTANT_REQUIRE BUNDLE_ID
!insertmacro OCTANT_REQUIRE URL_SCHEME
!insertmacro OCTANT_REQUIRE PUBLISHER
!insertmacro OCTANT_REQUIRE DISPLAY_VERSION
!insertmacro OCTANT_REQUIRE NUMERIC_VERSION
!insertmacro OCTANT_REQUIRE OUT_FILE
!insertmacro OCTANT_REQUIRE UNINSTALL_FILES
!ifndef WRITE_UNINSTALLER_TO
  !insertmacro OCTANT_REQUIRE SIGNED_UNINSTALLER
  !insertmacro OCTANT_REQUIRE INSTALL_FILES
  !insertmacro OCTANT_REQUIRE ESTIMATED_SIZE_KB
!endif

!define EXE "${PRODUCT_NAME}.exe"
!define UNINSTALLER "Uninstall ${PRODUCT_NAME}.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BUNDLE_ID}"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
; Wait up to a minute (120 half-second tries) for the running app to exit,
; the same bound a relaunched Linux image waits for the process it replaces.
!define WAIT_ATTEMPTS 120

Name "${PRODUCT_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
BrandingText "${PRODUCT_NAME} ${DISPLAY_VERSION}"

VIProductVersion "${NUMERIC_VERSION}"
VIFileVersion "${NUMERIC_VERSION}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey "FileVersion" "${DISPLAY_VERSION}"
VIAddVersionKey "ProductVersion" "${DISPLAY_VERSION}"

Page instfiles
!ifdef WRITE_UNINSTALLER_TO
  UninstPage uninstConfirm
  UninstPage instfiles
!endif

; Waits until the installed program file can be opened for writing, which
; Windows refuses while any process (a window or a host) runs from it. Sets
; $0 to "free" or "busy".
!macro OCTANT_WAIT_FOR_APP_EXIT PREFIX
  Function ${PREFIX}WaitForAppExit
    StrCpy $0 "free"
    ${IfNot} ${FileExists} "$INSTDIR\${EXE}"
      Return
    ${EndIf}
    StrCpy $1 0
    ${Do}
      ClearErrors
      FileOpen $2 "$INSTDIR\${EXE}" a
      ${IfNot} ${Errors}
        FileClose $2
        Return
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= ${WAIT_ATTEMPTS}
        StrCpy $0 "busy"
        Return
      ${EndIf}
      Sleep 500
    ${Loop}
  FunctionEnd
!macroend

!ifdef WRITE_UNINSTALLER_TO

Function .onInit
  ; This build only writes the uninstaller for signing, then exits.
  WriteUninstaller "${WRITE_UNINSTALLER_TO}"
  SetErrorLevel 0
  Quit
FunctionEnd

Section "Uninstaller only"
SectionEnd

!insertmacro OCTANT_WAIT_FOR_APP_EXIT "un."

Function un.onInit
  SetShellVarContext current
  ; The uninstaller acts only on the installer's fixed location. Started from
  ; anywhere else (a copy, or `_?=` naming another folder) it removes nothing.
  ${If} "$INSTDIR" != "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
    IfSilent +2
      MessageBox MB_ICONSTOP "This uninstaller only removes ${PRODUCT_NAME} from $LOCALAPPDATA\Programs\${PRODUCT_NAME}."
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.WaitForAppExit
  ${If} $0 == "busy"
    IfSilent +2
      MessageBox MB_ICONSTOP "Quit ${PRODUCT_NAME} and try again."
    SetErrorLevel 3
    Quit
  ${EndIf}

  ; Exactly the files this version installed, then each of its folders if it
  ; is empty. Nothing the app or the person wrote elsewhere is touched: data
  ; lives under $LOCALAPPDATA\${PRODUCT_NAME} and $APPDATA, never here.
  !include "${UNINSTALL_FILES}"

  ; An update keeps what the person sees (the Start menu entry they may have
  ; pinned, the Apps list entry); the new version writes them again.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/update" $R1
  ${If} ${Errors}
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    ; Registrations the app wrote for itself, removed only while they still
    ; name this copy's program.
    ReadRegStr $R2 HKCU "Software\Classes\${URL_SCHEME}\shell\open\command" ""
    ${WordFind} "$R2" "$INSTDIR\${EXE}" "E+1{" $R3
    ${IfNot} ${Errors}
      DeleteRegKey HKCU "Software\Classes\${URL_SCHEME}"
    ${EndIf}
    StrCpy $R4 0
    ${Do}
      ClearErrors
      EnumRegValue $R5 HKCU "${RUN_KEY}" $R4
      ${If} ${Errors}
      ${OrIf} $R5 == ""
        ${Break}
      ${EndIf}
      ReadRegStr $R2 HKCU "${RUN_KEY}" $R5
      ClearErrors
      ${WordFind} "$R2" "$INSTDIR\${EXE}" "E+1{" $R3
      ${If} ${Errors}
        IntOp $R4 $R4 + 1
      ${Else}
        DeleteRegValue HKCU "${RUN_KEY}" $R5
      ${EndIf}
    ${Loop}
    Delete "$INSTDIR\${UNINSTALLER}"
    RMDir "$INSTDIR"
  ${EndIf}
SectionEnd

!else

Var Relaunch

!insertmacro OCTANT_WAIT_FOR_APP_EXIT ""

Function .onInit
  SetShellVarContext current
  ; The location is fixed, so an update always finds the copy it replaces and
  ; the uninstaller's file list never meets a folder the person chose.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/relaunch" $R1
  ${If} ${Errors}
    StrCpy $Relaunch "no"
  ${Else}
    StrCpy $Relaunch "yes"
  ${EndIf}
FunctionEnd

; Leaves the installed copy as it was and, for an update, starts it again.
!macro OCTANT_REFUSE CODE MESSAGE
  ${If} $Relaunch == "yes"
  ${AndIf} ${FileExists} "$INSTDIR\${EXE}"
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
  IfSilent +2
    MessageBox MB_ICONSTOP "${MESSAGE}"
  SetErrorLevel ${CODE}
  Quit
!macroend

Section "Install"
  SetShellVarContext current
  Call WaitForAppExit
  ${If} $0 == "busy"
    !insertmacro OCTANT_REFUSE 3 "Quit ${PRODUCT_NAME} and run the installer again."
  ${EndIf}

  ; The previous version removes exactly what it installed, so nothing from
  ; it lingers beside the new files. Its own signed uninstaller does this, in
  ; place, before anything new is written.
  ${If} ${FileExists} "$INSTDIR\${UNINSTALLER}"
    ClearErrors
    ExecWait '"$INSTDIR\${UNINSTALLER}" /S /update _?=$INSTDIR' $R0
    ${If} ${Errors}
    ${OrIf} $R0 != 0
      !insertmacro OCTANT_REFUSE 4 "The installed ${PRODUCT_NAME} could not be removed before updating."
    ${EndIf}
    Delete "$INSTDIR\${UNINSTALLER}"
  ${EndIf}

  SetOverwrite on
  !include "${INSTALL_FILES}"
  SetOutPath "$INSTDIR"
  File "/oname=${UNINSTALLER}" "${SIGNED_UNINSTALLER}"

  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${DISPLAY_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_SIZE_KB}

  ${If} $Relaunch == "yes"
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
SectionEnd

!endif
