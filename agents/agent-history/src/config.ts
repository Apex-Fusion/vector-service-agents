import { identityRegistryOf, plutusAddressFromBech32, LEGACY_REGISTRY, M1_ADDRESSES, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M6_ADDRESSES } from '@vsa/vector-read';
import type { Registries } from '@vsa/vector-read';
// The deployment values a report reads with: the two registries and the module addresses. They are settings, so that the service can point at
// the identity registry and at the new module deployments once they are published, without a code change.
export interface ModuleAddresses {
  /** Module-3: the stake address (decoded with the stake layout) and the endorsement address (matched generically). */
  m3: { reputation: string; endorsement: string };
  /** Module-1 and Module-6: label to address. The labels are the keys of the dispute and self_improvement sections, in this order. */
  m1: Record<string, string>;
  m6: Record<string, string>;
}
export interface ReportConfig { registries: Registries; modules: ModuleAddresses }
// The module deployments that were on Vector mainnet before the identity registry.
export const DEFAULT_MODULES: ModuleAddresses = { m3: { reputation: M3_REPUTATION_ADDRESS, endorsement: M3_ENDORSEMENT_ADDRESS }, m1: { ...M1_ADDRESSES }, m6: { ...M6_ADDRESSES } };
// No identity registry: the state before its deployment, and what a report built without a configuration reads.
export const DEFAULT_CONFIG: ReportConfig = { registries: { legacy: LEGACY_REGISTRY, identity: null }, modules: DEFAULT_MODULES };

// A module address is a Vector mainnet address whose payment credential is a script.
function moduleAddress(name: string, value: string): string {
  let scripted = false;
  try { scripted = value.startsWith('addr1') && plutusAddressFromBech32(value).paymentCredential.type === 'Script'; } catch { /* not an address */ }
  if (!scripted) throw new Error(`environment variable ${name} must hold Vector mainnet script addresses (addr1...), got "${value}"`);
  return value;
}
const LABEL = /^[a-z][a-z0-9_]{0,31}$/;
// label=address pairs separated by commas, white space allowed around each part. Absent or empty means the default list.
function addressList(name: string, v: string | undefined, fallback: Readonly<Record<string, string>>): Record<string, string> {
  if (v === undefined || v.trim() === '') return { ...fallback };
  const out: Record<string, string> = {};
  for (const part of v.split(',')) {
    const pair = /^\s*([^=\s]+)\s*=\s*(\S+)\s*$/.exec(part);
    if (!pair) throw new Error(`environment variable ${name} must be label=address pairs separated by commas, got "${part.trim()}"`);
    const [, label, address] = pair;
    if (!LABEL.test(label)) throw new Error(`environment variable ${name}: the label "${label}" must start with a lowercase letter and hold only lowercase letters, digits and _ (32 at most)`);
    if (label in out) throw new Error(`environment variable ${name} names the label ${label} twice`);
    if (Object.values(out).includes(address)) throw new Error(`environment variable ${name} names the address ${address} twice`);
    out[label] = moduleAddress(name, address);
  }
  return out;
}
// The settings, read once when the service starts. A value that breaks a rule stops the service, and the error names the variable.
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ReportConfig {
  let identity: Registries['identity'];
  try { identity = identityRegistryOf(env.IDENTITY_POLICY_ID, env.IDENTITY_ADDRESS); } catch (e) { throw new Error(`environment variable ${(e as Error).message}`); }
  return {
    registries: { legacy: LEGACY_REGISTRY, identity },
    modules: {
      // Absent or empty means the default address.
      m3: {
        reputation: env.M3_REPUTATION_ADDRESS?.trim() ? moduleAddress('M3_REPUTATION_ADDRESS', env.M3_REPUTATION_ADDRESS.trim()) : M3_REPUTATION_ADDRESS,
        endorsement: env.M3_ENDORSEMENT_ADDRESS?.trim() ? moduleAddress('M3_ENDORSEMENT_ADDRESS', env.M3_ENDORSEMENT_ADDRESS.trim()) : M3_ENDORSEMENT_ADDRESS,
      },
      m1: addressList('M1_ADDRESSES', env.M1_ADDRESSES, M1_ADDRESSES),
      m6: addressList('M6_ADDRESSES', env.M6_ADDRESSES, M6_ADDRESSES),
    },
  };
}
