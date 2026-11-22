param(
    [int]$TimeoutMs = 4000,
    [int]$PollIntervalMs = 150
)

$ErrorActionPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$AquaIconCandidate = Join-Path $ScriptDir "..\src-tauri\icons\tauf-aqua.ico"
if (Test-Path -LiteralPath $AquaIconCandidate) {
    $IconPath = (Resolve-Path $AquaIconCandidate).Path
} else {
    $IconPath = (Resolve-Path (Join-Path $ScriptDir "..\src-tauri\icons\icon.ico")).Path
}
$VbsPath = Join-Path $WorkspaceRoot "launch-tauf.vbs"

if (-not (Test-Path -LiteralPath $IconPath)) {
    Write-Error "[apply-taskbar-icon] Icon file not found: $IconPath"
    exit 1
}

# 1. Clear stale Edge app-profile favicon and HTTP caches when unlocked
$LocalAppData = [Environment]::GetFolderPath("LocalApplicationData")
if ($LocalAppData) {
    $DefaultProfileDir = Join-Path $LocalAppData "TAUF\edge-app-profile\Default"
    if (Test-Path -LiteralPath $DefaultProfileDir) {
        Get-ChildItem -LiteralPath $DefaultProfileDir -Filter "Favicons*" -Force -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
        foreach ($CacheSub in @("Cache", "Code Cache", "GPUCache", "Web Applications")) {
            $SubPath = Join-Path $DefaultProfileDir $CacheSub
            if (Test-Path -LiteralPath $SubPath) {
                Remove-Item -LiteralPath $SubPath -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# 2. Update Desktop & Start Menu TAUF.lnk shortcuts (recreate cleanly to bust Windows Explorer icon cache)
$ShortcutCandidates = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "TAUF.lnk"),
    (Join-Path $env:USERPROFILE "Desktop\TAUF.lnk"),
    (Join-Path $env:USERPROFILE "OneDrive\Desktop\TAUF.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "TAUF.lnk")
) | Select-Object -Unique

$UpdatedShortcuts = 0
if (Test-Path -LiteralPath $VbsPath) {
    $WshShell = New-Object -ComObject WScript.Shell
    $WScriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"
    foreach ($LnkPath in $ShortcutCandidates) {
        $ParentDir = Split-Path -Parent $LnkPath
        if ($LnkPath -and (Test-Path -LiteralPath $ParentDir)) {
            try {
                if (Test-Path -LiteralPath $LnkPath) {
                    Remove-Item -LiteralPath $LnkPath -Force -ErrorAction SilentlyContinue
                }
                $Shortcut = $WshShell.CreateShortcut($LnkPath)
                $Shortcut.TargetPath = $WScriptExe
                $Shortcut.Arguments = "`"$VbsPath`""
                $Shortcut.WorkingDirectory = $WorkspaceRoot
                $Shortcut.IconLocation = "$IconPath,0"
                $Shortcut.Description = "TAUF - Sovereign Identity OSINT Workstation"
                $Shortcut.Save()
                $UpdatedShortcuts++
            } catch {
                # Ignore locked shortcut files without aborting HWND stamping
            }
        }
    }
}

# 3. Compile Win32 + Shell PropertyStore helper (64-bit safe)
$NativeCode = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace TaufTaskbarIcon {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(2)] public ushort wReserved1;
        [FieldOffset(4)] public ushort wReserved2;
        [FieldOffset(6)] public ushort wReserved3;
        [FieldOffset(8)] public IntPtr pwszVal;
        [FieldOffset(16)] public ulong padding;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    public static class Native {
        public const uint IMAGE_ICON = 1;
        public const uint LR_LOADFROMFILE = 0x0010;
        public const uint WM_SETICON = 0x0080;
        public const uint SMTO_ABORTIFHUNG = 0x0002;
        public const uint GW_OWNER = 4;
        public const int GCLP_HICON = -14;
        public const int GCLP_HICONSM = -34;
        public const uint SHCNE_ASSOCCHANGED = 0x08000000;
        public const uint SHCNF_IDLIST = 0x0000;
        public const ushort VT_LPWSTR = 31;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLengthW(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr LoadImageW(IntPtr hInst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

        [DllImport("user32.dll", EntryPoint = "SetClassLongPtrW", SetLastError = true)]
        private static extern IntPtr SetClassLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetClassLongW", SetLastError = true)]
        private static extern IntPtr SetClassLong32(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("shell32.dll")]
        public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);

        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(uint wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PROPVARIANT pvar);

        public static IntPtr SetClassIcon(IntPtr hWnd, int index, IntPtr hIcon) {
            if (IntPtr.Size == 8) {
                return SetClassLongPtr64(hWnd, index, hIcon);
            }
            return SetClassLong32(hWnd, index, hIcon);
        }

        public static List<IntPtr> FindMatchingWindows(HashSet<uint> targetPids, HashSet<uint> browserPids) {
            var matches = new List<IntPtr>();
            EnumWindows((hWnd, lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;

                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                int len = GetWindowTextLengthW(hWnd);
                if (len <= 0) return true;

                var sb = new StringBuilder(len + 1);
                GetWindowTextW(hWnd, sb, sb.Capacity);
                string title = sb.ToString();

                bool pidMatch = targetPids.Contains(pid);
                bool titleMatch = browserPids.Contains(pid) && (
                    title.Equals("TAUF", StringComparison.OrdinalIgnoreCase)
                    || title.StartsWith("TAUF ", StringComparison.OrdinalIgnoreCase)
                    || title.StartsWith("TAUF—", StringComparison.OrdinalIgnoreCase)
                    || title.StartsWith("TAUF-", StringComparison.OrdinalIgnoreCase));

                if (pidMatch || titleMatch) {
                    matches.Add(hWnd);
                }
                return true;
            }, IntPtr.Zero);
            return matches;
        }

        public static int SetWindowAppProperty(IPropertyStore store, uint pid, string value) {
            var key = new PROPERTYKEY {
                fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
                pid = pid
            };
            var pv = new PROPVARIANT {
                vt = VT_LPWSTR,
                pwszVal = Marshal.StringToCoTaskMemUni(value)
            };
            try {
                return store.SetValue(ref key, ref pv);
            } finally {
                PropVariantClear(ref pv);
            }
        }

        public static bool StampWindow(IntPtr hWnd, IntPtr hIconBig, IntPtr hIconSmall, string iconResource) {
            if (hWnd == IntPtr.Zero) return false;
            IntPtr msgRes;
            if (hIconBig != IntPtr.Zero) {
                SendMessageTimeoutW(hWnd, WM_SETICON, new IntPtr(1), hIconBig, SMTO_ABORTIFHUNG, 500, out msgRes);
                SetClassIcon(hWnd, GCLP_HICON, hIconBig);
            }
            if (hIconSmall != IntPtr.Zero) {
                SendMessageTimeoutW(hWnd, WM_SETICON, new IntPtr(0), hIconSmall, SMTO_ABORTIFHUNG, 500, out msgRes);
                SetClassIcon(hWnd, GCLP_HICONSM, hIconSmall);
            }

            Guid iidStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
            IPropertyStore store;
            int hr = SHGetPropertyStoreForWindow(hWnd, ref iidStore, out store);
            if (hr == 0 && store != null) {
                try {
                    SetWindowAppProperty(store, 5, "TAUF.Desktop.Workbench"); // System.AppUserModel.ID
                    SetWindowAppProperty(store, 3, iconResource);             // System.AppUserModel.RelaunchIconResource
                    SetWindowAppProperty(store, 4, "TAUF");                   // System.AppUserModel.RelaunchDisplayNameResource
                    store.Commit();
                } finally {
                    Marshal.ReleaseComObject(store);
                }
            }
            return true;
        }
    }
}
"@

if (-not ("TaufTaskbarIcon.Native" -as [type])) {
    Add-Type -TypeDefinition $NativeCode -Language CSharp
}

function Get-TaufPidSets {
    $targetSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
    $browserSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe' OR Name='tauf.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        [void]$browserSet.Add([uint32]$p.ProcessId)
        if ($p.Name -eq "tauf.exe") {
            [void]$targetSet.Add([uint32]$p.ProcessId)
        } elseif ($p.CommandLine) {
            if ($p.CommandLine -like "*127.0.0.1:1420*" -or
                $p.CommandLine -like "*localhost:1420*" -or
                $p.CommandLine -like "*TAUF*edge-app-profile*" -or
                $p.CommandLine -like "*TAUFDesktopApp*") {
                [void]$targetSet.Add([uint32]$p.ProcessId)
            }
        }
    }
    return @{ Target = $targetSet; Browser = $browserSet }
}

$hIconBig = [TaufTaskbarIcon.Native]::LoadImageW(
    [IntPtr]::Zero, $IconPath,
    [TaufTaskbarIcon.Native]::IMAGE_ICON,
    256, 256,
    [TaufTaskbarIcon.Native]::LR_LOADFROMFILE
)
$hIconSmall = [TaufTaskbarIcon.Native]::LoadImageW(
    [IntPtr]::Zero, $IconPath,
    [TaufTaskbarIcon.Native]::IMAGE_ICON,
    48, 48,
    [TaufTaskbarIcon.Native]::LR_LOADFROMFILE
)

if ($hIconBig -eq [IntPtr]::Zero) {
    Write-Error "[apply-taskbar-icon] LoadImageW failed for 256x256 icon: $IconPath"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$foundHandles = New-Object 'System.Collections.Generic.List[IntPtr]'

while ($sw.ElapsedMilliseconds -le $TimeoutMs) {
    $sets = Get-TaufPidSets
    $wins = [TaufTaskbarIcon.Native]::FindMatchingWindows($sets.Target, $sets.Browser)
    if ($wins.Count -gt 0) {
        foreach ($h in $wins) {
            if (-not $foundHandles.Contains($h)) {
                $foundHandles.Add($h)
            }
        }
        break
    }
    Start-Sleep -Milliseconds $PollIntervalMs
}

$stampedCount = 0
$iconResource = "$IconPath,0"
if ($foundHandles.Count -gt 0) {
    foreach ($hwnd in $foundHandles) {
        if ([TaufTaskbarIcon.Native]::StampWindow($hwnd, $hIconBig, $hIconSmall, $iconResource)) {
            $stampedCount++
        }
    }
    # Re-apply briefly after initial page load so Chromium favicon updates cannot override 256px HICON
    Start-Sleep -Milliseconds 450
    $sets2 = Get-TaufPidSets
    $wins2 = [TaufTaskbarIcon.Native]::FindMatchingWindows($sets2.Target, $sets2.Browser)
    foreach ($hwnd in $wins2) {
        [void][TaufTaskbarIcon.Native]::StampWindow($hwnd, $hIconBig, $hIconSmall, $iconResource)
    }
}

# 4. Notify Windows Shell of icon / shortcut updates and refresh Explorer icon cache
[TaufTaskbarIcon.Native]::SHChangeNotify(
    [TaufTaskbarIcon.Native]::SHCNE_ASSOCCHANGED,
    [TaufTaskbarIcon.Native]::SHCNF_IDLIST,
    [IntPtr]::Zero,
    [IntPtr]::Zero
)
$Ie4uinit = Join-Path $env:SystemRoot "System32\ie4uinit.exe"
if (Test-Path -LiteralPath $Ie4uinit) {
    Start-Process -FilePath $Ie4uinit -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue
}

Write-Output "[apply-taskbar-icon] shortcuts_updated=$UpdatedShortcuts windows_stamped=$stampedCount icon=$IconPath"
exit 0
