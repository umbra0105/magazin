/**
 * Test manual al terminalului: `pnpm cli:tty-test`. Verifică, fără să atingă baza de date sau
 * conturi, că tastele ajung la procesul CLI și că nu se afișează (aceeași citire ca la parolă).
 * Afișează doar NUMĂRUL de caractere primite, niciodată caracterele.
 */
import { NotInteractiveError, PromptCancelledError, promptHidden } from "../src/cli/prompt";

if (!process.stdin.isTTY) {
  console.error(new NotInteractiveError().message);
  process.exit(1);
}

try {
  const typed = await promptHidden(
    "Tastează 5 caractere, apoi Enter (nu trebuie să se vadă nimic): ",
  );
  console.log(`Am primit ${Array.from(typed).length} caractere.`);
  console.log(
    Array.from(typed).length === 5
      ? "OK: tastele ajung la proces și nu au fost afișate."
      : "ATENȚIE: ai tastat altă lungime decât 5; dacă ai tastat exact 5, tastele nu ajung corect.",
  );
} catch (error) {
  if (error instanceof PromptCancelledError) {
    console.error("Anulat.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
