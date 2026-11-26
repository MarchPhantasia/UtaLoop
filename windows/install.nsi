Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"

!ifndef INSTALL_ID
  !define INSTALL_ID "Desktop"
!endif
!ifndef DISPLAY_NAME
  !define DISPLAY_NAME "UtaLoop"
!endif
!define INSTALL_KEY "Software\UtaLoop\${INSTALL_ID}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\UtaLoop.${INSTALL_ID}"
!define MARKER "utaloop-desktop-release.txt"
!define RUNTIME_MARKER "utaloop-desktop-runtime.txt"
!define RUNTIME_TRANSFER_MARKER "utaloop-desktop-transfer.txt"
!define NETEASE_MODULES "services\netease\node_modules"
!define INSTALL_MUTEX "Local\UtaLoop.Windows.Desktop"

Name "${DISPLAY_NAME} ${VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$DOCUMENTS\Apps\${DISPLAY_NAME}"
InstallDirRegKey HKCU "${INSTALL_KEY}" "InstallLocation"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${DISPLAY_NAME}"
VIAddVersionKey "FileDescription" "UtaLoop Windows 安装程序"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "UtaLoop and Lingua contributors"

Var Lock
Var ExistingDirectory

!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "打开 UtaLoop"
!define MUI_FINISHPAGE_RUN_FUNCTION StartApp
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro StopInstallation MESSAGE
  MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}" /SD IDOK
  SetErrorLevel 1
  Abort
!macroend

!macro LockInstallation
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${INSTALL_MUTEX}") p.r9 ?e'
  Pop $0
  StrCpy $Lock $9
  ${If} $Lock == 0
  ${OrIf} $0 == 183
    !insertmacro StopInstallation "请先关闭 UtaLoop 和其他安装窗口，再重试。"
  ${EndIf}
!macroend

; The only directories ever removed are owned payloads directly under $INSTDIR.
!macro CheckPayload DIRECTORY
  System::Call 'kernel32::GetFileAttributesW(w "${DIRECTORY}") i.r1'
  ${If} $1 <> -1
    IntOp $2 $1 & 0x410
    ${If} $2 <> 0x10
      !insertmacro StopInstallation "安装程序无法安全处理 ${DIRECTORY}。请选择另一个安装目录。"
    ${EndIf}
    ${IfNot} ${FileExists} "${DIRECTORY}\${MARKER}"
      !insertmacro StopInstallation "${DIRECTORY} 已被其他文件使用。请选择另一个安装目录。"
    ${EndIf}
  ${EndIf}
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    !insertmacro StopInstallation "这个安装包需要 64 位 Windows。"
  ${EndIf}
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 528040
    !insertmacro StopInstallation "请启用 Windows 的 .NET Framework 4.8 或更新版本，再安装 UtaLoop。"
  ${EndIf}
  SetShellVarContext current
  !insertmacro LockInstallation
  ReadRegStr $ExistingDirectory HKCU "${INSTALL_KEY}" "InstallLocation"
  ${If} $ExistingDirectory != ""
    StrCpy $INSTDIR $ExistingDirectory
  ${EndIf}
!ifdef UPDATE_FROM
  ${If} $ExistingDirectory == ""
    !insertmacro StopInstallation "此更新包需要已安装的 UtaLoop ${UPDATE_FROM}。首次安装请选择完整安装包。"
  ${EndIf}
!endif
FunctionEnd

Function DirectoryPage
  ${If} $ExistingDirectory != ""
    Abort
  ${EndIf}
FunctionEnd

Function StartApp
  System::Call 'kernel32::CloseHandle(p $Lock)'
  Exec '"$INSTDIR\app\UtaLoop.exe"'
FunctionEnd

