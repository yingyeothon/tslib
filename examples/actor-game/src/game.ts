/**
 * The game's rules, and nothing else.
 *
 * No imports, no IO, no clock: this is the half you replace, and keeping it
 * free of the framework is what lets you unit-test it without a queue, a
 * socket or a Lambda. Everything in `main.ts` is the wiring around it.
 */

export interface Raid {
  bossHp: number;
  bossMaxHp: number;
  /** Damage dealt per member, so the result can be attributed. */
  damage: Record<string, number>;
}

export interface AttackMessage {
  type: "attack";
  connectionId: string;
  power?: number;
}

export const createRaid = (bossMaxHp: number): Raid => ({
  bossHp: bossMaxHp,
  bossMaxHp,
  damage: {},
});

/** A client controls `power`, so it is clamped here rather than trusted. */
export function applyHit(raid: Raid, memberId: string, power = 1): number {
  const dealt = Math.min(Math.max(Math.floor(power), 1), 10);
  raid.bossHp = Math.max(0, raid.bossHp - dealt);
  raid.damage[memberId] = (raid.damage[memberId] ?? 0) + dealt;
  return dealt;
}

export const isCleared = (raid: Raid): boolean => raid.bossHp <= 0;

export const snapshot = (raid: Raid) => ({
  type: "snapshot" as const,
  payload: {
    bossHp: raid.bossHp,
    bossMaxHp: raid.bossMaxHp,
    damage: { ...raid.damage },
  },
});
