/**
 * Codare Windows-1250 pentru teste: ce salvează Excel în limba română la «CSV (delimitat prin virgulă)».
 * Windows-1250 nu are literele cu virgulă dedesubt (ș, ț: U+0219, U+021B), ci doar pe cele cu sedilă
 * (ş, ţ: U+015F, U+0163), pe care Excel le scrie în locul lor; ambele variante se codează la fel.
 */

// punct de cod Unicode → octet Windows-1250
const CP1250 = new Map<number, number>([
  [0x103, 0xe3], // ă
  [0xe2, 0xe2], // â
  [0xee, 0xee], // î
  [0x219, 0xba], // ș (virgulă) → ş
  [0x15f, 0xba], // ş (sedilă)
  [0x21b, 0xfe], // ț (virgulă) → ţ
  [0x163, 0xfe], // ţ (sedilă)
  [0x102, 0xc3], // Ă
  [0xc2, 0xc2], // Â
  [0xce, 0xce], // Î
  [0x218, 0xaa], // Ș (virgulă) → Ş
  [0x15e, 0xaa], // Ş (sedilă)
  [0x21a, 0xde], // Ț (virgulă) → Ţ
  [0x162, 0xde], // Ţ (sedilă)
]);

export function encodeWindows1250(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const mapped = CP1250.get(code);
    if (mapped === undefined) {
      throw new Error(`caracter fără corespondent în Windows-1250: U+${code.toString(16)}`);
    }
    out.push(mapped);
  }
  return new Uint8Array(out);
}
