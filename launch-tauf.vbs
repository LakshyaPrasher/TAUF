Option Explicit

Dim WshShell, FSO
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

Dim appDir, releaseExe, debugExe
appDir = FSO.GetParentFolderName(WScript.ScriptFullName)
releaseExe = appDir & "\src-tauri\target\release\tauf.exe"
debugExe = appDir & "\src-tauri\target\debug\tauf.exe"

If FSO.FileExists(releaseExe) Then
    WshShell.Run """" & releaseExe & """", 1, False
    WScript.Quit 0
End If

If FSO.FileExists(debugExe) Then
    WshShell.Run """" & debugExe & """", 1, False
    WScript.Quit 0
End If

' 1. Start the local sovereign backend completely hidden (WindowStyle 0 = zero CMD window)
WshShell.Run """" & appDir & "\launch-tauf.cmd""", 0, False

' 2. Poll http://127.0.0.1:1420/__tauf_health__ up to ~3s in 150ms steps before opening the desktop shell
Dim healthUrl, i
healthUrl = "http://127.0.0.1:1420/__tauf_health__"
For i = 1 To 20
    If IsServerHealthy(healthUrl) Then Exit For
    WScript.Sleep 150
Next

' 3. Locate Edge / Chrome / Brave portably and launch standalone desktop app window (WindowStyle 1 = SW_SHOWNORMAL)
Dim pf, pf86, localAppData
pf = WshShell.ExpandEnvironmentStrings("%ProgramFiles%")
pf86 = WshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
localAppData = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%")

Dim browserExe, profileSubdir
browserExe = ""
profileSubdir = "edge-app-profile"

Dim candidates(8, 1)
candidates(0, 0) = pf86 & "\Microsoft\Edge\Application\msedge.exe"
candidates(0, 1) = "edge-app-profile"
candidates(1, 0) = pf & "\Microsoft\Edge\Application\msedge.exe"
candidates(1, 1) = "edge-app-profile"
candidates(2, 0) = localAppData & "\Microsoft\Edge\Application\msedge.exe"
candidates(2, 1) = "edge-app-profile"
candidates(3, 0) = pf & "\Google\Chrome\Application\chrome.exe"
candidates(3, 1) = "chrome-app-profile"
candidates(4, 0) = pf86 & "\Google\Chrome\Application\chrome.exe"
candidates(4, 1) = "chrome-app-profile"
candidates(5, 0) = localAppData & "\Google\Chrome\Application\chrome.exe"
candidates(5, 1) = "chrome-app-profile"
candidates(6, 0) = pf & "\BraveSoftware\Brave-Browser\Application\brave.exe"
candidates(6, 1) = "brave-app-profile"
candidates(7, 0) = pf86 & "\BraveSoftware\Brave-Browser\Application\brave.exe"
candidates(7, 1) = "brave-app-profile"
candidates(8, 0) = localAppData & "\BraveSoftware\Brave-Browser\Application\brave.exe"
candidates(8, 1) = "brave-app-profile"

For i = 0 To UBound(candidates, 1)
    If FSO.FileExists(candidates(i, 0)) Then
        browserExe = candidates(i, 0)
        profileSubdir = candidates(i, 1)
        Exit For
    End If
Next

If browserExe <> "" Then
    Dim profileDir, appCmd
    profileDir = localAppData & "\TAUF\" & profileSubdir
    appCmd = """" & browserExe & """ --app=http://127.0.0.1:1420 --window-size=1380,860 --class=TAUFDesktopApp --app-id=TAUFDesktopApp --user-data-dir=""" & profileDir & """ --no-first-run"
    WshShell.Run appCmd, 1, False

    ' 4. Silently stamp the 4K/HD icon onto the desktop window HWND if helper exists
    Dim iconScript, psCmd
    iconScript = appDir & "\scripts\apply-taskbar-icon.ps1"
    If FSO.FileExists(iconScript) Then
        psCmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & iconScript & """"
        WshShell.Run psCmd, 0, False
    End If
Else
    WshShell.Run "http://127.0.0.1:1420", 1, False
End If

Function IsServerHealthy(url)
    On Error Resume Next
    IsServerHealthy = False
    Dim http
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    If Err.Number <> 0 Or http Is Nothing Then
        Err.Clear
        Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    End If
    If Err.Number <> 0 Or http Is Nothing Then
        Err.Clear
        Set http = CreateObject("MSXML2.ServerXMLHTTP")
    End If
    If Not http Is Nothing Then
        http.SetTimeouts 150, 150, 150, 150
        http.Open "GET", url, False
        http.Send
        If Err.Number = 0 Then
            If http.Status = 200 Then
                IsServerHealthy = True
            End If
        End If
    End If
    Err.Clear
    On Error GoTo 0
End Function
