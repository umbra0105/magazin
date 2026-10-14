// Măsoară memoria (RSS) a unui proces ținut sub observație, la interval, ca să vedem dacă serverul de
// test (`next dev`) crește monoton pe parcursul unei suite E2E. NU atinge aplicația și NU oprește
// nimic: doar citește. Se dă explicit PID-ul (al unui proces pornit de noi), niciodată după nume.
//
//   node scripts/measure-rss.mjs <pid> [interval-secunde=5] [fișier-ieșire.csv]
//
// Include și procesele-copil (pe Windows, `next dev` rulează în copii). Se oprește singur când
// procesul observat dispare. Sub Windows folosește `Get-CimInstance`; sub Linux/macOS, `ps`.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { clearInterval, setInterval } from "node:timers";

const pid = Number(process.argv[2]);
const everySec = Number(process.argv[3] ?? 5);
const out = process.argv[4];
if (!Number.isInteger(pid) || pid <= 0 || !(everySec > 0)) {
  console.error("Folosire: node scripts/measure-rss.mjs <pid> [interval-secunde] [fișier.csv]");
  process.exit(2);
}

// Windows: procesele arborelui, cu memoria lor (MB), ca suma să nu ascundă un singur proces uriaș.
function breakdown(root) {
  if (process.platform !== "win32") return "";
  const ps = `$all=Get-CimInstance Win32_Process|Select ProcessId,ParentProcessId,Name,WorkingSetSize;
$ids=@(${root});$i=0;while($i -lt $ids.Count){$p=$ids[$i];$all|?{$_.ParentProcessId -eq $p -and $ids -notcontains $_.ProcessId}|%{$ids+=$_.ProcessId};$i++}
$all|?{$ids -contains $_.ProcessId}|sort WorkingSetSize -desc|%{"$($_.ProcessId) $($_.Name) $([int]($_.WorkingSetSize/1MB))"}`;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
  }).trim();
}

function treeRssBytes(root) {
  if (process.platform === "win32") {
    const ps = `$all=Get-CimInstance Win32_Process|Select ProcessId,ParentProcessId,WorkingSetSize;
$ids=@(${root});$i=0;while($i -lt $ids.Count){$p=$ids[$i];$all|?{$_.ParentProcessId -eq $p -and $ids -notcontains $_.ProcessId}|%{$ids+=$_.ProcessId};$i++}
($all|?{$ids -contains $_.ProcessId}|Measure-Object WorkingSetSize -Sum).Sum`;
    const text = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      encoding: "utf8",
    }).trim();
    return text === "" ? 0 : Number(text);
  }
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 3 && r.every(Number.isFinite));
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, pp] of rows) {
      if (ids.has(pp) && !ids.has(p)) {
        ids.add(p);
        grew = true;
      }
    }
  }
  return rows.filter(([p]) => ids.has(p)).reduce((s, [, , kb]) => s + kb * 1024, 0);
}

if (out) writeFileSync(out, "t_seconds,rss_mb\n");
const started = Date.now();
let peak = 0;
let first = null;
let last = 0;
const timer = setInterval(() => {
  let bytes;
  try {
    bytes = treeRssBytes(pid);
  } catch {
    bytes = 0;
  }
  if (bytes === 0) {
    clearInterval(timer);
    console.log(
      `[rss] proces încheiat. început ${first?.toFixed(0) ?? "?"} MB · vârf ${peak.toFixed(0)} MB · final ${last.toFixed(0)} MB`,
    );
    return;
  }
  const mb = bytes / 1024 / 1024;
  first ??= mb;
  peak = Math.max(peak, mb);
  last = mb;
  const t = Math.round((Date.now() - started) / 1000);
  if (out) {
    appendFileSync(out, `${t},${mb.toFixed(1)}\n`);
    try {
      appendFileSync(`${out}.procs`, `# t=${t}s\n${breakdown(pid)}\n`);
    } catch {
      // doar informativ
    }
  } else console.log(`[rss] t=${t}s ${mb.toFixed(0)} MB`);
}, everySec * 1000);
