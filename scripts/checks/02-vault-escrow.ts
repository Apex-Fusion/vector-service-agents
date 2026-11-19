// scripts/checks/02-vault-escrow.ts - check 2 of the mainnet checks: the record pays an agent from the vault of a member, and the job is done and accepted. See scripts/checks/README.md.
//   CHECKS_ADVERT_REF=<advert of the agent> pnpm exec tsx scripts/checks/02-vault-escrow.ts [status | run | cleanup] [--submit]
import { vaultCheck } from './lib/check-vault.ts';
import { vaultPort } from './lib/hire-adapter.ts';
import { main } from './lib/main.ts';

await main(vaultCheck('escrow', vaultPort));
