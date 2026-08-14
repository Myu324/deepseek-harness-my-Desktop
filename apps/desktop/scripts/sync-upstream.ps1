<#
.SYNOPSIS
  Sync this fork with the official deepseek-ai/deepseek-harness repository.

.DESCRIPTION
  Fetch upstream, merge upstream/master into the local master, regenerate the
  dependency lockfile, rebuild everything, and run the desktop-shell tests.
  The working tree must be clean before starting. On merge conflicts the
  script stops and prints the conflicted files; resolve them manually, then
  re-run the steps the script prints.

  Generated catalogs (client slot catalog, config catalog, doc graphs) and
  bilingual doc pairings are verified but NOT rewritten: when a verification
  fails, the script prints the exact regeneration command to run.

.EXAMPLE
  .\sync-upstream.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string]$Display, [Parameter(Mandatory = $true)][scriptblock]$Block)
  Write-Host "== $Display" -ForegroundColor Cyan
  & $Block
  if ($LASTEXITCODE -ne 0) {
    throw "step failed: $Display"
  }
}

Set-Location $repoRoot

# 1. The tree must be clean so the merge never clobbers local work.
$dirty = git status --porcelain
if ($dirty) {
  throw "working tree is not clean; commit or stash before syncing:`n$dirty"
}

# 2. Fetch and compare.
Write-Host '== fetching upstream' -ForegroundColor Cyan
git fetch upstream
if ($LASTEXITCODE -ne 0) { throw 'git fetch upstream failed (network?)' }

$behind = git rev-list --count master..upstream/master
if ($LASTEXITCODE -ne 0) { throw 'cannot compare with upstream/master' }
if ([int]$behind -eq 0) {
  Write-Host 'Already up to date with upstream/master; nothing to sync.' -ForegroundColor Green
  exit 0
}
Write-Host "upstream is $behind commit(s) ahead:" -ForegroundColor Yellow
git log --oneline --no-merges master..upstream/master

# 3. Merge. A conflict leaves the index untouched for manual resolution.
git merge upstream/master --no-edit
if ($LASTEXITCODE -ne 0) {
  $conflicts = git diff --name-only --diff-filter=U
  Write-Host ''
  Write-Host 'MERGE CONFLICTS — resolve manually, then run:' -ForegroundColor Red
  Write-Host $conflicts -ForegroundColor Red
  Write-Host '  pnpm install'
  Write-Host '  pnpm run build'
  Write-Host '  pnpm exec vitest run apps/desktop'
  Write-Host 'then commit the merge and push.' -ForegroundColor Red
  exit 1
}

# 4. Regenerate the lockfile and rebuild.
Invoke-Checked 'pnpm install' { pnpm install }
Invoke-Checked 'pnpm run build' { pnpm run build }

# 5. Generated catalogs: verify only; print the fix command when stale.
foreach ($gate in @('verify-client-catalog', 'verify-config-catalog', 'verify-doc-graphs')) {
  pnpm run $gate *> $null
  if ($LASTEXITCODE -ne 0) {
    $gen = $gate -replace '^verify-', 'gen-'
    Write-Host "WARN: $gate failed — run `"pnpm run $gen`" and commit the result (or update the zh pairing)." -ForegroundColor Yellow
  }
}

# 6. Desktop shell still healthy.
Invoke-Checked 'desktop shell tests' { pnpm exec vitest run apps/desktop }

Write-Host ''
Write-Host 'Sync complete. Review, then push with:' -ForegroundColor Green
Write-Host '  git push origin master'
