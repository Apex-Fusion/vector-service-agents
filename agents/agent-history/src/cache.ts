// An in-memory cache that keeps the pending load itself, so concurrent callers of one key share a single load.
// An entry lives ttlMs after its load succeeded (exclusive: at exactly ttlMs it is stale). A pending entry never
// expires. A failed load is dropped, and so is a value the caller's `keep` predicate refuses (or throws on): everyone
// waiting on that load still gets the value, but the next caller loads again. The map is bounded: expired entries
// are purged whenever an entry is added, and past maxEntries the oldest entry goes.
export class TtlCache<V> {
  private m = new Map<string, { p: Promise<V>; exp: number }>();
  private max: number;
  constructor(private ttlMs: number, maxEntries = 1_000) { this.max = Math.max(1, maxEntries); }
  get size(): number { return this.m.size; }
  getOr(key: string, load: () => Promise<V>, keep: (value: V) => boolean = () => true): Promise<V> {
    const hit = this.m.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const entry = { p: (async () => load())(), exp: Infinity };
    this.add(key, entry);
    const drop = () => { if (this.m.get(key) === entry) this.m.delete(key); };
    const kept = (value: V) => { try { return keep(value); } catch { return false; } };
    // Registered before the caller can await entry.p, so an entry that is not kept is already gone when the caller sees the value or the error.
    entry.p.then((value) => { if (kept(value)) entry.exp = Date.now() + this.ttlMs; else drop(); }, drop);
    return entry.p;
  }
  private add(key: string, entry: { p: Promise<V>; exp: number }) {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.exp <= now) this.m.delete(k);
    this.m.delete(key); // a key that is added again goes to the newest slot
    while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(key, entry);
  }
}
