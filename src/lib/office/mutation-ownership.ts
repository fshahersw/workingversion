/** A whole-document rollback is allowed only when all intervening edits are owned. */
export class MutationOwnership<T> {
  private expected: T | undefined;
  private safe = false;
  private readonly read: () => T;
  private readonly equal: (a: T, b: T) => boolean;
  constructor(read: () => T, equal: (a: T, b: T) => boolean) {
    this.read = read;
    this.equal = equal;
  }

  begin(): void { this.expected = this.read(); this.safe = true; }

  private check(): void {
    if (this.expected === undefined || !this.equal(this.expected, this.read())) this.safe = false;
  }

  run<R>(operation: () => R): R {
    this.check();
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        // An async mutation can interleave a user edit. Keep the pre-await state;
        // any change across the await makes full-document rollback ambiguous.
        return Promise.resolve(result).then((value) => {
          this.check();
          return value;
        }, (error: unknown) => {
          this.safe = false;
          throw error;
        }) as R;
      }
      // Synchronous commands cannot interleave browser input events.
      this.expected = this.read();
      return result;
    } catch (error) {
      this.safe = false;
      throw error;
    }
  }

  canRollback(): boolean { this.check(); return this.safe; }
}
