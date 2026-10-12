/**
 * Tema emailurilor. Clienții de email nu suportă CSS variables, deci culorile din `Branding` se
 * rezolvă în valori `#rrggbb` la momentul trimiterii și se pun ca stiluri inline. Fără culori
 * hardcodate în șabloane: tot ce e vizual vine din acest obiect.
 */
export interface EmailTheme {
  storeName: string;
  /** URL absolut al logo-ului, sau `null` (se afișează doar numele magazinului). */
  logoUrl: string | null;
  colors: {
    bg: string;
    fg: string;
    muted: string;
    border: string;
    primary: string;
    primaryFg: string;
  };
  /** Stivă de fonturi sigură pentru email (fonturile web nu se încarcă în majoritatea clienților). */
  fontFamily: string;
  /** Raza colțurilor în px (rezolvată din tokenul `radius`). */
  radiusPx: number;
}
