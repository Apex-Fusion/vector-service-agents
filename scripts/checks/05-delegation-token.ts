// scripts/checks/05-delegation-token.ts - check 5 of the mainnet checks: a delegation token, after 30 confirmations of the delegation of check 1. See scripts/checks/README.md.
//   pnpm exec tsx scripts/checks/05-delegation-token.ts [status | run | cleanup] [--submit]
import { tokenCheck } from './lib/check-token.ts';
import { main } from './lib/main.ts';

await main(tokenCheck);
