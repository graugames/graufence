/**
 * @graufence/shared - the code both ends of the wire agree on.
 *
 * The client and the server import the *same* vector maths, the same gesture
 * thresholds, the same damage table and the same match engine. That is not a
 * tidiness preference: it is the reason a hit predicted locally matches the hit
 * the server rules on a moment later.
 */

export * from './constants.js';
export * from './character.js';
export * from './vector.js';
export * from './filter.js';
export * from './pose.js';
export * from './actions.js';
export * from './combat.js';
export * from './match.js';
export * from './protocol.js';
export * from './rooms.js';
