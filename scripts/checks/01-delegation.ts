// scripts/checks/01-delegation.ts - check 1 of the mainnet checks: a member key delegates to the test record, and ends the delegation. See scripts/checks/README.md.
//   pnpm exec tsx scripts/checks/01-delegation.ts [status | run | cleanup] [--submit] [--skip-token-check]
import { delegationCheck } from './lib/check-delegation.ts';
import { main } from './lib/main.ts';

await main(delegationCheck);
