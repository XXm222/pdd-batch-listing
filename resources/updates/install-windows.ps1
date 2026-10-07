$ErrorActionPreference = 'Stop'
$requestFile = $env:GOODS_UPDATE_REQUEST
$request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$directory = Split-Path -Parent $requestFile
$result = Join-Path $directory 'install-result.json'
try {
    $deadline = (Get-Date).AddSeconds(60)
    while (Get-Process -Id $request.pid -ErrorAction SilentlyContinue) {
        if ((Get-Date) -gt $deadline) { throw 'App did not exit' }
        Start-Sleep -Milliseconds 250
    }
    $hash = (Get-FileHash -LiteralPath $request.file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $request.sha256) { throw 'Installer changed' }
    # A bundled bridge may outlive the App. Keep it running while moving its mapped
    # executable outside the install folder, then leave an unlocked identical copy.
    # Only this App's bridge binary is considered; shared services are never stopped.
    $appDirectory = Split-Path -Parent $request.exe
    $runtimePrefix = Join-Path $appDirectory 'resources\app.asar.unpacked\resources\bridge-runtime\'
    $bridges = Get-CimInstance Win32_Process -Filter "Name='kimi-webbridge.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)
    }
    foreach ($bridge in $bridges) {
        $cache = Join-Path (Split-Path -Parent $appDirectory) '.goods-runtime-cache'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        $moved = Join-Path $cache ($request.token + '-' + $bridge.ProcessId + '.exe')
        Move-Item -LiteralPath $bridge.ExecutablePath -Destination $moved
        Copy-Item -LiteralPath $moved -Destination $bridge.ExecutablePath
    }
    # /D must be last. NSIS treats the entire remaining argument as the install directory.
    $arguments = '/S --updated --force-run /D=' + (Split-Path -Parent $request.exe)
    $installer = Start-Process -FilePath $request.file -ArgumentList $arguments -PassThru -Wait
    if ($installer.ExitCode -ne 0) { throw 'Installer failed' }
    $ready = Join-Path $directory ($request.token + '.ready')
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path -LiteralPath $ready)) {
        if ((Get-Date) -gt $deadline) { throw 'New App did not become ready' }
        Start-Sleep -Milliseconds 500
    }
    '{"status":"success"}' | Set-Content -LiteralPath $result -Encoding UTF8
} catch {
    '{"status":"error","message":"Windows automatic update did not finish. Please reopen the App or use the verified installer."}' | Set-Content -LiteralPath $result -Encoding UTF8
    if (Test-Path -LiteralPath $request.exe) {
        Start-Process -FilePath $request.exe
    }
    exit 1
}
