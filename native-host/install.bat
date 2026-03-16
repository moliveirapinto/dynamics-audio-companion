@echo off
REM ============================================================
REM  Dynamics Audio Companion — Native Messaging Host Installer
REM  Run this AFTER loading the extension in Chrome/Edge.
REM  Usage: install.bat [extension-id]
REM  NO Node.js required — uses standalone dynamics-audio-companion.exe
REM ============================================================

setlocal enabledelayedexpansion

set EXTENSION_ID=%1

if "%EXTENSION_ID%"=="" (
    echo.
    echo  ================================================================
    echo   Dynamics Audio Companion — Native Messaging Host Installer
    echo  ================================================================
    echo.
    echo  To find your extension ID:
    echo    1. Open edge://extensions/ or chrome://extensions/
    echo    2. Enable "Developer mode" toggle (top right)
    echo    3. Find "Dynamics Audio Companion"
    echo    4. Copy the ID string below the extension name
    echo       (it looks like: abcdefghijklmnopqrstuvwxyz)
    echo.
    set /p EXTENSION_ID="  Enter extension ID: "
    echo.
)

if "!EXTENSION_ID!"=="" (
    echo  ERROR: No extension ID provided. Aborting.
    exit /b 1
)

REM Get the directory where this script lives
set SCRIPT_DIR=%~dp0
set HOST_EXE=%SCRIPT_DIR%dynamics-audio-companion.exe

REM Verify dynamics-audio-companion.exe exists
if not exist "%HOST_EXE%" (
    echo  ERROR: dynamics-audio-companion.exe not found in %SCRIPT_DIR%
    echo  Make sure you extracted all files from the zip.
    exit /b 1
)

REM Create the native messaging manifest pointing directly to the .exe
set MANIFEST_PATH=%SCRIPT_DIR%com.bose.d365.headset.json
set HOST_EXE_ESCAPED=%HOST_EXE:\=\\%

echo { > "%MANIFEST_PATH%"
echo   "name": "com.bose.d365.headset", >> "%MANIFEST_PATH%"
echo   "description": "Dynamics Audio Companion", >> "%MANIFEST_PATH%"
echo   "path": "%HOST_EXE_ESCAPED%", >> "%MANIFEST_PATH%"
echo   "type": "stdio", >> "%MANIFEST_PATH%"
echo   "allowed_origins": [ >> "%MANIFEST_PATH%"
echo     "chrome-extension://%EXTENSION_ID%/" >> "%MANIFEST_PATH%"
echo   ] >> "%MANIFEST_PATH%"
echo } >> "%MANIFEST_PATH%"

REM Register in Chrome registry
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.bose.d365.headset" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1

REM Register in Edge registry
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.bose.d365.headset" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1

REM Register in Chromium registry (generic)
reg add "HKCU\Software\Chromium\NativeMessagingHosts\com.bose.d365.headset" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1

echo.
echo  ================================================================
echo   Dynamics Audio Companion Native Host — INSTALLED SUCCESSFULLY
echo  ================================================================
echo.
echo   Extension ID: %EXTENSION_ID%
echo   Host exe:     %HOST_EXE%
echo   Manifest:     %MANIFEST_PATH%
echo.
echo   Registered for: Chrome, Edge, Chromium
echo   NO Node.js required!
echo.
echo   Next steps:
echo     1. Reload the extension in edge://extensions/
echo     2. Click the extension icon - it should now detect your
echo        headset via Bluetooth
echo.
echo  ================================================================

endlocal
