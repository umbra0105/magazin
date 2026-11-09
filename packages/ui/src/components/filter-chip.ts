/**
 * Eticheta eliminabilă a unui filtru activ (docs/17 §4.1): pastilă neutră, 12 px / 500, cu pictograma «×» după text. Se aplică pe
 * o legătură (`Link`) a cărei adresă scoate filtrul; numele accesibil spune ce se elimină. Doar clasele, ca `buttonVariants`.
 */
export const filterChipClass =
  "inline-flex min-h-8 items-center gap-1.5 rounded-full bg-tone-neutral-bg px-3 text-label text-tone-neutral-fg " +
  "transition-colors duration-(--motion) hover:bg-surface-hover " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page";
