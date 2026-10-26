<#
.SYNOPSIS
  Verificare MANUALĂ (în afara CI): cum deschide Excel un fișier CSV, citind celulele după deschidere.

.DESCRIPTION
  De ce există: testele de octeți nu pot arăta ce face Excel cu ei. Linia «sep=» făcea Excel să ignore BOM-ul
  UTF-8 (diacriticele ieșeau «AdresÄƒ»), deși octeții erau corecți. Formatul aplicației (UTF-16LE cu BOM FF FE,
  TAB, fără «sep=») a fost ales cu acest script, vezi comentariul din packages/core/src/catalog/import/import-csv.ts.

  Fără parametri: scrie într-un director temporar variantele de format (V0 = formatul vechi, V4 = formatul
  curent etc.), le deschide în Excel și arată, pentru fiecare, numărul de coloane și dacă «Adresă (slug)» /
  «Preț (lei)» au ieșit cu diacriticele corecte. Cu -Path: deschide fișierele date (de exemplu un export
  descărcat din aplicație) și arată primele două rânduri, cu caracterele non-ASCII scrise ca \uXXXX.

  Siguranță: NU modifică setările Windows sau Excel; nu atinge fișierele tale (lucrează pe copii temporare
  sau doar citește fișierele din -Path, închise fără salvare); refuză să ruleze dacă există deja un proces
  Excel (nu afectează instanțele deschise de tine); pornește o instanță proprie, ascunsă, și oprește doar
  acel proces.

.EXAMPLE
  powershell -File scripts\excel-csv-probe.ps1
  powershell -File scripts\excel-csv-probe.ps1 -Path C:\Users\eu\Downloads\export-produse-2026-10-26.csv
#>
param([string[]]$Path = @())

$ErrorActionPreference = 'Stop'
$rows = 2

function Get-EscapedText([string]$text) {
  ($text.ToCharArray() | ForEach-Object { if ([int]$_ -gt 126 -or [int]$_ -lt 32) { '\u{0:X4}' -f [int]$_ } else { [string]$_ } }) -join ''
}

$existing = @(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object Id)
if ($existing.Count -gt 0) {
  throw "Rulează deja Excel (PID $($existing -join ', ')). Nu pornesc și nu automatizez nimic cât timp ai Excel deschis; închide-l și rulează din nou."
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("excel-csv-probe-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

$xl = $null
$mine = @()
try {
  $xl = New-Object -ComObject Excel.Application
  $mine = @(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object Id)
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  "Excel $($xl.Version) build $($xl.Build); separator de listă al Excel: '$($xl.International(5))'; zecimal: '$($xl.International(3))'"

  if ($Path.Count -gt 0) {
    foreach ($p in $Path) {
      $full = (Resolve-Path -LiteralPath $p).Path
      $copy = Join-Path $work ([System.IO.Path]::GetFileName($full))
      Copy-Item -LiteralPath $full -Destination $copy
      $wb = $xl.Workbooks.Open($copy)
      try {
        $ws = $wb.Worksheets.Item(1)
        $cols = $ws.UsedRange.Columns.Count
        "`n$full`n  coloane: $cols"
        for ($r = 1; $r -le $rows; $r++) {
          $cells = 1..([Math]::Min($cols, 8)) | ForEach-Object { Get-EscapedText ([string]$ws.Cells.Item($r, $_).Value2) }
          "  rândul ${r}: " + ($cells -join ' | ')
        }
        $all = (1..([Math]::Min($cols, 40)) | ForEach-Object { [string]$ws.Cells.Item(1, $_).Value2 }) -join ''
        if ($all -match "[\u00C3\u00C4\u00C8\u00C5]") { "  ATENȚIE: antetul conține Ã/Ä/È/Å: diacriticele par citite greșit (UTF-8 citit ca Windows-1252)" }
        elseif ($cols -le 1) { "  ATENȚIE: o singură coloană: delimitatorul nu a fost recunoscut" }
        else { "  OK: coloane separate, fără semne de diacritice stricate în antet" }
      } finally { $wb.Close($false) }
    }
    return
  }

  # Matricea de variante (diacritice și coloane), pe un tabel mic cu «Adresă (slug)», «Preț (lei)», «Șurub»
  $a = "Adres$([char]0x103) (slug)"
  $pr = "Pre$([char]0x21B) (lei)"
  $s = "$([char]0x218)urub"
  $t = "$([char]0x21A)eav$([char]0x103)"
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $utf16 = [System.Text.UnicodeEncoding]::new($false, $false)
  $bom8 = [byte[]](0xEF, 0xBB, 0xBF)
  $bom16 = [byte[]](0xFF, 0xFE)
  $crlf = "`r`n"
  function Table($d) { "$a$d$pr$d$s$crlf" + "a-1${d}19.99$d$t$crlf" }

  $variants = [ordered]@{
    'V0 UTF-8 BOM + sep=; + ;  (formatul VECHI)' = $bom8 + $utf8.GetBytes("sep=;$crlf" + (Table ';'))
    'V1 UTF-8 BOM + ; fără sep'                  = $bom8 + $utf8.GetBytes((Table ';'))
    'V2 UTF-8 BOM + , fără sep'                  = $bom8 + $utf8.GetBytes((Table ','))
    'V3 UTF-8 BOM + sep=, + ,'                   = $bom8 + $utf8.GetBytes("sep=,$crlf" + (Table ','))
    'V4 UTF-16LE BOM + TAB  (formatul CURENT)'   = $bom16 + $utf16.GetBytes((Table "`t"))
    'V5 UTF-16LE BOM + sep=; + ;'                = $bom16 + $utf16.GetBytes("sep=;$crlf" + (Table ';'))
    'V6 UTF-8 fără BOM + sep=; + ;'              = $utf8.GetBytes("sep=;$crlf" + (Table ';'))
    'V7 UTF-8 BOM + TAB fără sep'                = $bom8 + $utf8.GetBytes((Table "`t"))
  }
  $n = 0
  foreach ($name in $variants.Keys) {
    $n++
    $file = Join-Path $work "v$n.csv"
    [System.IO.File]::WriteAllBytes($file, $variants[$name])
    $wb = $xl.Workbooks.Open($file)
    try {
      $ws = $wb.Worksheets.Item(1)
      $cols = $ws.UsedRange.Columns.Count
      $a1 = [string]$ws.Cells.Item(1, 1).Value2
      $b1 = [string]$ws.Cells.Item(1, 2).Value2
      $ok = ($a1 -eq $a) -and ($b1 -eq $pr)
      $verdict = if ($ok -and $cols -eq 3) { 'MERGE (diacritice corecte, 3 coloane)' } elseif ($ok) { "diacritice corecte, dar $cols coloană/coloane" } else { "diacritice STRICATE ($cols coloane)" }
      "{0,-46} {1}" -f $name, $verdict
    } finally { $wb.Close($false) }
  }
  "`nCe contează pentru aplicație: V4 trebuie să iasă «MERGE». Dacă nu, formatul din import-csv.ts nu mai merge în Excelul de pe acest PC."
}
finally {
  if ($xl) { $xl.Quit(); [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
  # Quit e asincron: aștept până la 10 s ca PROPRIA instanță să se închidă, apoi o opresc (doar după PID)
  $deadline = (Get-Date).AddSeconds(10)
  foreach ($id in $mine) {
    while ((Get-Process -Id $id -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force }
  }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
