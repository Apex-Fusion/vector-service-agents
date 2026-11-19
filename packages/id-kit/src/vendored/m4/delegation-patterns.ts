// ── Section 5.1 patterns ──

const SEG = "[a-z0-9-]+";
const INTERNAL = new RegExp(`^${SEG}(?:\\.${SEG})*$`);
const PREFIX = new RegExp(`^${SEG}(?:\\.${SEG})*\\.\\*$`);
const EXTERNAL = /^(?:oauth:|mcp:|https:\/\/)[\x21-\x7e]+$/;
const SCRIPT = /^script:[0-9a-f]{56}$/;

export const isActionPattern = (p: string): boolean => p === "*" || INTERNAL.test(p) || PREFIX.test(p) || EXTERNAL.test(p);
export const isResourcePattern = (p: string): boolean => p === "*" || SCRIPT.test(p) || EXTERNAL.test(p);

/** A pattern covers a value: `*`, the value itself, or `x.*` when the value starts with `x.`. External and script patterns match only exactly. */
export function covers(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true;
  return PREFIX.test(pattern) && value.startsWith(pattern.slice(0, -1));
}

/** A parent pattern covers a child pattern. A child `x.*` is covered only by `*` or by a parent `y.*` with x = y or x starting with `y.`. */
export function patternCovers(parent: string, child: string): boolean {
  if (child === "*") return parent === "*";
  if (PREFIX.test(child)) {
    if (parent === "*") return true;
    if (!PREFIX.test(parent)) return false;
    const x = child.slice(0, -2);
    const y = parent.slice(0, -2);
    return x === y || x.startsWith(`${y}.`);
  }
  return covers(parent, child);
}

/** The child list is narrower than the parent list: a parent pattern covers each child pattern. */
export const narrower = (parents: readonly string[], children: readonly string[]): boolean => children.every((c) => parents.some((p) => patternCovers(p, c)));
