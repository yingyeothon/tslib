/** Measures elapsed seconds between consecutive `getDelta` calls. */
export interface TimeDelta {
  getDelta: () => number;
}

export function createTimeDelta(): TimeDelta {
  let lastMillis = Date.now();
  return {
    getDelta: () => {
      const now = Date.now();
      const delta = (now - lastMillis) / 1000;
      lastMillis = now;
      return delta;
    },
  };
}
