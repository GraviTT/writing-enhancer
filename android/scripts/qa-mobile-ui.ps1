param(
    [ValidateSet('input', 'result', 'chat', 'current')][string]$Scene = 'current',
    [int]$Width = 380,
    [int]$Height = 720,
    [string]$Name = 'preview'
)
$ErrorActionPreference = 'Stop'
$qaAdb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$qaRoot = Split-Path $PSScriptRoot -Parent
$qaOutput = Join-Path $qaRoot 'device-qa\ui-0.4.3'
$qaSerial = 'emulator-5580'
if ((& $qaAdb -s $qaSerial shell getprop ro.kernel.qemu).Trim() -ne '1') {
    throw 'This script only operates on the dedicated QA emulator.'
}
New-Item -ItemType Directory -Path $qaOutput -Force | Out-Null

function Read-NativeUi {
    $dumpReady = $false
    for ($retry = 0; $retry -lt 4; $retry++) {
        $dumpResult = & $qaAdb -s $qaSerial shell uiautomator dump /sdcard/writing-ui-qa.xml 2>&1
        if ($dumpResult -match 'dumped to') { $dumpReady = $true; break }
        Start-Sleep -Milliseconds 600
    }
    if (-not $dumpReady) { throw 'Native UI was unavailable; refusing to use a stale hierarchy.' }
    & $qaAdb -s $qaSerial pull /sdcard/writing-ui-qa.xml (Join-Path $qaOutput 'current.xml') 2>$null | Out-Null
    [xml](Get-Content -LiteralPath (Join-Path $qaOutput 'current.xml') -Raw)
}

function Click-NativeNode([string]$XPath) {
    $tree = Read-NativeUi
    $node = $tree.SelectSingleNode($XPath)
    if (-not $node) { throw "UI element not found: $XPath" }
    $numbers = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
    $x = [int](($numbers[0] + $numbers[2]) / 2)
    $y = [int](($numbers[1] + $numbers[3]) / 2)
    & $qaAdb -s $qaSerial shell input tap $x $y
    Start-Sleep -Milliseconds 450
}

function Save-NativeScreen([string]$ScreenName) {
    $null = Read-NativeUi
    Copy-Item -LiteralPath (Join-Path $qaOutput 'current.xml') -Destination (Join-Path $qaOutput "$ScreenName.xml") -Force
    & $qaAdb -s $qaSerial shell screencap -p /sdcard/writing-ui-qa.png
    & $qaAdb -s $qaSerial pull /sdcard/writing-ui-qa.png (Join-Path $qaOutput "$ScreenName.png") 2>$null | Out-Null
    Write-Output "Saved native screenshot: $ScreenName"
}

if ($Scene -ne 'current') {
    & $qaAdb -s $qaSerial shell am force-stop com.example.writingenhancer
    $fixtureResult = & $qaAdb -s $qaSerial shell am instrument -w -e scene $Scene -e width $Width -e height $Height com.example.writingenhancer.test/com.example.writingenhancer.NativeUiQa
    Write-Output $fixtureResult
    if (-not ($fixtureResult -match 'checks passed') -or $fixtureResult -match 'FAILED') {
        throw 'Native fixture assertions failed.'
    }
    & $qaAdb -s $qaSerial shell am start -n com.example.writingenhancer/.MainActivity | Out-Null
    Start-Sleep -Milliseconds 800
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $tree = Read-NativeUi
        if ($tree.SelectSingleNode('//node[@text="버블 시작"]')) { break }
        & $qaAdb -s $qaSerial shell input swipe 540 1850 540 950 400
    }
    Click-NativeNode '//node[@text="버블 시작"]'
    Start-Sleep -Milliseconds 1200
    # Bubble position is deterministic in this dedicated 1080x2400 emulator profile.
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        & $qaAdb -s $qaSerial shell input tap 978 820
        Start-Sleep -Milliseconds 900
        $tree = Read-NativeUi
        if ($tree.SelectSingleNode('//node[@content-desc="버블로 접기"]')) { break }
    }
    if (-not $tree.SelectSingleNode('//node[@content-desc="버블로 접기"]')) { throw 'Popup failed to open' }
}
Save-NativeScreen $Name
