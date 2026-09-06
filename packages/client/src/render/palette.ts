/**
 * The arena's colour language.
 *
 * One rule holds the whole look together: **you are cyan, the opponent is
 * magenta**, everywhere and without exception - blade, avatar, health bar,
 * damage numbers, log entries. In a fast game the player should never have to
 * work out which figure is theirs.
 *
 * Outcomes get their own hues that are not either fighter's, so a "PARRY" flash
 * reads as an event rather than as one side's colour.
 */

export const PALETTE = {
  // Ground
  skyTop: '#070b14',
  skyBottom: '#0d1626',
  floor: '#0a1120',
  floorLine: 'rgba(88, 231, 255, 0.16)',
  grid: 'rgba(120, 160, 220, 0.07)',
  haze: 'rgba(88, 231, 255, 0.05)',

  // Fighters
  self: '#58e7ff',
  selfDim: 'rgba(88, 231, 255, 0.35)',
  selfDeep: '#1b7f97',
  foe: '#ff5cc8',
  foeDim: 'rgba(255, 92, 200, 0.35)',
  foeDeep: '#8c2a68',

  // Meters
  health: '#4ade80',
  healthLow: '#f87171',
  stamina: '#fbbf24',
  staminaEmpty: 'rgba(251, 191, 36, 0.18)',
  meterTrack: 'rgba(255, 255, 255, 0.09)',

  // Outcomes
  hit: '#ff6b57',
  guard: '#9ca3af',
  parry: '#ffe066',
  dodge: '#7dd3fc',
  text: '#e8eefc',
  textDim: 'rgba(232, 238, 252, 0.55)',
  warn: '#fbbf24',
} as const;

/** Health bar colour, reddening as the bar empties. */
export function healthColor(fraction: number): string {
  return fraction <= 0.3 ? PALETTE.healthLow : PALETTE.health;
}
