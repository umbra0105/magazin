import type { Metadata } from "next";
import { AddressManager } from "@/components/storefront/account/address-manager";
import { getAddressBook, requireCustomer } from "@/lib/account";
import { getGeoService } from "@/lib/checkout";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.addresses.title };
export const dynamic = "force-dynamic";

/** Agenda de adrese a clientului: adrese salvate (separate de adresele imuabile ale comenzilor), cu una implicită pe tip. */
export default async function AccountAddressesPage() {
  const { user } = await requireCustomer("/cont/adrese");
  const [addresses, counties] = await Promise.all([
    getAddressBook().list(user.id),
    getGeoService().counties(),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.addresses.title}</h1>
        <p className="max-w-prose text-ink-secondary">{m.addresses.lede}</p>
      </header>
      <AddressManager addresses={addresses} counties={counties} />
    </div>
  );
}
