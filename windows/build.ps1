param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist\windows'),
  [string]$ToolDirectory,
  [string]$Version = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'version.txt')).Trim(),
  [string]$DictionaryWheel,
  [string]$UpdateFrom,
  [switch]$Verification
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$' -or ($Version.Split('.') | Where-Object { [int]$_ -gt 65535 })) {
  throw 'Use a three-part Windows version number.'
}
if ($UpdateFrom -and ($UpdateFrom -notmatch '^\d+\.\d+\.\d+$' -or [Version]$UpdateFrom -ge [Version]$Version)) {
  throw 'The update must target a specific older Windows version.'
}

$Root = Split-Path -Parent $PSScriptRoot
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (!$ToolDirectory) { $ToolDirectory = Join-Path $OutputDirectory '.tools' }
$ToolDirectory = [IO.Path]::GetFullPath($ToolDirectory)
$Build = Join-Path $OutputDirectory ('.build\' + [Guid]::NewGuid().ToString('N'))
$Payload = Join-Path $Build 'payload'
$Project = Join-Path $Build 'windows'
$Archives = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $ToolDirectory,$Build,$Payload,$Project | Out-Null

$RuntimeFiles = @('node-runtime.zip','python-portable.zip','fugashi.whl','unidic-lite.tar.gz')
$RuntimeSources = @($RuntimeFiles | ForEach-Object { $Archives.PSObject.Properties[$_].Value.sha256.ToLowerInvariant() })
$RuntimeSources += (Get-FileHash -LiteralPath (Join-Path $Root 'services\netease\package-lock.json')).Hash.ToLowerInvariant()
$Sha = [Security.Cryptography.SHA256]::Create()
try {
  $RuntimeId = [BitConverter]::ToString($Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($RuntimeSources -join "`n")))).Replace('-','').ToLowerInvariant()
} finally { $Sha.Dispose() }
# 0.1.0 predates the installed runtime marker and can only provide this exact set of dependencies.
if ($UpdateFrom -eq '0.1.0' -and $RuntimeId -ne '02e2641bea201e405a16ced052bb5b473410d082e6dbd3f4ddb3abfd0c2b9ff9') {
  throw 'These dependencies cannot be reused from UtaLoop 0.1.0. Build the full installer.'
}
Set-Content -NoNewline -Encoding ascii -LiteralPath (Join-Path $Payload 'utaloop-desktop-runtime.txt') -Value $RuntimeId

function Invoke-BuildTool($Binary, [string[]]$Arguments) {
  & $Binary @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Binary exited with code $LASTEXITCODE." }
}

function Get-Archive($Name) {
  $Spec = $Archives.PSObject.Properties[$Name].Value
  $File = Join-Path $ToolDirectory $Name
  if (!(Test-Path -LiteralPath $File)) {
    $Download = $File + '.download'
    Invoke-BuildTool curl.exe @('--fail','--silent','--show-error','--location','--ssl-revoke-best-effort',
      '--retry','2','--connect-timeout','20','--max-time','1200','--output',$Download,$Spec.url)
    if ((Get-FileHash -LiteralPath $Download).Hash -ne $Spec.sha256) { throw "Checksum mismatch for $Name." }
    Move-Item -LiteralPath $Download -Destination $File
  }
  if ((Get-FileHash -LiteralPath $File).Hash -ne $Spec.sha256) { throw "Checksum mismatch for $File." }
  return $File
}

function Expand-BundledArchive($Name, $Directory) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  Invoke-BuildTool tar.exe @('-xf',(Get-Archive $Name),'-C',$Directory)
}

$Dotnet = Join-Path $ToolDirectory 'dotnet-sdk\dotnet.exe'
if (!(Test-Path -LiteralPath $Dotnet)) { Expand-BundledArchive 'dotnet-sdk.zip' (Split-Path -Parent $Dotnet) }
$Nsis = Join-Path $ToolDirectory 'nsis-3.12\Bin\makensis.exe'
if (!(Test-Path -LiteralPath $Nsis)) { Expand-BundledArchive 'nsis.zip' $ToolDirectory }
$Web = Join-Path $Payload 'web'
New-Item -ItemType Directory -Force -Path $Web,(Join-Path $Build 'web') | Out-Null
foreach ($File in @('index.html','player.html','music.html','favicon.ico','manifest.webmanifest')) {
  Copy-Item -LiteralPath (Join-Path $Root "web\$File") -Destination $Web
}
foreach ($Directory in @('assets','css','icons','js')) {
  Copy-Item -LiteralPath (Join-Path $Root "web\$Directory") -Destination $Web -Recurse
}
Copy-Item -LiteralPath (Join-Path $Web 'favicon.ico') -Destination (Join-Path $Build 'web')
foreach ($File in @('Program.cs','DesktopAudio.cs','DesktopServices.cs','UtaLoop.Desktop.csproj','App.config','app.manifest')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $File) -Destination $Project
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'serve_desktop.py') -Destination $Payload

$env:DOTNET_CLI_HOME = Join-Path $ToolDirectory 'dotnet-home'
$env:DOTNET_NOLOGO = '1'
$env:NUGET_PACKAGES = Join-Path $ToolDirectory 'nuget'
$env:npm_config_cache = Join-Path $ToolDirectory 'npm-cache'
Invoke-BuildTool $Dotnet @('publish',(Join-Path $Project 'UtaLoop.Desktop.csproj'),'-c','Release','-o',$Payload,
  '--source','https://api.nuget.org/v3/index.json',"-p:Version=$Version")

