$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$previousLocation = Get-Location
$previousJavaHome = $env:JAVA_HOME
$verificationSummary = [System.Collections.Generic.List[string]]::new()

try {
    Push-Location (Join-Path $projectRoot "shared")
    npm.cmd test
    if ($LASTEXITCODE -ne 0) {
        throw "Shared tests failed."
    }
    $verificationSummary.Add("Shared contracts and policies: passed")
    Pop-Location

    Push-Location (Join-Path $projectRoot "desktop")
    npm.cmd test
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop tests failed."
    }
    npm.cmd run screenshot
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop QA capture failed."
    }
    npm.cmd run dist
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop portable build failed."
    }
    npm.cmd run smoke
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop portable direct-launch smoke test failed."
    }
    $verificationSummary.Add("Windows tests, QA capture, portable build, and direct-launch smoke: passed")
    Pop-Location

    if (-not $env:JAVA_HOME) {
        $androidStudioJdk = "C:\Program Files\Android\Android Studio\jbr"
        if (Test-Path $androidStudioJdk) {
            $env:JAVA_HOME = $androidStudioJdk
        }
    }

    Push-Location (Join-Path $projectRoot "android")
    .\gradlew.bat test lintDebug assembleDebug
    if ($LASTEXITCODE -ne 0) {
        throw "Android tests, lint, or APK build failed."
    }
    Copy-Item `
        -LiteralPath ".\app\build\outputs\apk\debug\app-debug.apk" `
        -Destination ".\WritingEnhancer-debug.apk" `
        -Force
    $lintReport = ".\app\build\reports\lint-results-debug.xml"
    if (-not (Test-Path -LiteralPath $lintReport)) {
        throw "Android lint XML report was not generated."
    }
    [xml]$lintXml = Get-Content -Raw -LiteralPath $lintReport
    $lintIssueCount = @($lintXml.SelectNodes("//issue")).Count
    if ($lintIssueCount -ne 0) {
        throw "Android lint contains $lintIssueCount issue(s)."
    }
    $verificationSummary.Add("Android unit tests, lint (0 issues), and debug APK build: passed")
    Pop-Location

    $desktopPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "desktop\package.json") |
        ConvertFrom-Json
    $desktopArtifactName = "Writing-Enhancer-$($desktopPackage.version)-portable.zip"
    $artifacts = @(
        @{
            Path = Join-Path $projectRoot "desktop\dist\$desktopArtifactName"
            Label = "Windows portable ZIP"
        },
        @{
            Path = Join-Path $projectRoot "android\WritingEnhancer-debug.apk"
            Label = "Android debug APK"
        }
    )

    $artifactHashes = @{}
    foreach ($artifact in $artifacts) {
        if (-not (Test-Path -LiteralPath $artifact.Path)) {
            throw "Missing artifact: $($artifact.Path)"
        }
        $hash = (Get-FileHash -LiteralPath $artifact.Path -Algorithm SHA256).Hash
        $artifactHashes[$artifact.Label] = $hash
        Write-Host "$($artifact.Label): $hash"
    }

    $checksumEncoding = [System.Text.UTF8Encoding]::new($false)
    $rootChecksumPath = Join-Path $projectRoot "CHECKSUMS.sha256"
    $desktopChecksumPath = Join-Path $projectRoot "desktop\dist\SHA256SUMS.txt"
    $rootChecksumLines = @(
        "$($artifactHashes['Windows portable ZIP'])  desktop/dist/$desktopArtifactName",
        "$($artifactHashes['Android debug APK'])  android/WritingEnhancer-debug.apk"
    )
    [System.IO.File]::WriteAllLines($rootChecksumPath, $rootChecksumLines, $checksumEncoding)
    [System.IO.File]::WriteAllLines(
        $desktopChecksumPath,
        @("$($artifactHashes['Windows portable ZIP'])  $desktopArtifactName"),
        $checksumEncoding
    )
    if ((Get-Content -Raw -Encoding UTF8 -LiteralPath $rootChecksumPath).TrimEnd() -ne
        ($rootChecksumLines -join [Environment]::NewLine)) {
        throw "Root checksum manifest did not round-trip."
    }
    $verificationSummary.Add("Artifact checksum manifests: regenerated from final files")

    $qaDirectory = Join-Path $projectRoot "desktop\qa"
    $qaImages = @(Get-ChildItem -LiteralPath $qaDirectory -Filter "v3-*.png" -File)
    if ($qaImages.Count -lt 10) {
        throw "Expected at least 10 Windows v3 QA captures, found $($qaImages.Count)."
    }
    foreach ($image in $qaImages) {
        if ($image.Length -le 0) {
            throw "Empty QA capture: $($image.FullName)"
        }
    }
    $verificationSummary.Add("Windows QA captures: $($qaImages.Count) non-empty PNG files")
    $sideChatQa = Join-Path $qaDirectory "v4-01-side-chat-beta.png"
    if (-not (Test-Path -LiteralPath $sideChatQa) -or
        (Get-Item -LiteralPath $sideChatQa).Length -le 0) {
        throw "Expected a non-empty Windows side chat beta QA capture."
    }
    $verificationSummary.Add("Windows side chat beta QA capture: passed")
    $firstFollowUpQa = Join-Path $qaDirectory "v4-02-first-follow-up.png"
    if (-not (Test-Path -LiteralPath $firstFollowUpQa) -or
        (Get-Item -LiteralPath $firstFollowUpQa).Length -le 0) {
        throw "Expected a non-empty Windows first follow-up QA capture."
    }
    $verificationSummary.Add("Windows first follow-up QA capture: passed")
    $sideChatEditQa = Join-Path $qaDirectory "v4-03-side-chat-edit.png"
    if (-not (Test-Path -LiteralPath $sideChatEditQa) -or
        (Get-Item -LiteralPath $sideChatEditQa).Length -le 0) {
        throw "Expected a non-empty Windows side chat edit QA capture."
    }
    $verificationSummary.Add("Windows side chat edit QA capture: passed")
    foreach ($name in @(
            "v5-01-side-chat-confirm.png",
            "v5-02-side-chat-progress.png",
            "v5-03-side-chat-source-dialog.png",
            "v5-04-side-chat-streaming.png"
        )) {
        $capture = Join-Path $qaDirectory $name
        if (-not (Test-Path -LiteralPath $capture) -or
            (Get-Item -LiteralPath $capture).Length -le 0) {
            throw "Expected a non-empty Windows QA capture: $name"
        }
    }
    $verificationSummary.Add("Windows side chat confirm, progress, source dialog, and streaming QA captures: passed")

    $androidSdk = if ($env:ANDROID_HOME) {
        $env:ANDROID_HOME
    } elseif ($env:ANDROID_SDK_ROOT) {
        $env:ANDROID_SDK_ROOT
    } else {
        Join-Path $env:LOCALAPPDATA "Android\Sdk"
    }
    $buildToolsRoot = Join-Path $androidSdk "build-tools"
    $apksigner = Get-ChildItem -LiteralPath $buildToolsRoot -Directory |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName "apksigner.bat" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $apksigner) {
        throw "Android apksigner.bat was not found."
    }
    $signatureOutput = @(
        & $apksigner verify --verbose (Join-Path $projectRoot "android\WritingEnhancer-debug.apk") 2>&1
    )
    $signatureOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "Android APK signature verification failed."
    }
    if (-not ($signatureOutput -match "Verified using v2 scheme .*: true")) {
        throw "Android APK is valid but APK Signature Scheme v2 was not verified."
    }
    $verificationSummary.Add("Android APK v2 signature: verified")

    Write-Host ""
    Write-Host "Verification summary"
    foreach ($line in $verificationSummary) {
        Write-Host " - $line"
    }
}
finally {
    while ((Get-Location).Path -ne $previousLocation.Path) {
        Pop-Location
    }
    $env:JAVA_HOME = $previousJavaHome
}
