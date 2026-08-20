/** Measures elapsed seconds between consecutive `getDelta` calls. */
export class TimeDelta {
  private lastMillis: number = Date.now();

  public getDelta(): number {
    const now = Date.now();
    const delta = (now - this.lastMillis) / 1000;
    this.lastMillis = now;
    return delta;
  }
}
