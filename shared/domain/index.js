/**
 * The domain layer — the rules of a tournament, as pure functions.
 *
 * Imported by the Node server AND by the browser, from the same files. That is
 * the single most valuable property of this codebase: there is exactly one
 * definition of how a league table sorts, what an auction bid is allowed to be,
 * and how award points are counted. The server validates with it, the browser
 * renders with it, and they cannot disagree.
 *
 * Nothing here touches the DOM, the network or the database. Everything takes a
 * plain tournament object and returns a plain value, which is what makes the
 * whole layer straightforward to unit test — see test/domain/.
 *
 * Usage is the same on both sides:
 *
 *   import * as D from "./shared/domain/index.js";   // server
 *   import * as D from "/shared/domain/index.js";    // browser
 */

export * from "./constants.js";
export * from "./helpers.js";
export * from "./clock.js";
export * from "./standings.js";
export * from "./events.js";
export * from "./stats.js";
export * from "./awards.js";
export * from "./auction.js";
export * from "./format.js";
