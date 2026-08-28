$ErrorActionPreference = 'Stop'
$candidates = @()
if ($env:CODEX_BUNDLED_NODE) { $candidates += $env:CODEX_BUNDLED_NODE }
$candidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $nodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw 'Node.js was not found. Install Node.js 22.5 or newer, then retry.'
    }
    $nodePath = $nodeCommand.Source
}

& $nodePath (Join-Path $PSScriptRoot 'launcher.mjs') @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
