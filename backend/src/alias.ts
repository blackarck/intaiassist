import { randomBytes } from "node:crypto";

/**
 * Crockford base32 (no I, L, O, U): easy to read aloud and type, hard to mistake.
 * 32 symbols divides 256 evenly, so taking each random byte modulo 32 is unbiased.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A new interview alias, e.g. "K7M2QX9WPB": 10 symbols = 50 bits of randomness.
 *
 * The alias is the only thing that ties an inbound invite e-mail to a paid interview, so it must not be guessable:
 * anyone who knows one can point that interview's bot at a different meeting or cancel it. Short aliases (4 symbols
 * is only about 1 million possibilities) can be brute-forced; 10 cannot.
 */
export function generateAlias(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

/** The address the interviewer adds to the meeting invite. */
export function aliasAddress(alias: string, aliasDomain: string): string {
  return `iv-${alias.toLowerCase()}@${aliasDomain}`;
}
