/**
 * Masks an address for the operator directory: the first character of the local
 * part plus the domain, which is enough to tell two people apart without
 * turning a cross-organization console into an address harvester. A malformed
 * address is masked entirely rather than echoed.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "•••";
  const domain = email.slice(at + 1);
  if (!domain.includes(".")) return "•••";
  return `${email.slice(0, 1)}•••@${domain}`;
}
