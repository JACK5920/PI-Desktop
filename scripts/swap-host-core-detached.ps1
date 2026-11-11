<#
.SYNOPSIS
Start the host-core swap outside the caller's process tree.

.DESCRIPTION
The agent's own tool process is a descendant of host-core: the desktop
starts host-core, and host-core starts the tool runner the agent's shell
comes from. Stopping host-core from inside that shell therefore takes the
agent down with it, because the shell dies before the swap can finish.

`Start-Process` does not help -- the child stays in the same job object and
inherits the same lifetime. `Invoke-CimMethod Win32_Process::Create` asks
the Windows process subsystem for a new process instead, which lands the
swapper outside the agent's job object. The swapper then stops the host,
swaps the binary and exits, while the dev supervisor brings the host back.

.PARAMETER Script
The swap script to run. Defaults to `swap-host-core.ps1` next to this file.

.PARAMETER Repo
Repository path, passed through to the swap script.

.PARAMETER SkipBuild
Passed through: swap the binary already in the profile directory.

.EXAMPLE
pwsh -File scripts/swap-host-core-detached.ps1

.EXAMPLE
pwsh -File scripts/swap-host-core-detached.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [string]$Script,
    [string]$Repo = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipBuild
)

if (-not $Script) { $Script = Join-Path $PSScriptRoot 'swap-host-core.ps1' }
if (-not (Test-Path $Script)) {
    Write-Error "the swap script is missing: $Script"
    exit 1
}

# Build the command line without quoting the paths by hand: the script path
# may contain spaces, and a hand-rolled quote is how the argument silently
# turns into two arguments.
$command = @(
    '-NoProfile'
    '-ExecutionPolicy'
    'Bypass'
    '-File'
    "`"$Script`""
)
if ($Repo) { $command += @('-Repo', "`"$Repo`"") }
if ($SkipBuild) { $command += '-SkipBuild' }

$commandLine = 'powershell ' + ($command -join ' ')

# Ask the Windows process subsystem for the process rather than forking it,
# so the swapper is not a descendant of this shell and does not die with it.
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }

if ($result.ReturnValue -ne 0) {
    Write-Error "the swapper could not be started (Win32 error $($result.ReturnValue))"
    exit 1
}

Write-Output "the swapper is running as pid $($result.ProcessId)"
Write-Output "  command: $commandLine"
Write-Output 'the host is restarted by the dev supervisor within about a second'
