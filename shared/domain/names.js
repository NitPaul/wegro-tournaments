/**
 * Matching a tournament player's name to a person on the roster.
 *
 * Only ever used to SUGGEST. Scoresheets use short names ("Munna", "Sabbir",
 * "Mehedi (ops)") and the roster uses full ones ("Mahmud Hasan Munna", "Sadman
 * Sabbir"), and plenty of names are shared — so an automatic match would put
 * the wrong face on somebody. The admin always confirms.
 */

/** Honorifics and filler that say nothing about who someone is. */
const NOISE = new Set(["md", "mohammad", "mohammed", "muhammad", "mohd", "kbd", "vai", "bhai", "apu", "sir", "ops"]);

export function nameTokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !NOISE.has(t));
}

/**
 * Two tokens are the same word: identical, one the start of the other, or one
 * slip of spelling apart when either has five letters or more ("Iftiakh" /
 * "Iftiak", "Siam" / "Siyam").
 */
function sameWord(a, b) {
  if (a === b) return true;
  // A nickname is usually the start of the full name: "Rafik" / "Rafikul",
  // "Monir" / "Moniruzzaman". Four letters at least, or "Ar" would match everyone.
  if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (Math.max(a.length, b.length) < 5) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  // One insertion, deletion or substitution.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * How well `name` matches a roster person's name, 0–1.
 * Every word of the shorter name must be found in the longer one for a full score.
 */
export function nameScore(name, candidate) {
  const a = nameTokens(name);
  const b = nameTokens(candidate);
  if (!a.length || !b.length) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const found = short.filter((t) => long.some((u) => sameWord(t, u))).length;
  return found / short.length;
}

/**
 * The best roster suggestions for a name, strongest first.
 * @param {string} name
 * @param {{id:string,name:string}[]} people
 */
export function suggestPeople(name, people, { limit = 3, minScore = 0.5 } = {}) {
  return people
    .map((p) => ({ person: p, score: nameScore(name, p.name) }))
    .filter((s) => s.score >= minScore)
    .sort((x, y) => y.score - x.score || x.person.name.length - y.person.name.length)
    .slice(0, limit);
}

/** A readable name from a photo's file name: "mahmud-hasan-munna.png" → "Mahmud Hasan Munna". */
export function nameFromFileName(fileName) {
  const base = String(fileName ?? "").replace(/\.[a-z0-9]+$/i, "");
  return base
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length <= 2 && /^[a-z]+$/i.test(w) && w.toLowerCase() !== w ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
