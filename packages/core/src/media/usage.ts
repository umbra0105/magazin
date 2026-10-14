/**
 * Unde e folosit un fișier media. Biblioteca nu știe nimic despre produse, pagini sau bannere:
 * fiecare modul care referă fișiere media își înregistrează un `MediaUsageProvider`, iar ștergerea
 * unui fișier se refuză dacă oricare provider îl raportează ca folosit (Faza 4: produse; Faza 16:
 * pagini, bannere, blog).
 */
export interface MediaUsage {
  /** Tipul locului (ex. `product`, `page`, `banner`): cheie stabilă, nu text afișat. */
  kind: string;
  /** Eticheta de afișat (ex. numele produsului). Fără date sensibile. */
  label: string;
  /** Link spre locul respectiv din admin, dacă există. */
  href?: string;
}

export interface MediaUsageProvider {
  /** Nume stabil, pentru loguri și teste. */
  readonly name: string;
  /** Pentru fiecare id din listă, locurile unde e folosit (id-urile nefolosite pot lipsi). */
  findUsages(mediaIds: readonly string[]): Promise<Map<string, MediaUsage[]>>;
}

export class MediaUsageRegistry {
  private readonly providers = new Map<string, MediaUsageProvider>();

  /** Înregistrare idempotentă pe `name` (un hot reload nu dublează providerul). */
  register(provider: MediaUsageProvider): void {
    this.providers.set(provider.name, provider);
  }

  get size(): number {
    return this.providers.size;
  }

  /** Numele providerilor înregistrați (pentru teste și diagnostic). */
  get names(): string[] {
    return [...this.providers.keys()].sort();
  }

  /** Locurile unde e folosit fiecare fișier, de la toți providerii. */
  async findUsages(mediaIds: readonly string[]): Promise<Map<string, MediaUsage[]>> {
    const out = new Map<string, MediaUsage[]>();
    if (mediaIds.length === 0) return out;
    // Providerii se interoghează în paralel; un provider căzut face ștergerea să EȘUEZE (fail-closed):
    // mai bine un fișier nesters decât unul șters dintr-un produs.
    const results = await Promise.all(
      [...this.providers.values()].map((p) => p.findUsages(mediaIds)),
    );
    for (const result of results) {
      for (const [id, usages] of result) {
        if (usages.length === 0) continue;
        out.set(id, [...(out.get(id) ?? []), ...usages]);
      }
    }
    return out;
  }
}
