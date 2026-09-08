/**
 * Small, network-safe character loadout.
 *
 * Values are normalized so the client can render them continuously while the
 * server only has to validate five bounded numbers.  Keeping appearance out
 * of the pose stream means changing a hairstyle never adds latency to a punch.
 */

export interface CharacterCustomization {
  /** 0 = light, 1 = dark. */
  skinTone: number;
  /** 0 = short, 1 = tall. */
  height: number;
  /** 0 = lean, 1 = heavy. */
  build: number;
  /** 0..1 selects one of four hair silhouettes. */
  hair: number;
  /** 0..1 selects one of four glove colors. */
  gloves: number;
}

export const DEFAULT_CHARACTER: CharacterCustomization = {
  skinTone: 0.48,
  height: 0.52,
  build: 0.5,
  hair: 0.25,
  gloves: 0,
};

export function normalizeCharacter(
  value: Partial<CharacterCustomization> | null | undefined,
): CharacterCustomization {
  const bounded = (n: number | undefined, fallback: number): number =>
    Number.isFinite(n) ? Math.max(0, Math.min(1, n as number)) : fallback;
  return {
    skinTone: bounded(value?.skinTone, DEFAULT_CHARACTER.skinTone),
    height: bounded(value?.height, DEFAULT_CHARACTER.height),
    build: bounded(value?.build, DEFAULT_CHARACTER.build),
    hair: bounded(value?.hair, DEFAULT_CHARACTER.hair),
    gloves: bounded(value?.gloves, DEFAULT_CHARACTER.gloves),
  };
}
