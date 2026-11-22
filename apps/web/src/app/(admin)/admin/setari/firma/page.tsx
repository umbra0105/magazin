import type { Metadata } from "next";
import { can } from "@ecom/core";
import { CompanyForm } from "@/components/admin/company/company-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.company;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Datele firmei (Faza 13): citire cu `settings.read`, salvare cu `settings.write`. Cota de TVA e doar afișată. */
export default async function CompanyPage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const settings = getSettings();
  const [company, legal, tax, regional] = await Promise.all([
    settings.getGroup("company"),
    settings.getGroup("legal"),
    settings.getGroup("tax"),
    settings.getGroup("regional"),
  ]);
  const canSave = can(subject, "settings.write");
  const vatPercent = new Intl.NumberFormat(regional.locale, { maximumFractionDigits: 2 }).format(
    tax.standardRate,
  );
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title={m.title} description={m.description} notes={canSave ? [] : [m.readOnly]} />
      <CompanyForm
        canSave={canSave}
        vatPercent={vatPercent}
        initial={{
          legalName: company.legalName,
          vatId: company.vatId,
          tradeRegisterNo: company.tradeRegisterNo,
          isVatPayer: company.isVatPayer,
          phone: company.phone,
          email: company.email,
          street: company.address.street,
          city: company.address.city,
          county: company.address.county,
          postalCode: company.address.postalCode,
          country: company.address.country,
          iban: company.iban,
          bankName: company.bankName,
          pickupHours: company.pickupHours,
          anpcUrl: legal.anpcUrl,
          salUrl: legal.salUrl,
          odrUrl: legal.odrUrl,
        }}
      />
    </div>
  );
}
