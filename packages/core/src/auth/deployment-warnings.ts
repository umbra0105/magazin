/**
 * Avertismente de configurare scrise la pornirea aplicației (Blocul C, C-02).
 *
 * `auth.trustedProxyHops = 0` (valoarea implicită) înseamnă „niciun proxy de încredere”: aplicația ignoră `X-Forwarded-For`
 * (altfel orice client și-ar alege singur adresa și ar ocoli limitele), deci nu vede adresa IP a clientului. Consecințele în
 * producție: limitele pe adresă (înregistrare, resetare, retrimitere, autentificare) devin plafoane GLOBALE, iar blocările de
 * autentificare se aplică tuturor clienților unui email. Instalarea trebuie să seteze numărul real de proxy-uri și să se asigure
 * că aplicația nu e accesibilă direct, fără proxy.
 */

export function proxyHopsWarning(input: {
  isProduction: boolean;
  trustedProxyHops: number;
}): string | null {
  if (!input.isProduction || input.trustedProxyHops > 0) return null;
  return [
    "Producție cu auth.trustedProxyHops = 0: aplicația nu vede adresa IP a clientului (X-Forwarded-For e ignorat).",
    "Limitele pe adresă (înregistrare, resetare a parolei, retrimitere a verificării, autentificare) funcționează doar ca plafoane globale,",
    "iar blocările de autentificare se aplică tuturor clienților unui email.",
    "Setează în auth.trustedProxyHops numărul de proxy-uri de încredere din fața aplicației (de ex. 1 pentru un singur reverse proxy);",
    "aplicația NU trebuie să fie accesibilă direct, fără proxy, altfel clientul își poate alege singur adresa.",
  ].join(" ");
}
