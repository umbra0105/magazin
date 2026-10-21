import { loadEnv } from "@ecom/config";
import { proxyHopsWarning } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { getSettings } from "./services";

/**
 * Verificări de configurare la pornirea aplicației (runtime Node). Doar avertismente, niciodată o oprire: o bază de date
 * indisponibilă la pornire nu trebuie să împiedice aplicația să pornească. Vezi `proxyHopsWarning` (Blocul C, C-02).
 */
export async function runStartupChecks(): Promise<void> {
  try {
    const trustedProxyHops = await getSettings().get("auth.trustedProxyHops");
    const warning = proxyHopsWarning({
      isProduction: loadEnv().NODE_ENV === "production",
      trustedProxyHops,
    });
    if (warning) getLogger().warn({ setting: "auth.trustedProxyHops" }, warning);
  } catch {
    // setările nu pot fi citite acum (baza de date nu e încă pregătită): verificarea se sare
  }
}
