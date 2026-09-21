$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $workspaceRoot '.integration.local/runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'jdk'))) {
  $asset = Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows'
  $package = $asset[0].binary.package
  $archive = Join-Path $runtimeRoot 'jdk.zip'
  Invoke-WebRequest $package.link -OutFile $archive
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.checksum) { throw 'JDK checksum mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $runtimeRoot 'jdk')
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'dynamodb/DynamoDBLocal.jar'))) {
  $base = 'https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip'
  $archive = Join-Path $runtimeRoot 'dynamodb.zip'
  Invoke-WebRequest $base -OutFile $archive
  $expected = ((Invoke-WebRequest ($base + '.sha256')).Content.Trim() -split '\s+')[0]
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) { throw 'DynamoDB Local checksum mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $runtimeRoot 'dynamodb')
}
npm install --prefix (Join-Path $workspaceRoot '.integration.local/storage') s3rver@3.7.1 --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Local S3 dependency install failed' }
Write-Output 'Local dependencies are ready. Build the Office engine, then run npm run dev:office:local with your process-only provider settings.'
