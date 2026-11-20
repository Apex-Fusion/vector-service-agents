// services/mock-systems/src/config.ts
// The settings of the service, read once at the start. Every setting is checked before anything is made: a wrong value stops the start, and the error names the variable and never
// shows a secret. The service holds no key and no wallet. Its one secret is the operator token (MOCK_OPERATOR_TOKEN), which makes and resets tenants.
//
//   MOCK_PUBLIC_BASE            the https origin of the host that takes tokens and JWT-SVIDs. The resource of a route is <this origin>/t/<tenant>/<system>, and a DPoP proof names it.
//   MOCK_MTLS_BASE              the https origin of the host that asks for a client certificate. It is another host than MOCK_PUBLIC_BASE. The service takes the header Client-Cert on it only.
//   MOCK_OPERATOR_TOKEN         the token of POST /admin/tenants: 32 to 128 characters of letters, digits and . _ ~ + / = -. No default.
//   IDENTITY_GATEWAY_URL        the origin of the identity gateway. Default https://id.vector.apexfusion.org.
//   VECTOR_OGMIOS_URL           the node of the ledger that the delegation check and the approval check read. Default: the node of Vector mainnet.
//   VECTOR_KOIOS_URL            the indexer of the ledger that the delegation check and the approval check read. Default: the indexer of Vector mainnet.
//   VECTOR_IDENTITY_LEGACY_ROOT, VECTOR_IDENTITY_CONFIG_SEED, VECTOR_IDENTITY_POLICY_ID
//                               the identity registry deployment that the two checks read: the two published values and the policy that they give. All three are required, so that a
//                               value with a typo stops the start. A read of the ledger with the wrong deployment finds no delegation and no attestation, and the service would refuse every call.
//   PORT, HOST                  where the service listens. Defaults 9120 and 127.0.0.1. The container sets HOST to 0.0.0.0, and its compose file publishes the port on 127.0.0.1 only.
import { identityDeploymentFrom } from '@vsa/buyer-core';
import type { IdentityDeployment } from '@vsa/buyer-core';
import { envInt, given, refuseSecretIn, requiredEnv, shown } from '@vsa/service-kit';

export const SETTINGS = [
  'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'MOCK_OPERATOR_TOKEN', 'IDENTITY_GATEWAY_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL',
  'VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_POLICY_ID', 'PORT', 'HOST',
] as const;

export const PORT_DEFAULT = 9120;
export const HOST_DEFAULT = '127.0.0.1';
export const GATEWAY_DEFAULT = 'https://id.vector.apexfusion.org';
export const OGMIOS_DEFAULT = 'https://ogmios.vector.mainnet.apexfusion.org';
export const KOIOS_DEFAULT = 'https://v2.koios.vector.mainnet.apexfusion.org';
const TOKEN_FORM = /^[A-Za-z0-9._~+/=-]{32,128}$/;
const HOST_FORM = /^[A-Za-z0-9.:-]{1,253}$/;

export interface ServiceConfig {
  /** The origin of the host of tokens and JWT-SVIDs, and its host name in lower case (with the port when it is not the default one). */
  readonly publicBase: string;
  readonly publicHost: string;
  /** The origin of the client-certificate host, and its host name in lower case. */
  readonly mtlsBase: string;
  readonly mtlsHost: string;
  readonly operatorToken: string;
  readonly gatewayUrl: string;
  readonly ogmiosUrl: string;
  readonly koiosUrl: string;
  readonly deployment: IdentityDeployment;
  readonly host: string;
  readonly port: number;
}

/** An https origin: no user, no path, no query and no fragment. Gives the origin and its host (with the port when it is not the default one). */
function httpsOrigin(name: string, value: string): { origin: string; host: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`environment variable ${name} must be an https origin such as https://host.example, got ${shown(value)}`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || value.endsWith('//')) {
    throw new Error(`environment variable ${name} must be an https origin with no user, path, query or fragment, got ${shown(value)}`);
  }
  return { origin: url.origin, host: url.host };
}

