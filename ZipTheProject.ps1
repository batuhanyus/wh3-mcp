$timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$filename = "WarhammerAndTaxes-share-$timestamp.zip"

& git archive --format=zip "--output=$filename" HEAD
if ($LASTEXITCODE -ne 0) {
    throw "git archive failed with exit code $LASTEXITCODE."
}

Write-Output "Created: $filename"