Function RestorePrevious
  ClearErrors
  ${If} ${FileExists} "$INSTDIR\app.pending\${RUNTIME_TRANSFER_MARKER}"
    ; A fast update may have already moved one or both directories to the staging area.
    ${If} ${FileExists} "$INSTDIR\app.pending\runtime\*.*"
      Rename "$INSTDIR\app.pending\runtime" "$INSTDIR\app.previous\runtime"
      IfErrors restore_failed
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\app.pending\${NETEASE_MODULES}\*.*"
      Rename "$INSTDIR\app.pending\${NETEASE_MODULES}" "$INSTDIR\app.previous\${NETEASE_MODULES}"
      IfErrors restore_failed
    ${EndIf}
  ${EndIf}
  Rename "$INSTDIR\app.previous" "$INSTDIR\app"
  IfErrors restore_failed
  Return

restore_failed:
  !insertmacro StopInstallation "暂时无法恢复旧版 UtaLoop。请关闭占用安装目录的程序后重试。"
FunctionEnd

!ifdef UPDATE_FROM
Function ReuseRuntime
  DetailPrint "正在复用本机运行组件…"
  ClearErrors
  Rename "$INSTDIR\app.previous\runtime" "$INSTDIR\app.pending\runtime"
  IfErrors reuse_failed
  Rename "$INSTDIR\app.previous\${NETEASE_MODULES}" "$INSTDIR\app.pending\${NETEASE_MODULES}"
  IfErrors reuse_failed
  Return

reuse_failed:
  Call RestorePrevious
  !insertmacro StopInstallation "无法移动原有运行组件，已恢复旧版。请关闭占用安装目录的程序后重试。"
FunctionEnd
!endif

Section "UtaLoop"
  ClearErrors
  CreateDirectory "$INSTDIR"
  ${If} ${Errors}
    !insertmacro StopInstallation "当前用户无法写入安装目录。请换一个可写的文件夹。"
  ${EndIf}
  GetFullPathName $INSTDIR "$INSTDIR"
  ${If} $INSTDIR == ""
    !insertmacro StopInstallation "无法定位安装目录。"
  ${EndIf}
  !insertmacro CheckPayload "$INSTDIR\app"
  !insertmacro CheckPayload "$INSTDIR\app.pending"
  !insertmacro CheckPayload "$INSTDIR\app.previous"

  ClearErrors
  SetOutPath "$INSTDIR"
  ${If} ${Errors}
    !insertmacro StopInstallation "当前用户无法写入安装目录。请换一个可写的文件夹。"
  ${EndIf}

  ${IfNot} ${FileExists} "$INSTDIR\app\${MARKER}"
    ${If} ${FileExists} "$INSTDIR\app.previous\${MARKER}"
      Call RestorePrevious
    ${EndIf}
  ${EndIf}
  StrCpy $3 ""
  ${If} ${FileExists} "$INSTDIR\app\${MARKER}"
    FileOpen $0 "$INSTDIR\app\${MARKER}" r
    FileRead $0 $3
    FileClose $0
    ${VersionCompare} "${VERSION}" "$3" $0
    ${If} $0 == 2
      !insertmacro StopInstallation "该位置已安装较新的 UtaLoop。请使用同版本或更新版本的安装包。"
    ${EndIf}
  ${EndIf}

!ifdef UPDATE_FROM
  ${If} $3 != "${UPDATE_FROM}"
    !insertmacro StopInstallation "此更新包适用于 UtaLoop ${UPDATE_FROM}。其他版本请使用完整安装包升级。"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\app\${RUNTIME_MARKER}"
    FileOpen $0 "$INSTDIR\app\${RUNTIME_MARKER}" r
    FileRead $0 $4
    FileClose $0
    ${If} $4 != "${RUNTIME_ID}"
      !insertmacro StopInstallation "当前运行组件与更新包不匹配。请使用完整安装包升级。"
    ${EndIf}
!if "${UPDATE_FROM}" != "0.1.0"
  ${Else}
    !insertmacro StopInstallation "当前安装的运行组件无法确认。请使用完整安装包升级。"
