; OSMOS Windows Installer - NSIS Script
; Compile with makensis.exe

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

; Basic settings
Name "OSMOS"
OutFile "OSMOS-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES\OSMOS"
InstallDirRegKey HKCU "Software\OSMOS" "InstallDir"
RequestExecutionLevel admin

; MUI settings
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\OSMOS.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; Languages
!insertmacro MUI_LANGUAGE "English"

; Sections
Section "Main" SecMain
  SetOutPath "$INSTDIR"
  
  ; Extract files
  File /r "release\win-unpacked\*"
  
  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"
  
  ; Write registry
  WriteRegStr HKCU "Software\OSMOS" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\OSMOS" "Version" "${VERSION}"
  
  ; Create shortcuts
  CreateDirectory "$SMPROGRAMS\OSMOS"
  CreateShortCut "$SMPROGRAMS\OSMOS\OSMOS.lnk" "$INSTDIR\OSMOS.exe"
  CreateShortCut "$DESKTOP\OSMOS.lnk" "$INSTDIR\OSMOS.exe"
  
  ; Add to PATH (optional)
  ; WriteRegStr HKCU "Environment" "PATH" "$PATH;$INSTDIR"
SectionEnd

Section "Node.js" SecNode
  ; Download and install Node.js if not present
  ${IfNot} ${FileExists} "$SYSDIR\node.exe"
    ; Use Chocolatey if available
    ${If} ${FileExists} "$SYSDIR\choco.exe"
      nsExec::Exec 'choco install nodejs --version=22.22.2 -y'
    ${Else}
      ; Download and run Node.js installer
      StrCpy $0 "$TEMP\node-v22.22.2-x64.msi"
      nsisdl::download "https://nodejs.org/dist/v22.22.2/node-v22.22.2-x64.msi" $0
      ${If} ${FileExists} $0
        ExecWait 'msiexec /i "$0" /quiet /norestart'
        Delete $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
SectionEnd

Section "ffmpeg" SecFFmpeg
  ${IfNot} ${FileExists} "$INSTDIR\ffmpeg.exe"
    ${If} ${FileExists} "$SYSDIR\choco.exe"
      nsExec::Exec 'choco install ffmpeg -y'
      ; If choco installed it to a standard location, copy it to our install dir
      ${If} ${FileExists} "C:\ProgramData\chocolatey\bin\ffmpeg.exe"
        CopyFiles /SILENT "C:\ProgramData\chocolatey\bin\ffmpeg.exe" "$INSTDIR\ffmpeg.exe"
      ${EndIf}
      ${If} ${FileExists} "C:\Program Files\ffmpeg\bin\ffmpeg.exe"
        CopyFiles /SILENT "C:\Program Files\ffmpeg\bin\ffmpeg.exe" "$INSTDIR\ffmpeg.exe"
      ${EndIf}
    ${Else}
      ; Download ffmpeg standalone build and extract ffmpeg.exe
      StrCpy $0 "$TEMP\ffmpeg-master-latest-win64-gpl.zip"
      nsisdl::download "https://www.gyan.dev/ffmpeg/builds/ffmpeg-master-latest-win64-gpl.zip" $0
      ${If} ${FileExists} $0
        ; Extract using PowerShell
        nsExec::ExecToStack 'powershell -Command "Expand-Archive -Path '\''$0'\'' -DestinationPath '\''$TEMP\ffmpeg-extract'\'' -Force"'
        ; Find ffmpeg.exe in extracted folder
        FindFirst $1 $2 "$TEMP\ffmpeg-extract\*\bin\ffmpeg.exe"
        ${If} $2 != ""
          CopyFiles /SILENT "$TEMP\ffmpeg-extract\$2\bin\ffmpeg.exe" "$INSTDIR\ffmpeg.exe"
        ${EndIf}
        FindClose $1
        ; Cleanup
        RMDir /r "$TEMP\ffmpeg-extract"
        Delete $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Dependencies" SecDeps
  ; Install Visual C++ Redistributable if needed
  ${IfNot} ${FileExists} "$SYSDIR\msvcp140.dll"
    ExecWait 'msiexec /i "vc_redist.x64.exe" /quiet /norestart'
  ${EndIf}
SectionEnd

; Installer section order
Section /o "Required Components" SecRequired
  SectionIn RO
  SectionIn 1 2 3 4
SectionEnd

; Functions
Function .onInit
  StrCpy $VERSION "0.5.0"

  ; Check for required Windows version
  ${If} ${AtLeastWinVista}
    ; Windows 7+
  ${Else}
    MessageBox MB_ICONSTOP "OSMOS requires Windows 7 or later."
    Abort
  ${EndIf}
  
  ; Check for admin rights
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 != "Admin"
    MessageBox MB_ICONSTOP "Administrator privileges required."
    Abort
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ; Register file associations (if needed)
  WriteRegStr HKCU "Software\OSMOS" "Installed" "1"
  WriteRegStr HKCU "Software\OSMOS" "InstallDate" "$(GetTime)"
FunctionEnd

Function un.onUninstallSuccess
  DeleteRegKey HKCU "Software\OSMOS"
FunctionEnd

; Variables
Var VERSION

; Load functions
Function GetTime
  Push $0
  System::Call 'kernel32::GetLocalTime(s.r0)'
  StrCpy $0 $0 2
  StrCpy $1 $0 2 2
  StrCpy $2 $0 4 4
  StrCpy $3 $0 2 6
  StrCpy $4 $0 2 8
  StrCpy $5 $0 2 10
  Pop $0
  StrCpy $R0 "$2-$1-$0 $3:$4:$5"
FunctionEnd

; Entry point