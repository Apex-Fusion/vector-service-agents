// A world for the tests of the checks: wallets for keys that a test makes, and (with `identity`) the identity registry of the fixtures of buyer-core with a test record,
// a delegate key that the record lists, and the advert of an agent. It is a ChainView, so the real builders run on it, and a transaction that a test applies moves it on.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyerIdentityOf, lucidForAddress, rawHexToBech32 } from '../../lib/platform.ts';
import type { IdentityAdvertDatum, Utxo } from '../../lib/platform.ts';
import { LoadedKey, parseKeyText } from '../../lib/keys.ts';
import type { KeyRole } from '../../lib/keys.ts';
import { CONFIG_UTXO, DEPLOYMENT, NOW, REF_UTXOS, recordUtxo, rootRecord } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { ADVERT_REF, AGENT_ID, IDENTITY_ADVERT, advertUtxo, agentRecord } from '../../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { ChainView, hashOfTransaction } from './chain-view.ts';
import type { IdentityDatum } from '../../../../packages/vector-read/src/identity-codec.ts';

export { DEPLOYMENT, NOW, ADVERT_REF, AGENT_ID, IDENTITY_ADVERT };
export const DAY = 86_400_000;
/** The wallets of the tests: the controller of the test record, its delegate key, and a member. Each is a key made from one byte, so a test makes the same key each time. */
export const CONTROLLER_N = 1;
export const AGENT_N = 3;
export const MEMBER_N = 9;
export const RECORD_ID = 'c1'.repeat(32);
export const RECORD_DID = `did:vector:${RECORD_ID}`;
const FIXTURE_TX = 'e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c32';

export const seedHex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
export const roleOf = (n: number): KeyRole => (n === CONTROLLER_N ? 'controller' : n === AGENT_N ? 'agent' : 'member');
export const keyOf = (n: number, role: KeyRole = roleOf(n)): LoadedKey => parseKeyText(seedHex(n), role);

/** Writes the key file of a key of the tests, with mode 600, in the form that `form` names. Returns its path. */
export function writeKeyFile(dir: string, n: number, role: KeyRole = roleOf(n), form: 'hex' | 'bech32' | 'named' = 'named'): string {
  const path = join(dir, `${role}.key`);
  const key = keyOf(n, role);
  const text = form === 'hex' ? seedHex(n) : form === 'bech32' ? rawHexToBech32(seedHex(n)) : `VECTOR_SIGNER_PRIVATE_KEY=${rawHexToBech32(seedHex(n))}\nVECTOR_SIGNER_ADDRESS=${key.address}\n`;
  writeFileSync(path, `${text}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export interface WalletSpec {
  n: number;
  /** The outputs of the wallet in lovelace. The default is 1,000 units and a pure output of 5 units for collateral. */
  lovelace?: readonly bigint[];
}

const walletOutputs = (n: number, lovelace: readonly bigint[]): Utxo[] =>
  lovelace.map((amount, outputIndex) => ({ txHash: `${n.toString(16).padStart(2, '0')}${FIXTURE_TX.slice(2)}`, outputIndex, address: keyOf(n).address, assets: { lovelace: amount } }));

export interface PaymentBuild {
  unsignedCbor: string;
  txHash: string;
}

export class World {
  readonly chain: ChainView;
  readonly nowMs = NOW;

  private constructor(chain: ChainView) {
    this.chain = chain;
  }

  /** Wallets only: no identity registry. */
  static async create(wallets: readonly WalletSpec[], extra: readonly Utxo[] = []): Promise<World> {
    const utxos = wallets.flatMap((w) => walletOutputs(w.n, w.lovelace ?? [1_000_000_000n, 5_000_000n]));
    return new World(new ChainView([...utxos, ...extra], NOW));
  }

  /**
   * The registry of the fixtures with a test record: the controller key (the controller of the record), the delegate key (listed in the record with the authentication and the
   * delegation purposes), a funded member, and the advert of an agent that the identity marketplace lists.
   */
  static async identity(over: { wallets?: readonly WalletSpec[]; extra?: readonly Utxo[]; advert?: IdentityAdvertDatum; record?: Partial<IdentityDatum> } = {}): Promise<World> {
    const agent = keyOf(AGENT_N);
    const record = recordUtxo(RECORD_ID, rootRecord({ keys: [{ keyType: 'Ed25519', key: agent.publicKeyHex, purposes: 1 + 8 + 16, pop: null }], capabilities: [], ...over.record }));
    const wallets = over.wallets ?? [{ n: MEMBER_N }, { n: AGENT_N, lovelace: [200_000_000n, 5_000_000n] }];
    const utxos = [...wallets.flatMap((w) => walletOutputs(w.n, w.lovelace ?? [1_000_000_000n, 5_000_000n])), ...REF_UTXOS, CONFIG_UTXO, record, agentRecord(), advertUtxo(over.advert), ...(over.extra ?? [])];
    return new World(new ChainView(utxos, NOW));
  }

  /** Builds an unsigned payment from the wallet at `from` (to itself unless `to` is given). It spends the outputs of that wallet and is signed by its key. */
  async simplePayment(from: string, lovelace: bigint, to: string = from): Promise<PaymentBuild> {
    const lucid = await lucidForAddress(this.chain, from);
    const built = await lucid.newTx().pay.ToAddress(to, { lovelace }).complete();
    return { unsignedCbor: built.toCBOR(), txHash: built.toHash() };
  }

  /** The hash of a transaction, signed or not: the hash of its body. */
  hashOf(cborHex: string): string {
    return hashOfTransaction(cborHex);
  }

  addressOf(n: number): string {
    return buyerIdentityOf(seedHex(n)).address;
  }
}
