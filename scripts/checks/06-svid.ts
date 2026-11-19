// scripts/checks/06-svid.ts - check 6 of the mainnet checks: the test record gets SVIDs and a verifier checks them. See scripts/checks/README.md.
//   CHECKS_SVID_VERIFIER_URL=<https URL of the host that asks for a client certificate> pnpm exec tsx scripts/checks/06-svid.ts [status | run | cleanup] [--submit]
import { svidCheck } from './lib/check-svid.ts';
import { main } from './lib/main.ts';

await main(svidCheck);
