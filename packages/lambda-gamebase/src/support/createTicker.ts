export interface TickerOptions<STAGE> {
  stage: STAGE;
  aliveMillis: number;
}

/**
 * Tracks the lifetime of a game stage. `age` is the number of whole
 * seconds elapsed since creation, and `checkAgeChanged` invokes the
 * callback only when the age advanced since the last check.
 */
export interface Ticker<STAGE> {
  readonly stage: STAGE;
  readonly age: number;
  isAlive: () => boolean;
  checkAgeChanged: (
    onChanged: (stage: STAGE, age: number) => Promise<unknown>,
  ) => Promise<void>;
}

export function createTicker<STAGE>({
  stage,
  aliveMillis,
}: TickerOptions<STAGE>): Ticker<STAGE> {
  const startMillis = Date.now();
  let ageBefore = -1;

  function elapsed(): number {
    return Date.now() - startMillis;
  }
  function calculateAge(): number {
    return Math.floor(elapsed() / 1000);
  }

  return {
    stage,
    get age(): number {
      return calculateAge();
    },
    isAlive: () => elapsed() < aliveMillis,
    checkAgeChanged: async (onChanged) => {
      const newAge = calculateAge();
      if (ageBefore === newAge) {
        return;
      }
      ageBefore = newAge;
      await onChanged(stage, newAge);
    },
  };
}
