# Prints the installed WebView2 Evergreen runtime version; exits 1 (loudly) if there is none.
$k = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv
if (-not $v) { [Console]::Error.WriteLine('FAIL: no WebView2 runtime is installed'); exit 1 }
Write-Output $v
