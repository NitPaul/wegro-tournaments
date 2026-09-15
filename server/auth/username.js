/**
 * User IDs.
 *
 * Short, typeable on a phone keyboard, and unambiguous when read out loud or
 * written on a sticky note at the auction: letters, digits, dots, dashes and
 * underscores, starting with a letter or digit. Case does not matter — "Faquid"
 * and "faquid" are the same account — so they are stored lower-case.
 */

import { badRequest } from "../http/errors.js";

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function cleanUsername(raw) {
  const username = String(raw ?? "").trim().toLowerCase();
  if (!username) throw badRequest("Enter a User ID.");
  if (username.length < 3) throw badRequest("A User ID needs at least 3 characters.");
  if (username.length > 32) throw badRequest("A User ID can be 32 characters at most.");
  if (!USERNAME_RE.test(username)) {
    throw badRequest("A User ID can use letters, numbers, dots, dashes and underscores, and must start with a letter or number.");
  }
  return username;
}
