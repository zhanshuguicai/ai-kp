$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath 'node_modules')) {
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
node --env-file-if-exists=.env dist/src/server.js
