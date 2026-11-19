# Registers the native messaging host for Chrome, Chromium-based browsers and Vivaldi (current user only).
$ErrorActionPreference = 'Stop'

$HostName = 'com.bookmarker.writer'
$ExtensionId = 'ecfhfdccjhffhlpjhiefgnpafbkfniia'

$node = (Get-Command node -ErrorAction Stop).Source
$hostDir = $PSScriptRoot
$bat = Join-Path $hostDir 'host.bat'
$manifestPath = Join-Path $hostDir "$HostName.json"

Set-Content -Path $bat -Value "@echo off`r`n`"$node`" `"$(Join-Path $hostDir 'host.js')`"" -Encoding ASCII

$manifest = [ordered]@{
  name            = $HostName
  description     = 'Bookmarker file writer'
  path            = $bat
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding ASCII

foreach ($vendor in 'Google\Chrome', 'Chromium', 'Vivaldi', 'BraveSoftware\Brave-Browser') {
  $key = "HKCU:\Software\$vendor\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "Registered: $key"
}
Write-Host "Done. Restart the browser, then reload the extension."
