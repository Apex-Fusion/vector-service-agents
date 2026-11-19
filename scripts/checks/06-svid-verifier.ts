// scripts/checks/06-svid-verifier.ts - the verifier service of check 6, behind the host that asks for a client certificate. See scripts/checks/README.md.
//   CHECKS_SVID_AUDIENCE=<the audience that a JWT-SVID must name> [CHECKS_SVID_PORT=9120] [CHECKS_GATEWAY_URL=<origin of the gateway>] pnpm exec tsx scripts/checks/06-svid-verifier.ts
// It listens on 127.0.0.1 only and logs one JSON line for each answer. It signs nothing and holds no key.
import { EnvReader } from './lib/settings.ts';
import { createSvidService } from './lib/svid-verifier.ts';

const reader = new EnvReader(process.env);
const audience = reader.text('CHECKS_SVID_AUDIENCE', true) ?? '';
const gatewayUrl = reader.url('CHECKS_GATEWAY_URL', 'https://id.vector.apexfusion.org');
const port = Number(reader.whole('CHECKS_SVID_PORT', 1n, 65_535n, 9120n));
try {
  reader.done();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
const server = await createSvidService({ gatewayUrl, audience }).listen(port);
process.stdout.write(`${JSON.stringify({ listening: `127.0.0.1:${port}`, gateway: gatewayUrl, audience })}\n`);
process.on('SIGTERM', () => { server.close(); });
