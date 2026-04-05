@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: DevTools++ Native Proxy Installer (Windows)
:: ============================================================

set "SCRIPT_DIR=%~dp0"
set "HOST_NAME=com.devtools_pp.proxy"
set "HOST_PATH=%SCRIPT_DIR%native-messaging-host.js"

:: Chrome / Chromium NM host manifest directories
set "CHROME_NM_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"
set "CHROMIUM_NM_DIR=%LOCALAPPDATA%\Chromium\User Data\NativeMessagingHosts"

:: ============================================================
:: 1. Extension ID
:: ============================================================
set "EXTENSION_ID=%~1"

if "%EXTENSION_ID%"=="" (
    echo.
    echo ============================================
    echo   DevTools++ Native Proxy Installer
    echo ============================================
    echo.
    echo Usage: install.bat ^<extension-id^>
    echo.
    echo How to find your Extension ID:
    echo   1. Open chrome://extensions in Chrome
    echo   2. Enable Developer Mode
    echo   3. Copy the ID of the DevTools++ extension
    echo      ^(e.g., abcdefghijklmnopqrstuvwxyz123456^)
    echo.
    exit /b 1
)

echo.
echo ============================================
echo   DevTools++ Native Proxy Installer
echo ============================================
echo.

:: ============================================================
:: 2. Check Node.js
:: ============================================================
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Please install it from https://nodejs.org and try again.
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo [OK] Node.js %NODE_VERSION% detected

:: ============================================================
:: 3. npm dependencies
:: ============================================================
echo.
echo [1/4] Installing npm dependencies...
cd /d "%SCRIPT_DIR%"
call npm install --production >nul 2>&1
echo [OK] Dependencies installed

:: ============================================================
:: 4. CA certificate
:: ============================================================
echo.
echo [2/4] Generating CA certificate...
for /f "tokens=*" %%p in ('node -e "const cg = require('./cert-generator'); cg.ensureCA(); console.log(cg.getCACertPath());"') do set "CA_PATH=%%p"
echo [OK] CA certificate: %CA_PATH%

:: ============================================================
:: 5. Native Messaging Host manifest
:: ============================================================
echo.
echo [3/4] Registering Native Messaging Host...

:: Escape backslashes in path for JSON
set "HOST_PATH_JSON=%HOST_PATH:\=\\%"

:: Find node.exe path
for /f "tokens=*" %%n in ('where node') do set "NODE_PATH=%%n"
set "NODE_PATH_JSON=%NODE_PATH:\=\\%"

:: Create batch wrapper to launch node with the host script
set "WRAPPER_PATH=%SCRIPT_DIR%native-messaging-host.bat"
(
    echo @echo off
    echo "%NODE_PATH%" "%HOST_PATH%" %%*
) > "%WRAPPER_PATH%"

set "WRAPPER_PATH_JSON=%WRAPPER_PATH:\=\\%"

:: Register for Chrome
if not exist "%CHROME_NM_DIR%" mkdir "%CHROME_NM_DIR%"
(
    echo {
    echo   "name": "%HOST_NAME%",
    echo   "description": "DevTools++ MITM Proxy Host",
    echo   "path": "%WRAPPER_PATH_JSON%",
    echo   "type": "stdio",
    echo   "allowed_origins": [
    echo     "chrome-extension://%EXTENSION_ID%/"
    echo   ]
    echo }
) > "%CHROME_NM_DIR%\%HOST_NAME%.json"
echo [OK] Chrome NM Host registered: %CHROME_NM_DIR%\%HOST_NAME%.json

:: Register for Chromium if present
if exist "%LOCALAPPDATA%\Chromium" (
    if not exist "%CHROMIUM_NM_DIR%" mkdir "%CHROMIUM_NM_DIR%"
    copy "%CHROME_NM_DIR%\%HOST_NAME%.json" "%CHROMIUM_NM_DIR%\%HOST_NAME%.json" >nul
    echo [OK] Chromium NM Host registered
)

:: Also register in Windows Registry (required for some Chrome versions)
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%CHROME_NM_DIR%\%HOST_NAME%.json" /f >nul 2>&1
echo [OK] Registry entry created

:: ============================================================
:: 6. Done
:: ============================================================
echo.
echo [4/4] Installation complete!
echo.
echo ============================================
echo   Trust CA Certificate (for HTTPS)
echo ============================================
echo.
echo Run the following in an Administrator Command Prompt:
echo.
echo   certutil -addstore -user "Root" "%CA_PATH%"
echo.
echo If you skip this, HTTP interception will still work
echo but HTTPS will show certificate errors.
echo.
echo ============================================
echo   Summary
echo ============================================
echo   Extension ID : %EXTENSION_ID%
echo   Proxy Host   : %HOST_PATH%
echo   CA Cert      : %CA_PATH%
echo   Proxy Port   : 8899 (default)
echo ============================================
echo.
echo Restart Chrome, then open DevTools++ Intercept tab
echo and select "Proxy Mode".
echo.
