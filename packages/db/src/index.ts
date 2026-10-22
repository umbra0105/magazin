import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export { Prisma, PrismaClient } from "../generated/prisma/client";
export type * from "../generated/prisma/client";

type DbClient = PrismaClient;

const globalForDb = globalThis as unknown as { __ecomDb?: DbClient };

/** Un singur PrismaClient per proces (reutilizat la hot reload în dev). */
export function getDb(): DbClient {
  if (!globalForDb.__ecomDb) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) {
      throw new Error("DATABASE_URL lipsește: nu pot crea conexiunea la baza de date");
    }
    globalForDb.__ecomDb = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return globalForDb.__ecomDb;
}

/**
 * Un client SEPARAT de cel din proces, cu pool-ul de dimensiunea cerută (testele de concurență au nevoie de multe
 * conexiuni deschise deodată; scripturile de operare, de un pool propriu). Apelantul îl închide cu `$disconnect()`.
 */
export function createDbClient(options: { max?: number } = {}): DbClient {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL lipsește: nu pot crea conexiunea la baza de date");
  }
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      ...(options.max !== undefined && { max: options.max }),
    }),
  });
}
