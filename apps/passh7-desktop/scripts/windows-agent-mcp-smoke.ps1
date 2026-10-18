param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $ExecutablePath).Path
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $exe
$psi.Arguments = '--passh7-mcp'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$proc = [System.Diagnostics.Process]::Start($psi)
if ($null -eq $proc) { throw 'MCP child process did not start' }

function Invoke-McpRequest {
    param([object]$Request, [int]$DeadlineSeconds = 12)
    $payload = ConvertTo-Json -InputObject $Request -Compress -Depth 15
    $proc.StandardInput.WriteLine($payload)
    $proc.StandardInput.Flush()
    $task = $proc.StandardOutput.ReadLineAsync()
    if (-not $task.Wait([TimeSpan]::FromSeconds($DeadlineSeconds))) {
        throw "MCP stdio reply timed out after $DeadlineSeconds seconds for method $($Request.method)"
    }
    $line = $task.Result
    if ([string]::IsNullOrWhiteSpace($line)) {
        throw "MCP stdio closed before response for method $($Request.method)"
    }
    return ConvertFrom-Json -InputObject $line
}

try {
    $init = Invoke-McpRequest -Request @{
        jsonrpc = '2.0'
        id = 1
        method = 'initialize'
        params = @{
            protocolVersion = '2025-06-18'
            capabilities = @{}
            clientInfo = @{ name = 'passh7-windows-ci'; version = '1.0.0' }
        }
    }
    if ($init.id -ne 1 -or $init.result.protocolVersion -ne '2025-06-18') {
        throw "MCP initialize returned wrong response: $($init | ConvertTo-Json -Compress)"
    }
    if ($init.result.serverInfo.name -ne 'passh7-ssh') {
        throw 'MCP initialize identified an unexpected server'
    }

    $proc.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    $proc.StandardInput.Flush()

    $listed = Invoke-McpRequest -Request @{ jsonrpc = '2.0'; id = 2; method = 'tools/list' }
    if ($listed.id -ne 2) { throw 'MCP notification unexpectedly generated a response' }
    $names = @($listed.result.tools | ForEach-Object { $_.name } | Sort-Object)
    $expected = @('remote_exec', 'remote_list', 'remote_read', 'remote_write')
    if (($names -join ',') -ne ($expected -join ',')) {
        throw "Unexpected MCP tool list: $($names -join ',')"
    }

    $denied = Invoke-McpRequest -Request @{
        jsonrpc = '2.0'
        id = 3
        method = 'tools/call'
        params = @{ name = 'remote_exec'; arguments = @{ command = 'echo SHOULD_NOT_RUN' } }
    }
    if ($denied.id -ne 3 -or $denied.result.isError -ne $true) {
        throw 'Remote exec should fail without PaSSH7 bridge grant'
    }
    if (-not ($denied.result.content[0].text -match 'bridge|PaSSH7')) {
        throw 'Missing-action diagnostic does not explain the missing bridge'
    }

    Write-Host "PASS: Native Windows PE launched; stdio MCP initialize/list/notifications work; missing SSH grant fails closed."
}
finally {
    try { $proc.StandardInput.Close() } catch {}
    if (-not $proc.WaitForExit(5000)) {
        try { $proc.Kill() } catch {}
        [void]$proc.WaitForExit(5000)
    }
    $proc.Dispose()
}
