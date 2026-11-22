@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "LOG_DIR=%LOCALAPPDATA%\TAUF"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\runtime.log"

if exist "src-tauri\target\release\tauf.exe" (
    start "" "src-tauri\target\release\tauf.exe"
    exit /b 0
)

if exist "src-tauri\target\debug\tauf.exe" (
    start "" "src-tauri\target\debug\tauf.exe"
    exit /b 0
)

set "NODE_EXE="

if defined TAUF_NODE_EXE (
    if exist "%TAUF_NODE_EXE%" set "NODE_EXE=%TAUF_NODE_EXE%"
)

if not defined NODE_EXE (
    for /f "delims=" %%I in ('where node.exe 2^>nul') do (
        if not defined NODE_EXE if exist "%%I" set "NODE_EXE=%%I"
    )
)

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE if defined NVM_SYMLINK (
    if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
)
if not defined NODE_EXE if defined NVM_HOME (
    for /d %%D in ("%NVM_HOME%\v*") do (
        if not defined NODE_EXE if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
    )
)
if not defined NODE_EXE if exist "%APPDATA%\nvm" (
    for /d %%D in ("%APPDATA%\nvm\v*") do (
        if not defined NODE_EXE if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
    )
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\nvm" (
    for /d %%D in ("%LOCALAPPDATA%\nvm\v*") do (
        if not defined NODE_EXE if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
    )
)

if not defined NODE_EXE if defined VOLTA_HOME (
    if exist "%VOLTA_HOME%\bin\node.exe" set "NODE_EXE=%VOLTA_HOME%\bin\node.exe"
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Volta\tools\image\node" (
    for /d %%D in ("%LOCALAPPDATA%\Volta\tools\image\node\*") do (
        if not defined NODE_EXE if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
    )
)

if not defined NODE_EXE if exist "%USERPROFILE%\scoop\apps" (
    for /d %%D in ("%USERPROFILE%\scoop\apps\nodejs*") do (
        if not defined NODE_EXE if exist "%%D\current\node.exe" set "NODE_EXE=%%D\current\node.exe"
    )
)

if not defined NODE_EXE if exist "%APPDATA%\fnm\node-versions" (
    for /d %%D in ("%APPDATA%\fnm\node-versions\*") do (
        if not defined NODE_EXE if exist "%%D\installation\node.exe" set "NODE_EXE=%%D\installation\node.exe"
    )
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\fnm_multishells" (
    for /d %%D in ("%LOCALAPPDATA%\fnm_multishells\*") do (
        if not defined NODE_EXE if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
    )
)

if not defined NODE_EXE (
    for /f "delims=" %%I in ('where node 2^>nul') do (
        if not defined NODE_EXE (
            call "%%I" -v >nul 2>&1
            if not errorlevel 1 set "NODE_EXE=%%I"
        )
    )
)

if not defined NODE_EXE if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node" (
    for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
        if not defined NODE_EXE if exist "%%D\bin\node.exe" (
            call "%%D\bin\node.exe" -v >nul 2>&1
            if not errorlevel 1 set "NODE_EXE=%%D\bin\node.exe"
        )
    )
)

if not defined NODE_EXE (
    echo [%DATE% %TIME%] [TAUF] Could not locate node.exe on this machine. Install Node.js ^>=18 and run npm run setup.>>"%LOG_FILE%"
    exit /b 1
)

call "%NODE_EXE%" "local-server.mjs" %* >>"%LOG_FILE%" 2>&1
exit /b %ERRORLEVEL%
