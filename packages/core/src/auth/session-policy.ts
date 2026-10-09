/**
 * Conturile cu acces în admin au sesiuni mai scurte (`auth.adminSessionHours`). Better Auth are o
 * singură durată globală, deci limita se aplică aici, pe VÂRSTA sesiunii (de la autentificare),
 * indiferent de reînnoirile automate ale cookie-ului.
 */
export function isAdminSessionExpired(
  sessionCreatedAt: Date,
  adminSessionHours: number,
  now: Date = new Date(),
): boolean {
  return now.getTime() - sessionCreatedAt.getTime() >= adminSessionHours * 60 * 60 * 1000;
}