!endif
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\app\runtime\node\node.exe"
  ${OrIfNot} ${FileExists} "$INSTDIR\app\runtime\python\python.exe"
  ${OrIfNot} ${FileExists} "$INSTDIR\app\runtime\python\site-packages\unidic_lite\dicdir\sys.dic"
  ${OrIfNot} ${FileExists} "$INSTDIR\app\${NETEASE_MODULES}\@neteasecloudmusicapienhanced\api\package.json"
    !insertmacro StopInstallation "当前安装缺少运行组件。请使用完整安装包升级。"
  ${EndIf}
!endif

  RMDir /r "$INSTDIR\app.previous"
  RMDir /r "$INSTDIR\app.pending"
  ClearErrors
  SetOutPath "$INSTDIR\app.pending"
  FileOpen $0 "$INSTDIR\app.pending\${MARKER}" w
  ${If} ${Errors}
    !insertmacro StopInstallation "无法写入安装目录。"
  ${EndIf}
  FileWrite $0 "${VERSION}"
  FileClose $0
  File /r "${PAYLOAD}\*.*"
  SetOutPath "$INSTDIR"
  ${If} ${Errors}
    !insertmacro StopInstallation "安装文件未能完整写入。请检查磁盘空间后重试。"
  ${EndIf}

!ifdef UPDATE_FROM
  CopyFiles /SILENT "$INSTDIR\app\licenses\UniDic*.txt" "$INSTDIR\app.pending\licenses"
  ${If} ${Errors}
    !insertmacro StopInstallation "无法保留运行组件的许可文件。请使用完整安装包升级。"
  ${EndIf}
  ; Record the transfer before renaming app so a retry can restore either move.
  FileOpen $0 "$INSTDIR\app.pending\${RUNTIME_TRANSFER_MARKER}" w
  ${If} ${Errors}
    !insertmacro StopInstallation "无法准备运行组件的迁移。请检查磁盘权限后重试。"
  ${EndIf}
  FileClose $0
!endif

  ${If} ${FileExists} "$INSTDIR\app\${MARKER}"
    Rename "$INSTDIR\app" "$INSTDIR\app.previous"
    ${If} ${Errors}
      !insertmacro StopInstallation "无法替换当前版本。请关闭 UtaLoop 后重试。"
    ${EndIf}
  ${EndIf}
!ifdef UPDATE_FROM
  Call ReuseRuntime
!endif
  Rename "$INSTDIR\app.pending" "$INSTDIR\app"
  ${If} ${Errors}
    ${If} ${FileExists} "$INSTDIR\app.previous\${MARKER}"
      Call RestorePrevious
    ${EndIf}
    !insertmacro StopInstallation "未能启用新版本，请重新运行安装包。"
  ${EndIf}
!ifdef UPDATE_FROM
  Delete "$INSTDIR\app\${RUNTIME_TRANSFER_MARKER}"
!endif

  WriteUninstaller "$INSTDIR\Uninstall UtaLoop.exe"
  CreateDirectory "$SMPROGRAMS\${DISPLAY_NAME}"
  CreateShortcut "$SMPROGRAMS\${DISPLAY_NAME}\UtaLoop.lnk" "$INSTDIR\app\UtaLoop.exe"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\UtaLoop OBS 兼容模式.lnk"
  WriteRegStr HKCU "${INSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\app\UtaLoop.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall UtaLoop.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  RMDir /r "$INSTDIR\app.previous"
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext current
  !insertmacro LockInstallation
FunctionEnd

Section "Uninstall"
  GetFullPathName $INSTDIR "$INSTDIR"
  ${If} $INSTDIR == ""
    !insertmacro StopInstallation "无法定位 UtaLoop 的安装目录。"
  ${EndIf}
  !insertmacro CheckPayload "$INSTDIR\app"
  !insertmacro CheckPayload "$INSTDIR\app.pending"
  !insertmacro CheckPayload "$INSTDIR\app.previous"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\app.pending"
  RMDir /r "$INSTDIR\app.previous"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\UtaLoop.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\UtaLoop OBS 兼容模式.lnk"
  RMDir "$SMPROGRAMS\${DISPLAY_NAME}"
  DeleteRegKey HKCU "${INSTALL_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\Uninstall UtaLoop.exe"
  RMDir "$INSTDIR"
SectionEnd
