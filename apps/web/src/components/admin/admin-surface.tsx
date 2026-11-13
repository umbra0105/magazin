import type { CSSProperties, ReactNode } from "react";

/**
 * Suprafața adminului (docs/17): `data-surface="admin"` activează fișierul de tokeni al adminului (culori deschise și închise,
 * dimensiuni, Inter fix). Adminul nu urmează paleta magazinului: din `Branding` vine doar brandul (`accent`, cu gardă de
 * contrast, pus inline ca `--brand-light` / `--brand-dark`), sigla și numele. O folosesc cadrul adminului, paginile de
 * autentificare și paginile 404 / eroare; fără `brandStyle` (pagini fără acces la setări) brandul rămâne cel implicit.
 */
export function AdminSurface({
  brandStyle,
  children,
}: {
  brandStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      data-surface="admin"
      {...(brandStyle && { style: brandStyle })}
      className="min-h-dvh bg-surface-page font-sans text-body text-ink"
    >
      {children}
    </div>
  );
}
