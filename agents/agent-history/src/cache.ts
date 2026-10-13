export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number) {}
  async getOr(key: string, fn: () => Promise<V>): Promise<V> {
    const hit = this.m.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await fn(); this.m.set(key, { v, exp: Date.now() + this.ttlMs }); return v;
  }
}