/**
 * The configuration that the environment describes. Throws an Error that names the variable that is wrong. The operator token is read first and looked for in every other setting, so
 * that a token put in the wrong line is named and never printed by a check of that line.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const operatorToken = requiredEnv('MOCK_OPERATOR_TOKEN', env.MOCK_OPERATOR_TOKEN, 'the token of POST /admin/tenants');
  if (!TOKEN_FORM.test(operatorToken)) {
    throw new Error(`environment variable MOCK_OPERATOR_TOKEN must have 32 to 128 characters of letters, digits and . _ ~ + / = -, and it has ${operatorToken.length} characters`);
  }
  refuseSecretIn(env, SETTINGS, [operatorToken.toLowerCase()], 'MOCK_OPERATOR_TOKEN', (name) =>
    `environment variable ${name} holds the operator token, which belongs in MOCK_OPERATOR_TOKEN alone: it would be printed. Take it out of ${name}`);

  const publicBase = httpsOrigin('MOCK_PUBLIC_BASE', requiredEnv('MOCK_PUBLIC_BASE', env.MOCK_PUBLIC_BASE, 'the https origin of the host of tokens and JWT-SVIDs'));
  const mtlsBase = httpsOrigin('MOCK_MTLS_BASE', requiredEnv('MOCK_MTLS_BASE', env.MOCK_MTLS_BASE, 'the https origin of the client-certificate host'));
  if (publicBase.host.toLowerCase() === mtlsBase.host.toLowerCase()) {
    throw new Error('environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE: the service tells the two hosts apart by the Host header');
  }
  const gatewayUrl = httpsOrigin('IDENTITY_GATEWAY_URL', given(env.IDENTITY_GATEWAY_URL) || GATEWAY_DEFAULT).origin;
  const ogmiosUrl = httpsOrigin('VECTOR_OGMIOS_URL', given(env.VECTOR_OGMIOS_URL) || OGMIOS_DEFAULT).origin;
  const koiosUrl = httpsOrigin('VECTOR_KOIOS_URL', given(env.VECTOR_KOIOS_URL) || KOIOS_DEFAULT).origin;

  const root = requiredEnv('VECTOR_IDENTITY_LEGACY_ROOT', env.VECTOR_IDENTITY_LEGACY_ROOT, 'a published value of the identity registry deployment');
  const seed = requiredEnv('VECTOR_IDENTITY_CONFIG_SEED', env.VECTOR_IDENTITY_CONFIG_SEED, 'a published value of the identity registry deployment');
  const policy = requiredEnv('VECTOR_IDENTITY_POLICY_ID', env.VECTOR_IDENTITY_POLICY_ID, 'the identity policy that the two values give, which checks them');
  let deployment: IdentityDeployment | null;
  try {
    deployment = identityDeploymentFrom({ VECTOR_IDENTITY_LEGACY_ROOT: root, VECTOR_IDENTITY_CONFIG_SEED: seed, VECTOR_IDENTITY_POLICY_ID: policy });
  } catch (error) {
    throw new Error(`environment variable ${error instanceof Error ? error.message : String(error)}`);
  }
  if (deployment === null) throw new Error('environment variable VECTOR_IDENTITY_LEGACY_ROOT is required: the identity registry deployment is not set');

  const port = envInt('PORT', env.PORT, PORT_DEFAULT);
  if (port < 1 || port > 65_535) throw new Error(`environment variable PORT must be a port from 1 to 65535, got ${shown(String(env.PORT))}`);
  const host = given(env.HOST) || HOST_DEFAULT;
  if (!HOST_FORM.test(host)) throw new Error(`environment variable HOST must be an address or a host name, got ${shown(host)}`);

  return {
    publicBase: publicBase.origin, publicHost: publicBase.host.toLowerCase(), mtlsBase: mtlsBase.origin, mtlsHost: mtlsBase.host.toLowerCase(), operatorToken,
    gatewayUrl, ogmiosUrl, koiosUrl, deployment, host, port,
  };
}
