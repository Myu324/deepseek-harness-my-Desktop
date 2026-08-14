<#
.SYNOPSIS
  Build, tag, and publish a new desktop-shell release to the Myu324 fork.

.DESCRIPTION
  Bumps apps/desktop/package.json to the given version, rebuilds and packs the
  NSIS installer, commits every apps/desktop change together with the version
  bump, tags v<version>, pushes both, and creates the GitHub Release with the
  three assets electron-updater needs (installer + latest.yml + stable.yml).

  Prerequisites: GitHub CLI installed and authenticated (gh auth login), and a
  clean-enough working tree (changes outside apps/desktop are left alone).

.PARAMETER Version
  New shell version, e.g. 0.1.2. Must be a plain stable semver (no -rc: the
  updater skips prereleases).

.PARAMETER Notes
  Optional release notes for the GitHub Release.

.EXAMPLE
  .\release-desktop.ps1 -Version 0.1.2 -Notes 'Fix tray crash'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = 'Desktop shell release.'
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$desktopDir = Join-Path $repoRoot 'apps/desktop'
$packageJson = Join-Path $desktopDir 'package.json'
$artifacts = Join-Path $desktopDir '.artifacts'

function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string]$Display, [Parameter(Mandatory = $true)][scriptblock]$Block)
  Write-Host "== $Display" -ForegroundColor Cyan
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "step failed: $Display" }
}

function Get-Gh {
  $cmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($cmd) { return 'gh' }
  $fallback = 'C:\Program Files\GitHub CLI\gh.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'gh CLI not found; install it (winget install GitHub.cli) and run gh auth login'
}

# 1. Validate the version and the preconditions.
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "version must be a plain stable semver like 0.1.2 (got $Version); prerelease tags are skipped by the updater"
}
$gh = Get-Gh
Set-Location $repoRoot
& $gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'gh is not authenticated; run: gh auth login' }

# 2. Bump the shell version.
$manifest = Get-Content $packageJson -Raw
$bumped = [regex]::Replace($manifest, '"version"\s*:\s*"[^"]*"', ('"version": "{0}"' -f $Version), 1)
Set-Content -Path $packageJson -Value $bumped -NoNewline
Write-Host "bumped apps/desktop to $Version"

# 3. Build and pack the installer.
Invoke-Checked 'shell build' { pnpm --filter @deepseek-ai/dsh-desktop run build }
Invoke-Checked 'electron-builder pack' { pnpm --filter @deepseek-ai/dsh-desktop run pack }

# 4. Stage the assets under the names the update feed references
#    (latest.yml url-encodes spaces as dashes; stable.yml is a copy).
$setup = Join-Path $artifacts "DeepSeek Harness Setup $Version.exe"
$setupUrl = Join-Path $artifacts "DeepSeek-Harness-Setup-$Version.exe"
$latestYml = Join-Path $artifacts 'latest.yml'
$stableYml = Join-Path $artifacts 'stable.yml'
if (-not (Test-Path $setup)) { throw "packer did not produce $setup" }
Copy-Item $setup $setupUrl -Force
Copy-Item $latestYml $stableYml -Force

# 5. Commit, tag, and push.
Invoke-Checked 'commit and tag' {
  git add apps/desktop
  git commit -m "release(desktop): publish shell $Version"
  git tag "v$Version"
  git push origin master
  git push origin "v$Version"
}

# 6. Create the GitHub Release with the update assets.
Invoke-Checked "gh release create v$Version" {
  & $gh release create "v$Version" $latestYml $stableYml $setupUrl `
    -R Myu324/deepseek-harness-my-Desktop `
    --title "DeepSeek Harness Desktop $Version" `
    --notes $Notes
}

Write-Host ''
Write-Host "Released: https://github.com/Myu324/deepseek-harness-my-Desktop/releases/tag/v$Version" -ForegroundColor Green
Write-Host 'Installed clients pick it up on their next background check (30 s after start) and install on quit.'
