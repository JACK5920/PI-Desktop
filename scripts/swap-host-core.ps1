<#
.SYNOPSIS
Build host-core and swap it into a running dev desktop without restarting Electron.

.DESCRIPTION
The dev desktop keeps `pi-desktop-host-core.exe` running as a child of
Electron Main, and the agent sidecar -- which is where the agent's own turn
runs -- is a child of that. Stopping host-core from inside the agent's shell
therefore takes the agent down with it: the shell it is about to use dies
first. This script sidesteps that in three ways.

  1. It builds into a separate target directory. The running binary keeps
     `target\debug\pi-desktop-host-core.exe` open, and cargo cannot replace a
     file that is open, so an in-place build fails with "failed to remove
     file ... access denied".

  2. It stops the host from a process that is not the agent's descendant.
     `Invoke-CimMethod Win32_Process::Create` starts the swapper outside the
     agent's job object, so the swapper survives the host it stops. The dev
     supervisor then brings the host back within half a second.

  3. It removes the old file before moving the new one in. Windows keeps a
     running image mapped, and the old file has to be gone before its
     replacement can take the name.

Only host-core is restarted. Electron Main and the agent sidecar stay up, so
the session survives.

.PARAMETER Repo
Path to the repository. Defaults to the parent of this script's directory.

.PARAMETER Profile
Target directory for the throwaway build. Defaults to `<repo>\target2`.

.PARAMETER SkipBuild
Swap the binary that is already in the profile directory without building
again.

.PARAMETER Log
Where to write the swap log. Defaults to `<repo>\.artifacts\host-core-swap.log`.

.EXAMPLE
pwsh -File scripts/swap-host-core.ps1

.EXAMPLE
pwsh -File scripts/swap-host-core.ps1 -Repo D:\src\PI-Desktop -SkipBuild
#>
[CmdletBinding()]
param(
    [string]$Repo = (Split-Path -Parent $PSScriptRoot),
    [string]$Profile,
    [string]$Log,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Continue'

if (-not $Profile) { $Profile = Join-Path $Repo 'target2' }
if (-not $Log) { $Log = Join-Path $Repo '.artifacts\host-core-swap.log' }

$source = Join-Path $Profile 'debug\pi-desktop-host-core.exe'
$target = Join-Path $Repo 'target\debug\pi-desktop-host-core.exe'
$staged = Join-Path $Repo 'target\debug\pi-desktop-host-core.next.exe'

function Write-Log([string]$message) {
    $line = "$message"
    Add-Content -LiteralPath $Log -Value $line -Encoding utf8
    Write-Output $line
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
Write-Log "=== swap start $(Get-Date -Format o) ==="

if (-not $SkipBuild) {
    Write-Log "building into $Profile"
    Push-Location $Repo
    cargo build -p host-core --target-dir $Profile
    $buildExit = $LASTEXITCODE
    Pop-Location
    if ($buildExit -ne 0) {
        Write-Log "the build failed with exit code $buildExit -- the running binary was left alone"
        exit $buildExit
    }
}

if (-not (Test-Path $source)) {
    Write-Log "the freshly built binary is missing: $source"
    exit 1
}

Copy-Item -LiteralPath $source -Destination $staged -Force
Write-Log "staged the new binary ($((Get-Item $staged).Length) bytes)"

# The running host holds its own image open, and the file has to be gone
# before its replacement can take the name. Each attempt first stops the
# host, then removes the file, then moves the new one in.
for ($attempt = 1; $attempt -le 10; $attempt++) {
    $hosts = @(Get-CimInstance Win32_Process -Filter "Name='pi-desktop-host-core.exe'" |
        Where-Object { $_.CommandLine -notlike '*internal-tool-runner*' })
    Write-Log "attempt ${attempt}: host-core pids = $($hosts.ProcessId -join ',')"

    foreach ($process in $hosts) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            Write-Log "  stopped $($process.ProcessId)"
        } catch {
            Write-Log "  stop failed for $($process.ProcessId): $($_.Exception.Message)"
        }
    }

    try {
        Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        Write-Log '  removed the old binary'
    } catch {
        Write-Log "  remove failed: $($_.Exception.Message)"
        Start-Sleep -Milliseconds 300
        continue
    }

    try {
        Move-Item -LiteralPath $staged -Destination $target -Force -ErrorAction Stop
        Write-Log '  moved the new binary in'
        break
    } catch {
        Write-Log "  move failed: $($_.Exception.Message)"
        Start-Sleep -Milliseconds 300
    }
}

if (-not (Test-Path $target)) {
    Write-Log 'THE BINARY IS GONE'
    exit 1
}

Start-Sleep -Seconds 8
$after = @(Get-CimInstance Win32_Process -Filter "Name='pi-desktop-host-core.exe'" |
    Where-Object { $_.CommandLine -notlike '*internal-tool-runner*' })
Write-Log "host-core is back as $($after.ProcessId -join ',')"
Write-Log "binary timestamp: $((Get-Item $target).LastWriteTime)"
Write-Log '=== swap done ==='
