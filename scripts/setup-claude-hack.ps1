# setup-claude-hack.ps1 - run Claude Code on your hackathon API credits,
# without touching your normal Claude Pro/Max login. (Windows)
#
# Usage, in PowerShell from the folder where you saved this file:
#   powershell -ExecutionPolicy Bypass -File .\setup-claude-hack.ps1
# Then, in a NEW terminal, in any project folder:
#   claude-hack
#
# What it does:
#   1. Installs Claude Code (official installer) if it's missing.
#   2. Asks for your API key (input hidden) and checks it works.
#   3. Saves the key in %USERPROFILE%\.claude-hackathon\api_key (only your account can read it).
#   4. Creates a `claude-hack` command that uses that key and a separate
#      config folder, defaulting to Sonnet to stretch the credits.
# Plain `claude` keeps using your normal login.
#
# To undo:
#   Remove-Item -Recurse -Force "$env:USERPROFILE\.claude-hackathon", "$env:USERPROFILE\.local\bin\claude-hack.cmd"

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$ConfigDir = Join-Path $env:USERPROFILE '.claude-hackathon'
$KeyFile   = Join-Path $ConfigDir 'api_key'
$BinDir    = Join-Path $env:USERPROFILE '.local\bin'
$Wrapper   = Join-Path $BinDir 'claude-hack.cmd'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say($m)  { Write-Host ""; Write-Host $m -ForegroundColor White }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [x]  $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
Say "1/4  Claude Code"
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$BinDir;$env:Path" }
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  Ok "Already installed: $((& claude --version 2>$null | Select-Object -First 1))"
} else {
  Write-Host "  Installing with the official installer..."
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) { Die "Install finished but 'claude' isn't found. Open a new PowerShell window and rerun this script." }
  Ok "Installed: $((& claude --version 2>$null | Select-Object -First 1))"
}

# ---------------------------------------------------------------------------
Say "2/4  Your API key"
Write-Host "  Create it in platform.claude.com INSIDE A WORKSPACE:"
Write-Host "  Settings -> Workspaces -> (pick or create one) -> API Keys -> Create Key"
Write-Host "  (A key created outside a workspace fails with a 'workspace-id header' error.)"
Write-Host ""
$secure = Read-Host "  Paste your API key (hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$ApiKey = ($ApiKey -replace '\s', '')
if (-not $ApiKey.StartsWith('sk-ant-')) { Die "That doesn't look like an Anthropic API key (should start with sk-ant-)." }

Write-Host "  Checking the key..."
$code = 0; $body = ''
try {
  $r = Invoke-WebRequest -Uri 'https://api.anthropic.com/v1/models' -UseBasicParsing -Method Get `
       -Headers @{ 'x-api-key' = $ApiKey; 'anthropic-version' = '2023-06-01' }
  $code = [int]$r.StatusCode
} catch {
  $resp = $_.Exception.Response
  if ($resp) { try { $code = [int]$resp.StatusCode } catch {} }
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    $body = $_.ErrorDetails.Message
  } elseif ($resp -and ($resp -is [System.Net.WebResponse])) {
    try { $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch {}
  }
}
if ($code -eq 200) {
  Ok "Key works"
} elseif ($body -match '(?i)workspace') {
  Die "This key isn't in a workspace. Create a new key inside a workspace (see above) and rerun."
} elseif ($code -eq 401) {
  Die "Key rejected (401). Check you copied the whole key, or create a new one."
} else {
  Warn "Couldn't confirm the key (HTTP $code). Continuing anyway; test it with: claude-hack"
}

# ---------------------------------------------------------------------------
Say "3/4  Saving the key"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
[IO.File]::WriteAllText($KeyFile, $ApiKey, $Utf8NoBom)
Remove-Variable ApiKey
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  & icacls $KeyFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
}
Ok "Saved to $KeyFile (readable only by your account)"

$Settings = Join-Path $ConfigDir 'settings.json'
if (-not (Test-Path $Settings)) {
  [IO.File]::WriteAllText($Settings, "{`n  `"model`": `"sonnet`"`n}`n", $Utf8NoBom)
  Ok "Default model: Sonnet (use /model to switch to Opus for hard problems)"
}

# ---------------------------------------------------------------------------
Say "4/4  Creating the claude-hack command"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cmd = @'
@echo off
rem Runs Claude Code on hackathon API credits, isolated from your normal login.
setlocal
set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-hackathon"
if not exist "%CLAUDE_CONFIG_DIR%\api_key" (
  echo No key at %CLAUDE_CONFIG_DIR%\api_key. Rerun setup-claude-hack.ps1. 1>&2
  exit /b 1
)
set /p ANTHROPIC_API_KEY=<"%CLAUDE_CONFIG_DIR%\api_key"
if exist "%USERPROFILE%\.local\bin\claude.exe" (
  "%USERPROFILE%\.local\bin\claude.exe" %*
) else (
  claude %*
)
'@
[IO.File]::WriteAllText($Wrapper, ($cmd -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
Ok "Created $Wrapper (works from PowerShell and Command Prompt)"

# Make sure %USERPROFILE%\.local\bin is on the User PATH for new terminals.
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $BinDir) {
  $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
  Ok "Added $BinDir to your User PATH"
} else {
  Ok "$BinDir is already on your PATH"
}

# ---------------------------------------------------------------------------
Say "Done"
@"
  Next:
    1. Open a NEW terminal window (close and reopen VS Code if you use its terminal)
    2. cd into your project folder
    3. Run: claude-hack
    4. When asked whether to use the API key, choose Yes
    5. Type /status and check it says it's using the API key ("API Usage Billing")

  Plain 'claude' still uses your normal Claude login.
  For the app's own Claude calls, put the same key in the project's .env
  (ANTHROPIC_API_KEY=...) and make sure .env is in .gitignore.
  Undo: Remove-Item -Recurse -Force "`$env:USERPROFILE\.claude-hackathon", "`$env:USERPROFILE\.local\bin\claude-hack.cmd"
"@ | Write-Host
