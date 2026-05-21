#Requires -Version 5.1
<#
.SYNOPSIS
  Install dependencies and build Bavarium Browser installers with electron-builder.

.DESCRIPTION
  Installs npm packages in the Electron shell, ultraviolet-app, and scramjet-app,
  then runs electron-builder for the selected platform(s). Artifacts are written to release/.

  Windows targets (from package.json): NSIS installer + portable .exe
  macOS: unpacked app in release/mac-arm64/, then release/mac-arm64.zip (no DMG)

.PARAMETER Platform
  All | Windows | Mac — which platform(s) to build.

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

function Invoke-NpmInstall([string] $Directory, [string] $Label) {
    Write-Step "npm install — $Label ($Directory)"
    Push-Location $Directory
    try {
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed in $Directory (exit $LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }
}

function Install-AllDependencies([string] $RepoRoot) {
    Invoke-NpmInstall -Directory $RepoRoot -Label 'Bavarium shell'
    Invoke-NpmInstall -Directory (Join-Path $RepoRoot 'ultraviolet-app') -Label 'Ultraviolet proxy'
    Invoke-NpmInstall -Directory (Join-Path $RepoRoot 'scramjet-app') -Label 'Scramjet proxy (patch-package postinstall)'
}

function Get-ElectronBuilderArgs([string] $PlatformChoice) {
    $args = @()

    if ($PlatformChoice -in 'All', 'Windows') {
        $args += '--win'
    }

    if ($PlatformChoice -in 'All', 'Mac') {
        # Unpacked dir is zipped afterward as release/mac-arm64.zip
        $args += '--mac', 'dir'
    }

    if ($args.Count -eq 0) {
        throw 'No platforms selected for build.'
    }

    return $args
}

function Compress-MacArm64Folder([string] $ReleaseDir) {
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
    if (Test-IsMacOS) {
        & ditto -c -k --sequesterRsrc --keepParent $macDir.FullName $zipPath
        if ($LASTEXITCODE -ne 0) {
            throw "ditto failed creating $zipName (exit $LASTEXITCODE)"
        }
    }
    else {
        Compress-Archive -LiteralPath $macDir.FullName -DestinationPath $zipPath -CompressionLevel Optimal
    }

    Write-Host "  Created: $zipPath" -ForegroundColor Green
}

function Invoke-ElectronBuilder([string] $RepoRoot, [string[]] $BuilderArgs) {
    $cli = Join-Path $RepoRoot 'node_modules' 'electron-builder' 'cli.js'
    if (-not (Test-Path -LiteralPath $cli)) {
        throw "electron-builder not installed. Run without -SkipInstall, or run: npm install"
    }
    # Call the CLI directly so npm/npx does not swallow flags like --win (npm 11+).
    & node $cli @BuilderArgs
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

Write-Host "Bavarium Browser build"
Write-Host "  Repo:     $RepoRoot"
Write-Host "  Host OS:  $(if ($onMac) { 'macOS' } elseif ($onWin) { 'Windows' } else { 'other' })"
Write-Host "  Platform: $Platform"

Assert-Command node
Assert-Command npm
Assert-NodeVersion

if (-not $SkipInstall) {
    Install-AllDependencies -RepoRoot $RepoRoot
}
else {
    Write-Step 'Skipping npm install (-SkipInstall)'
}

$releaseDir = Join-Path $RepoRoot 'release'
if ($Clean -and (Test-Path $releaseDir)) {
    Write-Step "Removing $releaseDir"
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}

if ($Platform -in 'All', 'Mac') {
    if (-not $onMac -and -not $env:CSC_IDENTITY_AUTO_DISCOVERY) {
        # Avoid hanging on code-sign prompts when cross-compiling macOS without a cert.
        $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
        Write-Host "Set CSC_IDENTITY_AUTO_DISCOVERY=false for unsigned macOS cross-build." -ForegroundColor DarkGray
    }
}

$ebArgs = Get-ElectronBuilderArgs -PlatformChoice $Platform

Write-Step "electron-builder $($ebArgs -join ' ')"
Invoke-ElectronBuilder -RepoRoot $RepoRoot -BuilderArgs $ebArgs
if ($LASTEXITCODE -ne 0) {
    throw "electron-builder failed (exit $LASTEXITCODE)"
}

if ($Platform -in 'All', 'Mac') {
    Compress-MacArm64Folder -ReleaseDir $releaseDir
}

Write-Step 'Build finished'
if (Test-Path $releaseDir) {
    Write-Host "Artifacts in: $releaseDir" -ForegroundColor Green
    Get-ChildItem -LiteralPath $releaseDir -Recurse -File |
        Where-Object { $_.Extension -match '\.(exe|zip|AppImage|yml|blockmap)$' } |
        Sort-Object FullName |
        ForEach-Object { Write-Host "  $($_.FullName)" }
}
else {
    Write-Warning "release/ directory not found; check electron-builder output above."
}

