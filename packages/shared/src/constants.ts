/**
 * Every tunable number in the game, in one place.
 *
 * The server and the client both import these, which is what makes local
 * prediction agree with the authoritative simulation: if a value only existed
 * on one side, the two would drift and the client would show hits that never
 * happened.
 */

/** Bumped whenever the wire format changes shape. Server rejects mismatches. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- match rules

export const MATCH = {
  /** Best of three: first to two round wins takes the match. */
  roundsToWin: 2,
  maxRounds: 3,
  startingHealth: 100,
  startingStamina: 100,
  /** Seconds of "3 / 2 / 1 / FENCE" before a round goes live. */
  countdownSeconds: 3,
  /** A round that reaches this length ends on health (sudden-death avoided). */
  roundTimeLimitSeconds: 120,
  /** Pause between the end of one round and the next countdown. */
  interRoundSeconds: 3,
} as const;

// ------------------------------------------------------------------- stamina

export const STAMINA = {
  /** Points regenerated per second while not attacking. */
  regenPerSecond: 18,
  /** Regen is suppressed for this long after any stamina spend. */
  regenDelaySeconds: 0.45,
  thrustCost: 22,
  slashCost: 18,
  dodgeCost: 25,
  /** Guarding drains slowly, so turtling forever is not a strategy. */
  guardDrainPerSecond: 4,
  /** Below this you simply cannot start an attack. */
  minToAttack: 15,
  /** Whiffing (attack resolved with no contact) refunds a little. */
  whiffRefund: 0.25,
} as const;

// ------------------------------------------------------------------ cooldowns
// Seconds. Enforced identically on client (for feedback) and server (for truth).

export const COOLDOWN = {
  thrust: 0.65,
  slash: 0.55,
  dodge: 1.1,
  parry: 0.5,
  /** Any attack blocks any other attack for this long (global anti-spam). */
  globalAttack: 0.4,
} as const;

// -------------------------------------------------------------------- combat

/**
 * Attacks do not land the instant they are thrown — they land after a windup.
 * That gap is the entire defensive game: it is the window in which the
 * defender can parry, dodge or reposition their guard.
 */
export const TIMING = {
  thrustWindupSeconds: 0.26,
  slashWindupSeconds: 0.32,
  /** A parry counts if it fires within this many seconds of the landing. */
  parryWindowSeconds: 0.18,
  /** A tighter window inside the above scores "Perfect Parry" + riposte. */
  perfectParryWindowSeconds: 0.09,
  /** Dodge invulnerability, measured from the moment the dodge starts. */
  dodgeInvulnSeconds: 0.35,
  /** After a successful parry the attacker cannot act at all. */
  staggerSeconds: 0.6,
} as const;

/** Base damage per hit zone before guard/parry/dodge modifiers. */
export const ZONE_DAMAGE = {
  head: 22,
  torso: 15,
  left: 12,
  right: 12,
} as const;

export const DAMAGE = {
  /** Multiplier applied when the defender's guard covers the attacked zone. */
  guardedMultiplier: 0.3,
  /** Multiplier for a non-perfect (late) parry. */
  parriedMultiplier: 0,
  /** Thrusts are pointier than slashes. */
  thrustMultiplier: 1.15,
  slashMultiplier: 1.0,
  /** Chip damage a guard cannot prevent, so guard is not an absolute wall. */
  minimumChip: 1,
} as const;

// ------------------------------------------------------------------ networking

export const NET = {
  /** Server -> client authoritative state broadcasts per second. */
  stateHz: 20,
  /** Client -> server pose updates per second. */
  poseHz: 20,
  /** Server simulation ticks per second. */
  tickHz: 30,
  /** Heartbeat interval; a socket that misses two is considered dead. */
  heartbeatSeconds: 5,
  /** Room code alphabet — no O/0/I/1, which people mistype over voice chat. */
  roomCodeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  roomCodeLength: 4,
} as const;

// ------------------------------------------------------ pose / gesture tuning
// All thresholds are in *normalized body units*: 1.0 = one shoulder width.
// Normalizing by the player's own body means these numbers hold whether
// someone is close to a laptop camera or across a room, tall or short.

export const POSE = {
  /** Landmarks below this visibility score are treated as missing. */
  minLandmarkConfidence: 0.5,
  /** Overall tracking confidence below this disables attacks entirely. */
  minTrackingConfidence: 0.45,
  /** Frames of continuous low confidence before we tell the player. */
  lostTrackingFrames: 15,
  /** Sword length as a multiple of the forearm (elbow -> wrist) length. */
  swordExtension: 2.6,
  /** 1-Euro filter defaults for landmark smoothing. */
  filterMinCutoff: 1.6,
  filterBeta: 0.05,
  filterDCutoff: 1.0,
  /** Looser filtering for hips/shoulders, which barely jitter to begin with. */
  steadyFilterMinCutoff: 4.5,
  steadyFilterBeta: 0.2,
  /** Frames of good tracking required before any gesture may fire. */
  warmupFrames: 3,
  /** ...and milliseconds of it, so a burst of frames cannot skip the warmup. */
  warmupMs: 120,
} as const;

export const GESTURE = {
  /** Wrist forward speed (body-widths/sec) that reads as a thrust. */
  thrustWristSpeed: 1.9,
  /** How much of that speed must be along the "forward" (toward camera) axis. */
  thrustForwardRatio: 0.55,
  /** A thrust also wants the body committing — hips/shoulders moving in. */
  thrustBodyAssist: 0.12,
  /** Wrist lateral speed (body-widths/sec) that reads as a slash. */
  slashWristSpeed: 2.4,
  /** Lateral share of the motion required to call it a slash, not a thrust. */
  slashLateralRatio: 0.6,
  /** Hip lateral displacement from calibrated centre that reads as a dodge. */
  dodgeHipOffset: 0.28,
  /** Hip lateral speed that reads as a dodge. */
  dodgeHipSpeed: 1.1,
  /** Blade angular speed (deg/sec) that reads as a deliberate parry sweep. */
  parryAngularSpeed: 420,
  /**
   * A swing keeps rotating the blade for a while after it is thrown. Parry is
   * deaf for this long afterwards, so the follow-through of your own slash
   * cannot double as a free block.
   */
  parryLockoutAfterAttackMs: 320,
  /** Sword must sit inside a guard sector this many degrees wide to count. */
  guardSectorHalfWidthDeg: 40,
  /** Sword must be this steady (deg/sec) to register as a held guard. */
  guardMaxAngularSpeed: 160,
} as const;
