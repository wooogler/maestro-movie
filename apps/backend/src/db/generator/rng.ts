/**
 * Seeded PRNG. The dataset must be reproducible: a demo that regenerates
 * differently on every run cannot be reviewed, and a bug found at the booth
 * cannot be reproduced afterwards. `Math.random` gives neither.
 *
 * mulberry32 — small, fast, good enough for content generation.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() needs a non-empty array');
    return items[this.int(0, items.length - 1)];
  }

  /** Picks by relative weight; entries with weight <= 0 are never chosen. */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    const weights = items.map((item) => Math.max(0, weightOf(item)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return this.pick(items);
    let roll = this.next() * total;
    for (let index = 0; index < items.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) return items[index];
    }
    return items[items.length - 1];
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.int(0, index);
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  }

  /** A fresh generator derived from this one, so one stream's length cannot shift another's. */
  fork(label: string): Rng {
    let hash = 2166136261;
    for (let index = 0; index < label.length; index += 1) {
      hash ^= label.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return new Rng((hash ^ Math.floor(this.next() * 0xffffffff)) >>> 0);
  }
}
