// agents/bid-desk/src/serve/start.ts
// How the Bid Desk starts and stops. This file holds the configuration that the wiring takes (ServiceConfig). The service reads the environment into it once, and every other part gets it as a value.
import type { IdentityDeployment } from '@vsa/buyer-core';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { Did } from '@vsa/usecase-kit/protocol';
import type { LoadedPriceList } from '../checks/index.ts';
import type { Endpoints, Instance, SupplierKey } from './settings.ts';

/** What the service runs on: every setting, read and checked. */
export interface ServiceConfig {
  /** The bytes that `GET /agent.json` serves, and their SHA-256: the hash that the advert holds. */
  readonly manifest: { readonly text: string; readonly sha256: string };
  /** The token that POST / and POST /precheck require as their authorization header. A secret: it is in no message, no log line and no manifest. */
  readonly authHeader: string;
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  /** The fault switch, made one time. */
  readonly fault: FaultSwitch<'bid-desk'>;
  /** Which of the three Bid Desks this deployment is. */
  readonly instance: Instance;
  /** The DID of this Bid Desk: the desk of its quotes, and the agent whose credential the job asks for. */
  readonly agentDid: Did;
  /** The domain of the organisation of this Bid Desk, as its record names it. */
  readonly organisation: string;
  /** The service key, 64 lower-case hex characters, which goes to the chain and the signer and nowhere else, and what it derives to: the key hash and the mainnet enterprise address. */
  readonly service: { readonly privateKeyHex: string; readonly pkh: string; readonly address: string };
  /** The public part of the supplier key: the key of the runtime. This service never holds its private key. */
  readonly supplier: SupplierKey;
  readonly limits: ModelLimits;
  /** The budget of one timed read of the hook, in milliseconds. */
  readonly checksBudgetMs: number;
  readonly endpoints: Endpoints;
  /** The identity registry deployment, with the reference scripts of the escrow and of the vault. */
  readonly identityDeployment: IdentityDeployment;
  /** The price list file of the instance as it was read: the service serves its text, and the manifest holds its hash. */
  readonly priceList: LoadedPriceList;
}
