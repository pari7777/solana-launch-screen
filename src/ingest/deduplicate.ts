/** Bounded "seen" set: drops duplicate events when a stream reconnects or two providers overlap. */
export class Dedupe {
  private set = new Set<string>();
  private order: string[] = [];
  constructor(private max = 50_000) {}
  /** true the first time a key is seen */
  first(key: string) {
    if (this.set.has(key)) return false;
    this.set.add(key); this.order.push(key);
    if (this.order.length > this.max) this.set.delete(this.order.shift()!);
    return true;
  }
  get size() { return this.set.size; }
}
