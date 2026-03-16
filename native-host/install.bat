@echo off
REM ============================================================
REM  This script has moved! Run install.bat from the project root.
REM ============================================================
echo.
echo  Please run install.bat from the main folder (one level up).
echo.

set ROOT=%~dp0..
if exist "%ROOT%\install.bat" (
    call "%ROOT%\install.bat"
) else if exist "%ROOT%\install.ps1" (
    powershell.exe -ExecutionPolicy Bypass -File "%ROOT%\install.ps1"
    pause
) else (
    echo  ERROR: install.bat/install.ps1 not found in parent folder.
    pause
)
echo   Next steps:
echo     1. Reload the extension in edge://extensions/
echo     2. Click the extension icon - it should now detect your
echo        headset via Bluetooth
echo.
echo  ================================================================

endlocal
