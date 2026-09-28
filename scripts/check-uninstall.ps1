# Audit what an installer leaves behind on a machine that is not yours.
#
# The problem this exists for: a developer's machine has installed and uninstalled the
# app dozens of times, so leftover state is invisible. If NSIS_HOOK_POSTUNINSTALL misses
# a key, the next install silently rewrites it correctly and the bug never surfaces
# locally — it surfaces on a user's machine, as a dead "Open with" entry pointing at a
# deleted exe. See ADR-016.
#
# Three phases, run around a real install/uninstall cycle:
#
#   powershell -ExecutionPolicy Bypass -File scripts/check-uninstall.ps1 -Phase baseline
#   ... install the bundle ...
#   powershell -ExecutionPolicy Bypass -File scripts/check-uninstall.ps1 -Phase installed
#   ... uninstall it ...
#   powershell -ExecutionPolicy Bypass -File scripts/check-uninstall.ps1 -Phase removed
#
# `installed` is not decoration. Without it, an installer that registered NOTHING would
# pass the cleanliness check trivially — nothing added, nothing left behind. So that
# phase fails if the install added no BlockMD state at all, which makes the final
# verdict mean "it added things AND took them all back" rather than "it was quiet".
#
# Exit codes: 0 clean, 1 leftovers or a phase assertion failed, 2 misuse.
#
# Requires an elevated shell only inasmuch as reading HKLM does — which it does not.
# Nothing here writes to the registry.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('baseline', 'installed', 'removed')]
    [string]$Phase,

    # Snapshots live outside the repo: they are machine state, not source.
    [string]$StateDir = (Join-Path $env:TEMP 'blockmd-install-audit')
)

$ErrorActionPreference = 'Stop'

# --- What counts as "BlockMD state" ------------------------------------------------
#
# Both registry views are listed explicitly. A component built without Win64="yes"
# lands under Wow6432Node instead of where the 64-bit shell looks for it, and the
# symptom — app absent from "Open with" despite the installer reporting success — is
# identical to not having written the key at all. Snapshotting both tells the two apart.

$RegistryRoots = @(
    'HKLM:\Software\Classes\Applications\blockmd.exe'
    'HKLM:\Software\Classes\BlockMD.md'
    'HKLM:\Software\Classes\BlockMD.markdown'
    'HKLM:\Software\Classes\.md'
    'HKLM:\Software\Classes\.markdown'
    'HKLM:\Software\BlockMD'
    'HKLM:\Software\blockmd'
    'HKLM:\Software\RegisteredApplications'
    'HKLM:\Software\WOW6432Node\Classes\Applications\blockmd.exe'
    'HKLM:\Software\WOW6432Node\BlockMD'
    'HKLM:\Software\WOW6432Node\RegisteredApplications'
    'HKCU:\Software\Classes\Applications\blockmd.exe'
    'HKCU:\Software\Classes\BlockMD.md'
    'HKCU:\Software\Classes\BlockMD.markdown'
    'HKCU:\Software\Classes\.md'
    'HKCU:\Software\Classes\.markdown'
    'HKCU:\Software\BlockMD'
    'HKCU:\Software\blockmd'
    'HKCU:\Software\RegisteredApplications'
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md'
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown'
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)

$FileRoots = @(
    "$env:ProgramFiles\BlockMD"
    "${env:ProgramFiles(x86)}\BlockMD"
    "$env:LOCALAPPDATA\BlockMD"
    "$env:LOCALAPPDATA\dev.blockmd.app"
    "$env:APPDATA\dev.blockmd.app"
    "$env:LOCALAPPDATA\Packages\dev.blockmd.app"
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\BlockMD"
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\BlockMD"
    "$env:PUBLIC\Desktop\BlockMD.lnk"
    "$env:USERPROFILE\Desktop\BlockMD.lnk"
)

# Several of the roots above are shared with the rest of the machine — the Uninstall
# hives list every installed program, RegisteredApplications every app that claims a
# file type, FileExts every editor the user has ever picked. Captured wholesale they
# drown the signal (654 rows on the author's machine) and a Windows Update between two
# phases reads as a BlockMD leftover.
#
# So every row is filtered on its full text: key path, value name, and value. That is
# what makes a shared key still work — our contribution to `.md\OpenWithProgids` is the
# value NAME `BlockMD.md`, and a UserChoice row is caught by its ProgId value. A row
# that mentions us nowhere is, by construction, not ours to clean up.
$RelevantPattern = 'blockmd'

