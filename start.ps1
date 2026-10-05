[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Install Node.js 20.19+ or 22.12+, then restart PowerShell.'
}

$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    if ($env:TENSORV_PYTHON) {
        Invoke-Checked -Command $env:TENSORV_PYTHON -Arguments @('-m', 'venv', '.venv')
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        Invoke-Checked -Command 'py' -Arguments @('-3', '-m', 'venv', '.venv')
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        Invoke-Checked -Command 'python' -Arguments @('-m', 'venv', '.venv')
    } else {
        throw 'Python 3.10+ is required. Install Python or set TENSORV_PYTHON to a Python executable.'
    }
}

& $pythonPath -c 'import torch, numpy'
if ($LASTEXITCODE -ne 0) {
    Invoke-Checked -Command $pythonPath -Arguments @('-m', 'pip', 'install', '-r', 'requirements.txt')
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    Invoke-Checked -Command 'npm.cmd' -Arguments @('ci')
}
Invoke-Checked -Command 'npm.cmd' -Arguments @('run', 'build')
Write-Host "TensorV: http://127.0.0.1:$Port (Ctrl+C to stop)"
Invoke-Checked -Command $pythonPath -Arguments @('-m', 'tensorv.server', '--port', "$Port")
