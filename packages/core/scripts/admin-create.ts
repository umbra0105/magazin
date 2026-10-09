/**
 * Creează contul de administrator (Owner): `pnpm admin:create` — se rulează de către om, într-un
 * terminal interactiv. Emailul și numele se tastează; parola se tastează de două ori, FĂRĂ echo.
 * Nu există nicio cale de a da parola prin argumente, variabile de mediu, pipe sau fișier, și nu
 * există parolă implicită. Emailul e marcat verificat. Refuză dacă există deja un Owner
 * (`--force` pentru un al doilea Owner). Nu afișează și nu loghează parola.
 */
import {
  NotInteractiveError,
  PromptCancelledError,
  promptHidden,
  promptLine,
} from "../src/cli/prompt";
import {
  createOwnerAccount,
  createOwnerSchema,
  loadMinPasswordLength,
  ownerExists,
} from "../src/auth/create-admin";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const force = process.argv.includes("--force");
const unknownArgs = process.argv.slice(2).filter((a) => a !== "--force");
if (unknownArgs.length > 0) {
  console.error("Folosire: pnpm admin:create [--force]");
  console.error("Emailul, numele și parola se cer interactiv; nu se dau ca argumente.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error(new NotInteractiveError().message);
  process.exit(1);
}

const db = getDb();

async function askPassword(minLength: number): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const password = await promptHidden("Parolă (nu se afișează): ");
    const check = createOwnerSchema(minLength).shape.password.safeParse(password);
    if (!check.success) {
      console.error(check.error.issues.map((i) => i.message).join("; "));
      continue;
    }
    const again = await promptHidden("Repetă parola: ");
    if (again === password) return password;
    console.error("Parolele nu coincid. Încearcă din nou.");
  }
  throw new Error("Prea multe încercări nereușite.");
}

try {
  if (!force && (await ownerExists(db))) {
    console.error("Există deja un cont Owner. Pentru un al doilea Owner rulează cu --force.");
    process.exitCode = 1;
  } else {
    const minLength = await loadMinPasswordLength(db);
    const email = await promptLine("Email administrator: ");
    const name = await promptLine("Nume afișat: ");
    const password = await askPassword(minLength);

    const created = await db.$transaction((tx) =>
      createOwnerAccount(tx, { email, name, password }, { allowAnotherOwner: force }),
    );
    console.log(`\nCont creat: ${created.email} (rol Owner, email marcat verificat).`);
    console.log(
      "Te poți autentifica la /autentificare. Parola nu a fost salvată nicăieri în clar.",
    );
  }
} catch (error) {
  if (error instanceof PromptCancelledError) {
    console.error("\nAnulat. Nu s-a creat nimic.");
  } else {
    // Mesajele erorilor de domeniu și de validare nu conțin parola.
    console.error(error instanceof Error ? error.message : "Eroare necunoscută.");
  }
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
