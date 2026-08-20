/**
 * Tracks the lifetime of a game stage. `age` is the number of whole
 * seconds elapsed since construction, and `checkAgeChanged` invokes the
 * callback only when the age advanced since the last check.
 */
export class Ticker<STAGE> {
  private readonly startMillis: number = Date.now();
  private ageBefore = -1;

  constructor(
    public readonly stage: STAGE,
    private readonly aliveMillis: number,
  ) {}

  public get age(): number {
    return this.calculateAge();
  }

  public isAlive(): boolean {
    return this.elapsed() < this.aliveMillis;
  }

  public async checkAgeChanged(
    onChanged: (stage: STAGE, age: number) => Promise<unknown>,
  ): Promise<void> {
    const newAge = this.calculateAge();
    if (this.ageBefore === newAge) {
      return;
    }
    this.ageBefore = newAge;
    await onChanged(this.stage, newAge);
  }

  private calculateAge(): number {
    return Math.floor(this.elapsed() / 1000);
  }

  private elapsed(): number {
    return Date.now() - this.startMillis;
  }
}