# Leftovers we neither can nor should remove. HKCU UserChoice is hash-protected: only
# the user, through the shell, may set it. An uninstaller that deleted it would be
# reaching into a per-user preference it did not create. Reported, not failed.
$ExpectedLeftoverPattern = 'CurrentVersion\\Explorer\\FileExts'

# --- Snapshot ----------------------------------------------------------------------

function Format-RegValue {
    param($Value)
    if ($null -eq $Value) { return '<null>' }
    if ($Value -is [byte[]]) { return '<binary:' + $Value.Length + '>' }
    if ($Value -is [string[]]) { return ($Value -join '|') }
    return [string]$Value
}

function Get-RegistrySnapshot {
    $snapshot = @{}
    foreach ($root in $RegistryRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }

        $keys = New-Object System.Collections.ArrayList
        try { [void]$keys.Add((Get-Item -LiteralPath $root)) } catch {}
        try {
            foreach ($child in (Get-ChildItem -LiteralPath $root -Recurse -ErrorAction SilentlyContinue)) {
                [void]$keys.Add($child)
            }
        } catch {}

        foreach ($key in $keys) {
            $path = $key.PSPath -replace '^Microsoft\.PowerShell\.Core\\Registry::', ''

            $names = @()
            try { $names = $key.GetValueNames() } catch { continue }

            if ($names.Count -eq 0 -and $path -match $RelevantPattern) {
                $snapshot["$path ::<key>"] = '(key exists, no values)'
            }

            foreach ($name in $names) {
                $label = $name
                if ([string]::IsNullOrEmpty($label)) { $label = '(default)' }
                $rendered = ''
                try {
                    $rendered = "$($key.GetValueKind($name)) = $(Format-RegValue $key.GetValue($name))"
                } catch { $rendered = '<unreadable>' }

                $entry = "$path ::$label"
                if (($entry + ' ' + $rendered) -notmatch $RelevantPattern) { continue }
                $snapshot[$entry] = $rendered
            }
        }
    }
    return $snapshot
}

function Get-FileSnapshot {
    $snapshot = @{}
    foreach ($path in $FileRoots) {
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        if (Test-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path -Force
            if ($item.PSIsContainer) {
                $count = @(Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue).Count
                $snapshot["FILE ::$path"] = "directory, $count entries"
            } else {
                $snapshot["FILE ::$path"] = "file, $($item.Length) bytes"
            }
        }
    }
    return $snapshot
}

function Get-Snapshot {
    $all = @{}
    foreach ($pair in (Get-RegistrySnapshot).GetEnumerator()) { $all[$pair.Key] = $pair.Value }
    foreach ($pair in (Get-FileSnapshot).GetEnumerator())     { $all[$pair.Key] = $pair.Value }
    return $all
}

function Save-Snapshot {
    param([hashtable]$Snapshot, [string]$Path)
    $ordered = [ordered]@{}
    foreach ($key in ($Snapshot.Keys | Sort-Object)) { $ordered[$key] = $Snapshot[$key] }
    ($ordered | ConvertTo-Json -Depth 4) | Out-File -FilePath $Path -Encoding utf8
}

function Read-Snapshot {
    param([string]$Path)
    $result = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $json.PSObject.Properties) { $result[$property.Name] = $property.Value }
    return $result
}

# --- Run -----------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
}

$baselinePath  = Join-Path $StateDir 'baseline.json'
$installedPath = Join-Path $StateDir 'installed.json'
$removedPath   = Join-Path $StateDir 'removed.json'

$current = Get-Snapshot
Write-Output "Phase '$Phase': $($current.Count) BlockMD-related entries on this machine."
Write-Output "State directory: $StateDir"
Write-Output ''

