import { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";

/**
 * Numărul comenzii: prefix setabil (`checkout.orderNumberPrefix`) + CONTOR dintr-un tabel (`order_counter`), blocat în aceeași
 * tranzacție cu plasarea. NU o secvență Postgres: secvențele sar valori la rollback, iar numerele comenzilor trebuie să fie fără
 * goluri (contabilitate). Rândul contorului se blochează la `UPDATE`, deci plasările concurente se serializează pe el; dacă
 * tranzacția eșuează, incrementarea se anulează odată cu ea și numărul nu se pierde.
 */

const PREFIX = /^[A-Za-z0-9-]{0,10}$/;

export function formatOrderNumber(prefix: string, value: number, digits: number): string {
  if (!PREFIX.test(prefix)) throw new RangeError("Prefixul numărului de comandă nu este valid");
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("Valoarea contorului trebuie să fie un întreg pozitiv");
  }
  if (!Number.isInteger(digits) || digits < 1 || digits > 12) {
    throw new RangeError("Numărul de cifre trebuie să fie între 1 și 12");
  }
  return `${prefix}${String(value).padStart(digits, "0")}`;
}

/** Alocă următorul număr, în tranzacția dată. Rândul contorului rămâne blocat până la commit sau rollback. */
export async function allocateOrderNumber(
  tx: Db,
  settings: { prefix: string; digits: number },
): Promise<string> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO order_counter (id, "lastValue", "updatedAt") VALUES ('order', 0, now())
    ON CONFLICT (id) DO NOTHING`);
  const [row] = await tx.$queryRaw<Array<{ lastValue: number }>>(Prisma.sql`
    UPDATE order_counter SET "lastValue" = "lastValue" + 1, "updatedAt" = now()
    WHERE id = 'order' RETURNING "lastValue"`);
  if (!row) throw new Error("Contorul numerelor de comandă nu a putut fi incrementat");
  return formatOrderNumber(settings.prefix, row.lastValue, settings.digits);
}
