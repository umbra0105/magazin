/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din pachetul distribuit): rulează joburile punctelor de loialitate «ca peste
 * N zile», ca să verifici în browser acordarea, avertizarea și expirarea fără să aștepți. Nu mută ceasul nimănui și nu scrie
 * date inventate: cheamă exact funcțiile joburilor, cu ora curentă plus N zile.
 *
 *   npm run dev:loyalty -- --zile=15    # acordă punctele comenzilor livrate acum cel puțin (fereastra de retur) − 15 zile
 *   npm run dev:loyalty -- --zile=340   # pune în coadă și emailul de avertizare pentru loturile care expiră curând
 *
 * ⚠️ Scrie în baza de dezvoltare: cu un număr mare de zile, loturile ajunse la termen EXPIRĂ de-a binelea. Refuză producția.
 */
import { expireDuePoints, sendExpiryWarnings } from "../src/loyalty/loyalty-jobs";
import { readLoyaltySettings } from "../src/loyalty/loyalty-settings";
import { grantDuePoints } from "../src/loyalty/order-loyalty";
import { LOYALTY_PORTS } from "../src/orders/order-service";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  console.error("Refuz: scriptul de dezvoltare pentru puncte nu rulează în producție.");
  process.exit(1);
}

const argument = process.argv.slice(2).find((value) => value.startsWith("--zile="));
const days = argument ? Number(argument.slice("--zile=".length)) : 0;
if (!Number.isInteger(days) || days < 0 || days > 3_650) {
  console.error("Folosire: npm run dev:loyalty -- --zile=<număr întreg între 0 și 3650>");
  process.exit(1);
}

const db = getDb();
try {
  if (!(await readLoyaltySettings(db)).active) {
    console.log(
      "Programul de loialitate e oprit (flag-ul «loyalty» sau setarea «enabled»): nu rulează nimic.",
    );
  } else {
    const now = new Date(Date.now() + days * 86_400_000);
    console.log(`Rulez joburile punctelor ca la data ${now.toISOString().slice(0, 10)}:`);
    const granted = await grantDuePoints(db, { now, ports: LOYALTY_PORTS });
    console.log(`  acordare:    ${granted.granted} comenzi, ${granted.points} puncte`);
    const warned = await sendExpiryWarnings(db, { now });
    console.log(`  avertizare:  ${warned.queued} emailuri puse în coadă (le trimite workerul)`);
    const expired = await expireDuePoints(db, { now });
    console.log(`  expirare:    ${expired.lots} loturi, ${expired.points} puncte`);
  }
} finally {
  await db.$disconnect();
}
