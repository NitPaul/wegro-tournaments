/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard, it is in Node's standard library, and it needs no
 * native module — which means `npm install` never has to compile anything and
 * the container image builds on any machine. argon2 would be marginally
 * stronger and costs a native build plus a dependency; for a company football
 * tournament that is the wrong side of the trade.
 *
 * Hashes are stored self-describing:
 *
 *     scrypt$16384$8$1$<salt-hex>$<hash-hex>
 *
 * so the cost parameters can be raised later without invalidating existing
 * passwords — verification reads the parameters out of the stored string, and
 * `needsRehash` tells the login route when to quietly upgrade one.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const N = 16384; // CPU/memory cost — 128 * N * r = 16 MB per hash
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Node's default maxmem is 32 MB; state it explicitly so raising N later fails
// with a clear error here rather than an obscure one from OpenSSL.
const MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(plain) {
  const problem = validatePassword(plain);
  if (problem) throw new Error(problem);

  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(plain.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;

  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const params = {
    N: Number.parseInt(nRaw, 10),
    r: Number.parseInt(rRaw, 10),
    p: Number.parseInt(pRaw, 10),
    maxmem: MAX_MEM,
  };
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
    return false;
  }

  let expected;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = await scryptAsync(
      String(plain).normalize("NFKC"),
      Buffer.from(saltHex, "hex"),
      expected.length,
      params,
    );
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash used weaker parameters than we now use. */
export function needsRehash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number.parseInt(parts[1], 10) < N;
}

/**
 * Length is the only rule.
 *
 * Composition rules ("one capital, one symbol") push people towards
 * `Password1!` and towards writing it on a sticky note. A 10-character minimum
 * with no other constraints lets someone use a passphrase they will actually
 * remember on a Saturday afternoon at a turf.
 */
export function validatePassword(plain) {
  const value = String(plain ?? "");
  if (value.length < 10) return "Password must be at least 10 characters.";
  if (value.length > 200) return "Password must be 200 characters or fewer.";
  if (!value.trim()) return "Password cannot be only spaces.";
  return null;
}