$Pipeline = Join-Path $Root 'pipeline'
foreach ($File in Get-ChildItem -LiteralPath $Pipeline -Recurse -File -Filter '*.py') {
  $Relative = $File.FullName.Substring($Pipeline.Length + 1)
  $Destination = Join-Path $Payload "pipeline\$Relative"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $File.FullName -Destination $Destination
}

$Music = Join-Path $Payload 'services\netease'
New-Item -ItemType Directory -Path $Music | Out-Null
foreach ($File in @('server.cjs','session-store.cjs','provider-cookies.cjs','audio-cache.cjs','package.json','package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $Root "services\netease\$File") -Destination $Music
}
$Licenses = Join-Path $Payload 'licenses'
New-Item -ItemType Directory -Path $Licenses | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'LICENSE') -Destination (Join-Path $Licenses 'UtaLoop.txt')
$ProjectXml = [xml](Get-Content -Raw -LiteralPath (Join-Path $Project 'UtaLoop.Desktop.csproj'))
$WebViewVersion = $ProjectXml.SelectSingleNode("//PackageReference[@Include='Microsoft.Web.WebView2']").GetAttribute('Version')
$WebViewPackage = Join-Path $env:NUGET_PACKAGES "microsoft.web.webview2\$WebViewVersion"
Copy-Item -LiteralPath (Join-Path $WebViewPackage 'LICENSE.txt') -Destination (Join-Path $Licenses 'WebView2.txt')
Copy-Item -LiteralPath (Join-Path $WebViewPackage 'NOTICE.txt') -Destination (Join-Path $Licenses 'WebView2-notices.txt')

if (!$UpdateFrom) {
  $NodeHome = Join-Path $ToolDirectory 'node-v24.22.1-win-x64'
  $Node = Join-Path $NodeHome 'node.exe'
  $Npm = Join-Path $NodeHome 'node_modules\npm\bin\npm-cli.js'
  if (!(Test-Path -LiteralPath $Npm)) { Expand-BundledArchive 'node-runtime.zip' $ToolDirectory }
  Invoke-BuildTool $Node @($Npm,'ci','--prefix',$Music,'--omit=dev','--ignore-scripts','--no-audit','--no-fund')
  $NodeRuntime = Join-Path $Payload 'runtime\node'
  New-Item -ItemType Directory -Path $NodeRuntime | Out-Null
  Copy-Item -LiteralPath $Node,(Join-Path $NodeHome 'LICENSE') -Destination $NodeRuntime

  $PythonRuntime = Join-Path $Payload 'runtime\python'
  $Packages = Join-Path $PythonRuntime 'site-packages'
  Expand-BundledArchive 'python-portable.zip' $PythonRuntime
  Expand-BundledArchive 'fugashi.whl' $Packages
  if ($DictionaryWheel) {
    if ((Split-Path -Leaf $DictionaryWheel) -ne 'unidic_lite-1.0.8-py3-none-any.whl') {
      throw 'The cached wheel must be the pinned UniDic Lite 1.0.8 release.'
    }
    Invoke-BuildTool tar.exe @('-xf',(Resolve-Path -LiteralPath $DictionaryWheel).Path,'-C',$Packages)
    $DictionaryLicenses = Join-Path $Packages 'unidic_lite-1.0.8.dist-info\licenses'
  } else {
    Expand-BundledArchive 'unidic-lite.tar.gz' $Build
    $DictionaryLicenses = Join-Path $Build 'unidic-lite-1.0.8'
    Copy-Item -LiteralPath (Join-Path $DictionaryLicenses 'unidic_lite') -Destination $Packages -Recurse
  }
  # python314._pth isolates the bundled interpreter from the host's Python installations.
  @('python314.zip','.','site-packages','..\..') | Set-Content -Encoding ascii -LiteralPath (Join-Path $PythonRuntime 'python314._pth')
  Push-Location $Payload
  try {
    Invoke-BuildTool (Join-Path $PythonRuntime 'python.exe') @('-B','-c',
      "from pathlib import Path; from unidic_lite import DICDIR; from pipeline.tokenizer import JapaneseTokenizer; assert JapaneseTokenizer(Path(DICDIR).relative_to(Path.cwd())).tokenize(chr(26085))")
  } finally { Pop-Location }
  Copy-Item -LiteralPath (Join-Path $DictionaryLicenses 'LICENSE') -Destination (Join-Path $Licenses 'UniDic-Lite.txt')
  Copy-Item -LiteralPath (Join-Path $DictionaryLicenses 'LICENSE.unidic') -Destination (Join-Path $Licenses 'UniDic.txt')
}

$Kind = if ($UpdateFrom) { "Update-from-$UpdateFrom" } else { 'Setup' }
if ($Verification) { $Kind = "Verification-$Kind" }
$Name = "UtaLoop-$Version-$Kind-x64.exe"
$Installer = Join-Path $OutputDirectory $Name
$Options = @('/V2','/INPUTCHARSET','UTF8',"/DVERSION=$Version","/DPAYLOAD=$Payload",
  "/DOUTPUT_FILE=$Installer","/DAPP_ICON=$(Join-Path $Web 'favicon.ico')")
if ($Verification) { $Options += @('/DINSTALL_ID=Verification','/DDISPLAY_NAME=UtaLoop Verification') }
if ($UpdateFrom) { $Options += @("/DUPDATE_FROM=$UpdateFrom","/DRUNTIME_ID=$RuntimeId") }
$Options += (Join-Path $PSScriptRoot 'install.nsi')
Invoke-BuildTool $Nsis $Options
Get-Item -LiteralPath $Installer | Select-Object FullName,Length
Get-FileHash -LiteralPath $Installer -Algorithm SHA256