switch ($Phase) {

    'baseline' {
        Save-Snapshot -Snapshot $current -Path $baselinePath
        Remove-Item -LiteralPath $installedPath, $removedPath -ErrorAction SilentlyContinue

        if ($current.Count -gt 0) {
            Write-Output 'NOTE: this machine is not clean. The entries below predate the install;'
            Write-Output 'they are excluded from the verdict, but a truly meaningful run starts'
            Write-Output 'from a machine where this list is empty (a fresh VM, or a CI runner).'
            Write-Output ''
            foreach ($key in ($current.Keys | Sort-Object)) { Write-Output "  $key" }
            Write-Output ''
        }
        Write-Output 'Baseline recorded. Install the bundle, then re-run with -Phase installed.'
        exit 0
    }

    'installed' {
        $baseline = Read-Snapshot -Path $baselinePath
        if ($null -eq $baseline) {
            Write-Output 'ERROR: no baseline. Run -Phase baseline before installing.'
            exit 2
        }
        Save-Snapshot -Snapshot $current -Path $installedPath

        $added = @($current.Keys | Where-Object { -not $baseline.ContainsKey($_) } | Sort-Object)

        Write-Output "The installer added $($added.Count) entries:"
        foreach ($key in $added) { Write-Output "  + $key" }
        Write-Output ''

        # An installer that wrote nothing would sail through the 'removed' phase. Refuse
        # to let that read as success.
        if ($added.Count -eq 0) {
            Write-Output 'FAIL: the install added no BlockMD state at all.'
            Write-Output 'Either the install did not happen, or it wrote somewhere this script'
            Write-Output 'does not look. Do not trust a later "clean uninstall" verdict.'
            exit 1
        }

        # The three registrations ADR-015 requires, checked against the same paths a
        # shell lookup would use. Missing any of them is the MSI-vs-NSIS bug class.
        $required = [ordered]@{
            'Applications\blockmd.exe entry' = 'Classes\\Applications\\blockmd\.exe'
            '.md OpenWithProgids'            = '\\Classes\\\.md\\OpenWithProgids'
            'RegisteredApplications'         = 'RegisteredApplications ::BlockMD'
        }
        $missing = @()
        foreach ($name in $required.Keys) {
            if (-not ($added -match $required[$name])) { $missing += $name }
        }
        if ($missing.Count -gt 0) {
            Write-Output 'FAIL: the install is missing shell registrations required by ADR-015:'
            foreach ($name in $missing) { Write-Output "  - $name" }
            Write-Output ''
            Write-Output 'If this was the MSI, check that bundle.windows.wix.componentGroupRefs'
            Write-Output 'still references ShellRegistration (see ADR-016).'
            exit 1
        }

        # Registry redirection check.
        #
        # NOT "anything under Wow6432Node is a bug": HKLM\Software\RegisteredApplications
        # is a WOW64 *shared* key, so the identical value is visible at both paths — all
        # 33 values match, measured. A naive Wow6432Node match fails every single run.
        #
        # The condition that actually matters is landing in the 32-bit view *only*, which
        # is what a component missing Win64="yes" does. So: flag a redirected entry whose
        # 64-bit counterpart is absent.
        $redirected = @()
        foreach ($key in ($added | Where-Object { $_ -match '\\WOW6432Node\\' })) {
            $sibling = $key -replace '\\WOW6432Node\\', '\'
            if (-not $current.ContainsKey($sibling)) { $redirected += $key }
        }
        if ($redirected.Count -gt 0) {
            Write-Output 'FAIL: entries exist only in the 32-bit registry view:'
            foreach ($key in $redirected) { Write-Output "  ! $key" }
            Write-Output ''
            Write-Output 'A component is missing Win64="yes" (WiX) or SetRegView 64 (NSIS). The'
            Write-Output '64-bit shell will not see these, so the app stays absent from "Open with"'
            Write-Output 'even though the installer reported success.'
            exit 1
        }

        Write-Output 'OK: all three ADR-015 registrations present, correct registry view.'
        Write-Output 'Now uninstall, then re-run with -Phase removed.'
        exit 0
    }

    'removed' {
        $baseline = Read-Snapshot -Path $baselinePath
        $installed = Read-Snapshot -Path $installedPath
        if ($null -eq $baseline -or $null -eq $installed) {
            Write-Output 'ERROR: need both baseline and installed snapshots first.'
            exit 2
        }
        Save-Snapshot -Snapshot $current -Path $removedPath

        $added = @($installed.Keys | Where-Object { -not $baseline.ContainsKey($_) })
        $leftovers = @($added | Where-Object { $current.ContainsKey($_) } | Sort-Object)

        $expected = @($leftovers | Where-Object { $_ -match $ExpectedLeftoverPattern })
        $real     = @($leftovers | Where-Object { $_ -notmatch $ExpectedLeftoverPattern })

        if ($expected.Count -gt 0) {
            Write-Output "$($expected.Count) expected leftovers (the uninstaller must not touch these):"
            foreach ($key in $expected) { Write-Output "  ~ $key" }
            Write-Output ''
            Write-Output 'These are per-user shell preferences written by Windows when the user chose'
            Write-Output 'a default app. UserChoice is hash-protected and belongs to the user, not to'
            Write-Output 'us. Consequence to document rather than fix: after uninstall, .md may still'
            Write-Output 'point at a path that no longer exists.'
            Write-Output ''
        }

        if ($real.Count -eq 0) {
            Write-Output "CLEAN: all $($added.Count) entries the installer added were removed."
            exit 0
        }

        Write-Output "FAIL: $($real.Count) entries survived the uninstall:"
        foreach ($key in $real) { Write-Output "  ! $key" }
        exit 1
    }
}
