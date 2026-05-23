#Requires -Version 5.1
<#
.SYNOPSIS
  Install dependencies and build Bavarium Browser installers with electron-builder.

.DESCRIPTION
  Installs npm packages in the Electron shell, ultraviolet-app, and scramjet-app,
  then runs electron-builder for the selected platform(s). Artifacts are written to release/.

  Windows targets (from package.json): NSIS installer (choose install folder) + portable .exe
  macOS: unpacked app in release/mac-arm64/, then release/mac-arm64.zip (no DMG)

.PARAMETER Platform
  All | Windows | Mac - which platform(s) to build. On Windows, All builds Windows only
  (macOS requires a Mac host). On macOS, All builds Windows and macOS artifacts.

.PARAMETER SkipInstall
  Skip npm install (use when dependencies are already installed).

.PARAMETER Clean
  Remove release/ before building.

.PARAMETER Force
  Skip the confirmation prompt after the CPU warning (for automation/CI).

.EXAMPLE
  .\scripts\build-bavarium.ps1

.EXAMPLE
  .\scripts\build-bavarium.ps1 -Platform Windows -SkipInstall

.EXAMPLE
  .\scripts\build-bavarium.ps1 -Platform Mac
#>
[CmdletBinding()]
param(
    [ValidateSet('All', 'Windows', 'Mac')]
    [string] $Platform = 'All',

    [switch] $SkipInstall,
    [switch] $Clean,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:BuildProgress = @{
    Activity        = 'Bavarium Browser build'
    Steps           = @()
    CompletedWeight = 0.0
    TotalWeight     = 0.0
    CurrentStepId   = ''
}
# Set in main: Write-Progress breaks Cursor/VS Code terminals (^[[16;1R etc.).
$script:UseBuildProgress = $false

function Initialize-BuildProgressPlan {
    param(
        [bool] $IncludeNpmInstall,
        [bool] $IncludeWinPatch,
        [bool] $IncludeClean,
        [bool] $IncludeElectronBuilder,
        [bool] $IncludeMacZip
    )

    $steps = [System.Collections.Generic.List[object]]::new()
    [void]$steps.Add([pscustomobject]@{ Id = 'prepare'; Name = 'Preparing build'; Weight = 3 })
    if ($IncludeNpmInstall) {
        [void]$steps.Add([pscustomobject]@{ Id = 'npm-shell'; Name = 'npm install (shell)'; Weight = 9 })
        [void]$steps.Add([pscustomobject]@{ Id = 'npm-uv'; Name = 'npm install (Ultraviolet)'; Weight = 8 })
        [void]$steps.Add([pscustomobject]@{ Id = 'npm-scram'; Name = 'npm install (Scramjet)'; Weight = 8 })
    }
    if ($IncludeWinPatch) {
        [void]$steps.Add([pscustomobject]@{ Id = 'patch-electron'; Name = 'Patching electron.exe metadata'; Weight = 2 })
    }
    if ($IncludeClean) {
        [void]$steps.Add([pscustomobject]@{ Id = 'clean-release'; Name = 'Cleaning release/'; Weight = 2 })
    }
    [void]$steps.Add([pscustomobject]@{ Id = 'stop-processes'; Name = 'Stopping running Bavarium processes'; Weight = 2 })
    if ($IncludeElectronBuilder) {
        [void]$steps.Add([pscustomobject]@{ Id = 'electron-builder'; Name = 'electron-builder'; Weight = 62 })
    }
    if ($IncludeMacZip) {
        [void]$steps.Add([pscustomobject]@{ Id = 'mac-zip'; Name = 'Creating macOS zip'; Weight = 6 })
    }
    [void]$steps.Add([pscustomobject]@{ Id = 'finish'; Name = 'Finishing'; Weight = 2 })

    $script:BuildProgress.Steps = $steps.ToArray()
    $script:BuildProgress.CompletedWeight = 0.0
    $script:BuildProgress.TotalWeight = ($script:BuildProgress.Steps | Measure-Object -Property Weight -Sum).Sum
    $script:BuildProgress.CurrentStepId = ''
    Write-BuildProgress -StepId 'prepare' -StepPercent 0 -Detail 'Starting'
}

function Get-BuildProgressStep([string] $StepId) {
    return $script:BuildProgress.Steps | Where-Object { $_.Id -eq $StepId } | Select-Object -First 1
}

function Write-BuildProgress {
    param(
        [string] $StepId,
        [int] $StepPercent,
        [string] $Detail = ''
    )

    if (-not $script:UseBuildProgress) { return }

    $step = Get-BuildProgressStep -StepId $StepId
    if (-not $step) { return }

    $script:BuildProgress.CurrentStepId = $StepId
    $clamped = [Math]::Max(0, [Math]::Min(100, $StepPercent))
    $stepPortion = $step.Weight * ($clamped / 100.0)
    $overall = [int]((($script:BuildProgress.CompletedWeight + $stepPortion) / $script:BuildProgress.TotalWeight) * 100)
    $overall = [Math]::Max(0, [Math]::Min(100, $overall))

    $status = "$($step.Name) - $clamped%"
    if ($Detail) { $status = "$status ($Detail)" }

    Write-Progress -Activity $script:BuildProgress.Activity `
        -Status $status `
        -PercentComplete $overall `
        -CurrentOperation "Overall: $overall%"
}

function Complete-BuildProgressStep {
    param([string] $StepId)

    $step = Get-BuildProgressStep -StepId $StepId
    if ($step) {
        $script:BuildProgress.CompletedWeight += $step.Weight
    }
    Write-BuildProgress -StepId $StepId -StepPercent 100
}

function Clear-BuildProgress {
    if ($script:UseBuildProgress) {
        Write-Progress -Activity $script:BuildProgress.Activity -Completed
    }
}

function Invoke-CommandWithProgress {
    param(
        [string] $StepId,
        [string] $WorkingDirectory = '',
        [scriptblock] $OnOutputLine,
        [Parameter(Mandatory)]
        [scriptblock] $Command
    )

    $stepPercent = 0
    Write-BuildProgress -StepId $StepId -StepPercent 0 -Detail 'Running'

    $prevDir = Get-Location
    if ($WorkingDirectory) { Set-Location -LiteralPath $WorkingDirectory }
    try {
        & $Command 2>&1 | ForEach-Object {
            $line = $_.ToString()
            Write-Host $line
            if ($OnOutputLine) {
                $pct = & $OnOutputLine $line $stepPercent
                if ($null -ne $pct) { $stepPercent = [Math]::Max($stepPercent, [int]$pct) }
            }
            else {
                $stepPercent = [Math]::Min(95, $stepPercent + 1)
            }
            Write-BuildProgress -StepId $StepId -StepPercent $stepPercent
        }
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "Command failed (exit $exitCode)"
        }
    }
    finally {
        Set-Location -LiteralPath $prevDir.Path
    }

    Write-BuildProgress -StepId $StepId -StepPercent 100
}

function Get-ElectronBuilderStepPercent([string] $Line) {
    $l = $Line.ToLowerInvariant()
    if ($l -match 'loaded configuration|writing effective config') { return 8 }
    if ($l -match 'rebuild|native dependenc') { return 18 }
    if ($l -match 'completed installing native') { return 28 }
    if ($l -match 'packaging') { return 42 }
    if ($l -match 'asar') { return 52 }
    if ($l -match 'signing') { return 62 }
    if ($l -match 'building.*nsis|target=nsis') { return 78 }
    if ($l -match 'block map|blockmap') { return 88 }
    if ($l -match 'building.*portable|target=portable') { return 94 }
    if ($l -match 'building block map') { return 96 }
    return $null
}

function Write-Step([string] $Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-BuildStartWarning {
    Write-Host ""
    Write-Host "WARNING" -ForegroundColor Yellow
    Write-Host "Compiling Bavarium from source is a very CPU-intensive task due to the compression of files. This will slow down your computer when it is run." -ForegroundColor Yellow
    Write-Host ""
}

function Confirm-BuildStart {
    $answer = Read-Host "Continue with the build? (y/N)"
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host "Build cancelled." -ForegroundColor DarkYellow
        exit 0
    }
    Write-Host ""
}

function Test-IsMacOS {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return [bool]$IsMacOS
    }
    return $false
}

function Test-IsWindows {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return [bool]$IsWindows
    }
    return $env:OS -eq 'Windows_NT'
}

function Stop-RunningBavariumProcesses([string] $RepoRoot) {
    $releaseDir = Join-Path $RepoRoot 'release'
    $toStop = @{}
    $add = {
        param($Id, $Name, $Path)
        if (-not $toStop.ContainsKey($Id)) {
            $toStop[$Id] = [pscustomobject]@{ Id = $Id; Name = $Name; Path = $Path }
        }
    }

    if (Test-IsWindows) {
        Get-CimInstance Win32_Process -Filter "Name LIKE 'Bavarium%'" -ErrorAction SilentlyContinue |
            ForEach-Object { & $add $_.ProcessId $_.Name $_.ExecutablePath }
        # Portable/installer builds may use a versioned image name; also match exes under release/.
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $_.ExecutablePath.StartsWith($releaseDir, [StringComparison]::OrdinalIgnoreCase)
            } |
            ForEach-Object { & $add $_.ProcessId $_.Name $_.ExecutablePath }
    }
    else {
        Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -like 'Bavarium*'
        } | ForEach-Object { & $add $_.Id $_.ProcessName '' }
    }

    if ($toStop.Count -eq 0) {
        Write-BuildProgress -StepId 'stop-processes' -StepPercent 100 -Detail 'None running'
        Complete-BuildProgressStep -StepId 'stop-processes'
        return
    }

    Write-Step 'Stopping running Bavarium Browser processes (unlocks release/ for rebuild)'
    Write-BuildProgress -StepId 'stop-processes' -StepPercent 0
    $i = 0
    foreach ($p in $toStop.Values) {
        $detail = if ($p.Path) { " - $($p.Path)" } else { '' }
        Write-Host "  Stopping $($p.Name) (PID $($p.Id))$detail" -ForegroundColor DarkYellow
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        $i++
        $pct = [int](($i / $toStop.Count) * 100)
        Write-BuildProgress -StepId 'stop-processes' -StepPercent $pct -Detail "Stopped $i / $($toStop.Count)"
    }
    Start-Sleep -Milliseconds 750
    Complete-BuildProgressStep -StepId 'stop-processes'
}

function Assert-Command([string] $Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found on PATH: $Name. Install Node.js 24+ from https://nodejs.org/"
    }
}

function Assert-NodeVersion {
    $raw = (node -v).TrimStart('v')
    $major = [int]($raw.Split('.')[0])
    if ($major -lt 24) {
        Write-Warning "Node.js 24+ is recommended (found v$raw). See COMPILING_SOURCE.md."
    }
    Write-Host "Using Node $(node -v) and npm $(npm -v)"
}

function Ensure-PythonSetuptoolsForNodeGyp {
    if (-not (Test-IsMacOS)) { return }

    if (-not (Get-Command python3 -ErrorAction SilentlyContinue)) {
        Write-Warning "python3 not on PATH; electron-builder may fail rebuilding electron-native-share. Install Xcode Command Line Tools."
        return
    }

    & python3 -c "import distutils" 2>$null
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host "Python distutils missing (needed for node-gyp on Python 3.12+). Installing setuptools..." -ForegroundColor Yellow
    & python3 -m pip install setuptools --user
    if ($LASTEXITCODE -ne 0) {
        throw @"
node-gyp requires Python setuptools (distutils was removed in Python 3.12+).
Run: python3 -m pip install setuptools
Then re-run: .\scripts\build-bavarium.ps1
"@
    }

    & python3 -c "import distutils" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "setuptools is installed but distutils is still unavailable. See COMPILING_SOURCE.md."
    }
    Write-Host "Python setuptools ready for native module rebuilds." -ForegroundColor DarkGray
}

function Invoke-NpmInstall([string] $Directory, [string] $Label, [string] $StepId) {
    Write-Step "npm install - $Label ($Directory)"
    Write-BuildProgress -StepId $StepId -StepPercent 0 -Detail 'Running'
    # Avoid piping npm through Write-Progress (garbled escape codes like ^[[48;1R and wrong $LASTEXITCODE).
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    $prevDir = Get-Location
    Set-Location -LiteralPath $Directory
    try {
        npm install --progress=true
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed (exit $LASTEXITCODE) in $Directory"
        }
    }
    finally {
        Set-Location -LiteralPath $prevDir.Path
        $ProgressPreference = $prevProgress
    }
    Complete-BuildProgressStep -StepId $StepId
}

function Install-AllDependencies([string] $RepoRoot) {
    Invoke-NpmInstall -Directory $RepoRoot -Label 'Bavarium shell' -StepId 'npm-shell'
    Invoke-NpmInstall -Directory (Join-Path $RepoRoot 'ultraviolet-app') -Label 'Ultraviolet proxy' -StepId 'npm-uv'
    Invoke-NpmInstall -Directory (Join-Path $RepoRoot 'scramjet-app') -Label 'Scramjet proxy (patch-package postinstall)' -StepId 'npm-scram'
}

function Get-BuildTargets([string] $PlatformChoice, [bool] $OnMac, [bool] $OnWin) {
    $buildWin = $false
    $buildMac = $false

    switch ($PlatformChoice) {
        'Windows' { $buildWin = $true }
        'Mac' {
            if (-not $OnMac) {
                throw 'macOS builds require a Mac host. On Windows use -Platform Windows.'
            }
            $buildMac = $true
        }
        'All' {
            if ($OnMac) {
                $buildWin = $true
                $buildMac = $true
            }
            elseif ($OnWin) {
                $buildWin = $true
            }
            else {
                throw 'Unsupported host OS for -Platform All.'
            }
        }
        default { throw "Unknown platform: $PlatformChoice" }
    }

    return [pscustomobject]@{
        BuildWin = $buildWin
        BuildMac = $buildMac
    }
}

function Get-ElectronBuilderArgs([bool] $BuildWin, [bool] $BuildMac) {
    $args = @()

    if ($BuildWin) {
        $args += '--win'
    }

    if ($BuildMac) {
        # Unpacked dir is zipped afterward as release/mac-arm64.zip
        $args += '--mac', 'dir'
    }

    if ($args.Count -eq 0) {
        throw 'No platforms selected for build.'
    }

    return $args
}

function Compress-MacArm64Folder([string] $ReleaseDir, [string] $StepId) {
    $macDirNames = @('mac-arm64', 'mac-universal', 'mac-x64', 'mac')
    $macDir = $null
    foreach ($name in $macDirNames) {
        $candidate = Join-Path $ReleaseDir $name
        if (Test-Path -LiteralPath $candidate) {
            $macDir = Get-Item -LiteralPath $candidate
            break
        }
    }
    if (-not $macDir) {
        Write-Warning "No mac-* output folder found under release/; skipping mac-arm64.zip"
        return
    }

    $zipName = "$($macDir.Name).zip"
    $zipPath = Join-Path $ReleaseDir $zipName
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }

    Write-Step "Zipping $($macDir.Name)/ -> $zipName"
    Write-BuildProgress -StepId $StepId -StepPercent 0 -Detail 'Compressing'
    if (Test-IsMacOS) {
        & ditto -c -k --sequesterRsrc --keepParent $macDir.FullName $zipPath
        if ($LASTEXITCODE -ne 0) {
            throw "ditto failed creating $zipName (exit $LASTEXITCODE)"
        }
    }
    else {
        $files = Get-ChildItem -LiteralPath $macDir.FullName -Recurse -File
        $total = [Math]::Max(1, $files.Count)
        $i = 0
        foreach ($f in $files) {
            $i++
            $pct = [int](($i / $total) * 90)
            Write-BuildProgress -StepId $StepId -StepPercent $pct -Detail "Files $i / $total"
        }
        Compress-Archive -LiteralPath $macDir.FullName -DestinationPath $zipPath -CompressionLevel Optimal
    }
    Complete-BuildProgressStep -StepId $StepId

    Write-Host "  Created: $zipPath" -ForegroundColor Green
}

function Invoke-ElectronBuilder([string] $RepoRoot, [string[]] $BuilderArgs, [string] $StepId) {
    $cli = Join-Path (Join-Path (Join-Path $RepoRoot 'node_modules') 'electron-builder') 'cli.js'
    if (-not (Test-Path -LiteralPath $cli)) {
        throw "electron-builder not installed. Run without -SkipInstall, or run: npm install"
    }
    Write-BuildProgress -StepId $StepId -StepPercent 0 -Detail 'Running'
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    $prevDir = Get-Location
    Set-Location -LiteralPath $RepoRoot
    try {
        node $cli @BuilderArgs
        if ($LASTEXITCODE -ne 0) {
            throw "electron-builder failed (exit $LASTEXITCODE)"
        }
    }
    finally {
        Set-Location -LiteralPath $prevDir.Path
        $ProgressPreference = $prevProgress
    }
    Write-Host "electron-builder finished." -ForegroundColor DarkGray
    Complete-BuildProgressStep -StepId $StepId
}

# --- main ---

$RepoRoot = if ($PSScriptRoot) {
    (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
else {
    (Get-Location).Path
}

if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    throw "package.json not found. Run this script from the repo or place it in scripts/ (repo root: $RepoRoot)"
}

Set-Location $RepoRoot
Write-BuildStartWarning
if (-not $Force) {
    Confirm-BuildStart
}

$onMac = Test-IsMacOS
$onWin = Test-IsWindows
$script:UseBuildProgress = $onWin

Write-Host "Bavarium Browser build"
Write-Host "  Repo:     $RepoRoot"
Write-Host "  Host OS:  $(if ($onMac) { 'macOS' } elseif ($onWin) { 'Windows' } else { 'other' })"
Write-Host "  Platform: $Platform"

$targets = Get-BuildTargets -PlatformChoice $Platform -OnMac $onMac -OnWin $onWin
$targetLabel = @(
    if ($targets.BuildWin) { 'Windows' }
    if ($targets.BuildMac) { 'macOS' }
) -join ', '
Write-Host "  Targets:  $targetLabel"
if ($Platform -eq 'All' -and $onWin -and -not $targets.BuildMac) {
    Write-Host "  Note: macOS skipped on Windows (electron-builder requires a Mac host)." -ForegroundColor DarkYellow
}

Initialize-BuildProgressPlan `
    -IncludeNpmInstall (-not $SkipInstall) `
    -IncludeWinPatch $onWin `
    -IncludeClean ($Clean -and (Test-Path (Join-Path $RepoRoot 'release'))) `
    -IncludeElectronBuilder $true `
    -IncludeMacZip $targets.BuildMac

Assert-Command node
Assert-Command npm
Assert-NodeVersion
Ensure-PythonSetuptoolsForNodeGyp
Complete-BuildProgressStep -StepId 'prepare'

if (-not $SkipInstall) {
    Install-AllDependencies -RepoRoot $RepoRoot
}
else {
    Write-Step 'Skipping npm install (-SkipInstall)'
}

if ($onWin) {
    Write-Step 'Patching electron.exe display name (Task Manager / firewall)'
    Write-BuildProgress -StepId 'patch-electron' -StepPercent 0
    $patchScript = Join-Path (Join-Path $RepoRoot 'scripts') 'patch-electron-win-metadata.cjs'
    & node $patchScript
    Complete-BuildProgressStep -StepId 'patch-electron'
}

$releaseDir = Join-Path $RepoRoot 'release'
Stop-RunningBavariumProcesses -RepoRoot $RepoRoot

if ($Clean -and (Test-Path $releaseDir)) {
    Write-Step "Removing $releaseDir"
    Write-BuildProgress -StepId 'clean-release' -StepPercent 0 -Detail 'Deleting'
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
    Complete-BuildProgressStep -StepId 'clean-release'
}

if ($targets.BuildMac -and -not $onMac -and -not $env:CSC_IDENTITY_AUTO_DISCOVERY) {
    # Avoid hanging on code-sign prompts when cross-compiling macOS without a cert.
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    Write-Host "Set CSC_IDENTITY_AUTO_DISCOVERY=false for unsigned macOS cross-build." -ForegroundColor DarkGray
}

$ebArgs = Get-ElectronBuilderArgs -BuildWin $targets.BuildWin -BuildMac $targets.BuildMac

Write-Step "electron-builder $($ebArgs -join ' ')"
try {
    Invoke-ElectronBuilder -RepoRoot $RepoRoot -BuilderArgs $ebArgs -StepId 'electron-builder'
}
catch {
    Clear-BuildProgress
    throw
}

if ($targets.BuildMac) {
    Compress-MacArm64Folder -ReleaseDir $releaseDir -StepId 'mac-zip'
}

Write-BuildProgress -StepId 'finish' -StepPercent 100 -Detail 'Listing artifacts'
Complete-BuildProgressStep -StepId 'finish'
Clear-BuildProgress

Write-Step 'Build finished'
if (Test-Path $releaseDir) {
    Write-Host "Artifacts in: $releaseDir" -ForegroundColor Green
    Get-ChildItem -LiteralPath $releaseDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -match '\.(exe|zip|AppImage|yml|blockmap)$' } |
        Sort-Object Name |
        ForEach-Object { Write-Host "  $($_.FullName)" }
    if ($targets.BuildMac) {
        $macZip = Join-Path $releaseDir 'mac-arm64.zip'
        if (Test-Path -LiteralPath $macZip) {
            Write-Host "  macOS app zip: $macZip" -ForegroundColor Green
        }
    }
}
else {
    Write-Warning "release/ directory not found; check electron-builder output above."
}

