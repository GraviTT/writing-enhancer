# Copies this PC's Android debug signing keystore (the key that signed the installed app)
# to the clipboard as base64, for the GitHub secret ANDROID_SIGNING_KEYSTORE_BASE64.
# The key itself is never written to the repository.
$ErrorActionPreference = 'Stop'
$keystore = Join-Path $env:USERPROFILE '.android\debug.keystore'
if (-not (Test-Path -LiteralPath $keystore)) {
    throw "Keystore not found: $keystore"
}
$encoded = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore))
Set-Clipboard -Value $encoded
Write-Host ''
Write-Host 'Copied the signing key to the clipboard.'
Write-Host 'GitHub repository > Settings > Secrets and variables > Actions > New repository secret'
Write-Host '  Name:   ANDROID_SIGNING_KEYSTORE_BASE64'
Write-Host '  Secret: paste (Ctrl+V)'
Write-Host ''
Write-Host 'Clear the clipboard afterwards (copy any other text).'
