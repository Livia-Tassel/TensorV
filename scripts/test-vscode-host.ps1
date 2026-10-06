param(
    [string]$CodePath,
    [string]$ExtensionPath,
    [string]$PythonPath,
    [switch]$Untrusted,
    [int]$DebugPort = 0
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExtensionPath) { $ExtensionPath = Join-Path $projectRoot 'extensions\vscode' }
if (-not $PythonPath) { $PythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe' }
if (-not $CodePath) {
    $codeCommand = Get-Command code -ErrorAction Stop
    $CodePath = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCommand.Source)) 'Code.exe'
}
foreach ($requiredPath in @($CodePath, $PythonPath, (Join-Path $ExtensionPath 'package.json'))) {
    if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required path is missing: $requiredPath" }
}

$verificationRoot = Join-Path $projectRoot ('test-results\vscode-host-' + [guid]::NewGuid().ToString('N'))
$fixturePath = Join-Path $verificationRoot 'workspace'
$profilePath = Join-Path $verificationRoot 'profile'
$extensionsPath = Join-Path $verificationRoot 'extensions'
New-Item -ItemType Directory -Path $fixturePath, $profilePath, $extensionsPath -Force | Out-Null
if ($Untrusted) {
    $settingsDirectory = Join-Path $profilePath 'User'
    New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
    '{"security.workspace.trust.enabled":true,"security.workspace.trust.startupPrompt":"never"}' |
        Set-Content -LiteralPath (Join-Path $settingsDirectory 'settings.json') -Encoding utf8
}
$resultPath = Join-Path $verificationRoot 'result.json'
$stdoutPath = Join-Path $verificationRoot 'stdout.log'
$stderrPath = Join-Path $verificationRoot 'stderr.log'
$testEntry = Join-Path $projectRoot 'extensions\vscode\test\host-integration.cjs'

$previousResults = $env:TENSORV_TEST_RESULTS
$previousPython = $env:TENSORV_TEST_PYTHON
$previousElectronMode = $env:ELECTRON_RUN_AS_NODE
$previousTrustMode = $env:TENSORV_TEST_UNTRUSTED
$env:TENSORV_TEST_RESULTS = $resultPath
$env:TENSORV_TEST_PYTHON = (Resolve-Path -LiteralPath $PythonPath).Path
$env:TENSORV_TEST_UNTRUSTED = if ($Untrusted) { '1' } else { '0' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$vscodeProcess = $null
try {
    # Every profile and fixture is isolated from the user's normal VS Code.
    # Only this test instance disables trust prompts; product trust is unchanged.
    $arguments = @(
        ('--extensionDevelopmentPath="' + (Resolve-Path -LiteralPath $ExtensionPath).Path + '"'),
        ('--extensionTestsPath="' + $testEntry + '"'),
        ('--user-data-dir="' + $profilePath + '"'),
        ('--extensions-dir="' + $extensionsPath + '"'),
        '--disable-extensions',
        '--skip-welcome', '--skip-release-notes', '--disable-updates',
        ('"' + $fixturePath + '"')
    )
    if (-not $Untrusted) { $arguments += '--disable-workspace-trust' }
    if ($DebugPort -gt 0) { $arguments += "--remote-debugging-port=$DebugPort" }
    $vscodeProcess = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $deadline = [DateTime]::UtcNow.AddSeconds(150)
    while (-not $vscodeProcess.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'VS Code Extension Host tests timed out after 150 seconds.' }
    }
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "VS Code produced no test result. Inspect $stderrPath" }
    $report = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $report | ConvertTo-Json -Depth 8
    if (-not $report.ok -or $vscodeProcess.ExitCode -ne 0) { throw "VS Code Extension Host verification failed. See $resultPath" }
} finally {
    if ($vscodeProcess -and -not $vscodeProcess.HasExited) { $vscodeProcess.Kill($true) }
    $env:TENSORV_TEST_RESULTS = $previousResults
    $env:TENSORV_TEST_PYTHON = $previousPython
    $env:ELECTRON_RUN_AS_NODE = $previousElectronMode
    $env:TENSORV_TEST_UNTRUSTED = $previousTrustMode
}
