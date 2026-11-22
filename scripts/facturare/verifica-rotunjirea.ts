/**
 * Verificarea rotunjirii în contul SmartBill (Faza 13, pasul separat al utilizatorului; decizia 2026-11-22).
 *
 * ACEST SCRIPT NU RULEAZĂ NICIODATĂ SINGUR (nici în teste, nici în CI, nici din Claude Code). Îl pornește omul, într-un cont SmartBill
 * DE TEST sau de probă, după ce a introdus cheile în admin (Setări → Facturare, mod «test»). Ghidul pas cu pas, pentru cineva fără
 * cunoștințe de programare: `docs/FACTURARE-VERIFICARE-ROTUNJIRE.md`.
 *
 * Ce face, când e pornit cu `--confirm-cont-de-test`: emite în contul de test cele 3 comenzi de probă cu linii zecimale (aceleași
 * calcule ca în magazin: motorul de prețuri, o rotunjire pe linie, TVA din brutul liniei), citește de la SmartBill totalul fiecărei
 * facturi, descarcă PDF-ul și scrie un raport clar: «identic» sau «diferență de N bani». Fără steag (implicit) doar AFIȘEAZĂ planul și
 * cifrele așteptate, fără să contacteze SmartBill. Cheile se citesc din setările salvate (criptate) și nu se afișează niciodată.
 *
 * API-ul SmartBill nu dă înapoi TVA-ul pe linii, deci comparația pe linii și a TVA-ului se face de om, cu PDF-urile salvate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "../../packages/config/src";
import {
  InvoicingConfigService,
  PROBE_SCENARIOS,
  buildProbe,
  readDemoGuardEnv,
  renderProbeReport,
  type ProbeResult,
} from "../../packages/core/src";
import { getDb } from "../../packages/db/src";
import type { InvoiceRequest } from "../../packages/shared/src";

try {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
} catch {
  // fără .env: variabilele vin din mediu
}

const CONFIRM = process.argv.includes("--confirm-cont-de-test");

const CLIENT: InvoiceRequest["client"] = {
  name: "CLIENT DE PROBA ROTUNJIRE (nu este un client real)",
  vatCode: null,
  isTaxPayer: false,
  regCom: null,
  address: "Strada Probei 1",
  city: "Alba Iulia",
  county: "Alba",
  country: "Romania",
  email: null,
  phone: null,
};

async function main(): Promise<number> {
  const plan = PROBE_SCENARIOS.map(buildProbe);
  console.log("Verificarea rotunjirii în SmartBill: 3 comenzi de probă\n");
  for (const probe of plan) {
    console.log(`Comanda ${probe.scenario.id}: ${probe.scenario.title}`);
    console.log(
      `  total așteptat ${(probe.totalMinor / 100).toFixed(2)} lei, TVA așteptat ${(probe.taxMinor / 100).toFixed(2)} lei`,
    );
  }
  if (!CONFIRM) {
    console.log(
      "\nAceasta a fost doar o AFIȘARE a planului: nu s-a contactat SmartBill și nu s-a emis nimic.\nPentru a emite cele 3 facturi de probă în contul de TEST, rulează din nou cu --confirm-cont-de-test",
    );
    return 0;
  }

  const env = loadEnv();
  const config = new InvoicingConfigService({
    db: getDb(),
    appKey: env.APP_KEY,
    env: readDemoGuardEnv(),
  });
  const state = await config.state("smartbill");
  if (!state.configured) {
    console.error("SmartBill nu e configurat complet în Setări → Facturare. Nu s-a emis nimic.");
    return 2;
  }
  if (state.mode !== "test") {
    console.error(
      "SmartBill e în modul LIVE: verificarea se face DOAR în modul «test», într-un cont de test. Nu s-a emis nimic.",
    );
    return 2;
  }
  const provider = await config.provider("smartbill");
  if (!provider) {
    console.error("Furnizorul SmartBill nu poate fi folosit (date incomplete). Nu s-a emis nimic.");
    return 2;
  }
  const connection = await provider.testConnection();
  console.log(`\nConexiune: ${connection.message}`);
  if (!connection.ok) return 2;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(process.cwd(), "local-data", "verificare-rotunjire", stamp);
  mkdirSync(dir, { recursive: true });

  const results: ProbeResult[] = [];
  for (const probe of plan) {
    try {
      const doc = await provider.issueInvoice({
        orderNumber: `PROBA-ROTUNJIRE-${probe.scenario.id}`,
        client: CLIENT,
        lines: probe.docLines,
        currency: "RON",
        issueDate: new Date(),
        useStock: false,
        payment: null,
        fromProforma: null,
        sendEmail: false,
      });
      let pdfPath: string | null = null;
      try {
        const pdf = await provider.getInvoicePdf({ series: doc.series, number: doc.number });
        pdfPath = join(dir, `comanda-${probe.scenario.id}-${doc.series}${doc.number}.pdf`);
        writeFileSync(pdfPath, pdf.bytes);
      } catch {
        pdfPath = null;
      }
      results.push({
        expectation: probe,
        document: { series: doc.series, number: doc.number },
        providerTotalMinor: doc.totalMinor,
        pdfPath,
        error: null,
      });
    } catch (error) {
      // mesajul adaptorului nu conține corpul cererii sau date personale
      results.push({
        expectation: probe,
        document: null,
        providerTotalMinor: null,
        pdfPath: null,
        error: error instanceof Error ? error.message : "eroare necunoscută",
      });
    }
  }

  const report = renderProbeReport(results);
  const reportPath = join(dir, "raport.txt");
  writeFileSync(reportPath, report.text, "utf8");
  console.log(`\n${report.text}\n\nRaportul și PDF-urile sunt în: ${dir}`);
  return report.allIdentical ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      "Verificarea s-a oprit:",
      error instanceof Error ? error.message : "eroare necunoscută",
    );
    process.exit(2);
  });
