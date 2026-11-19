// scripts/checks/04-attestations.ts - check 4 of the mainnet checks: attestations of type 5 and type 4, with salted digests. See scripts/checks/README.md.
//   pnpm exec tsx scripts/checks/04-attestations.ts [status | run | cleanup] [--submit]
import { attestationsCheck } from './lib/check-attestations.ts';
import { main } from './lib/main.ts';

await main(attestationsCheck);
