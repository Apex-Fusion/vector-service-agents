// scripts/checks/03-vault-refund.ts - check 3 of the mainnet checks: the record pays an agent from the vault of a member and no job is sent, and the lock returns to the vault. See scripts/checks/README.md.
//   CHECKS_ADVERT_REF=<advert of the agent> pnpm exec tsx scripts/checks/03-vault-refund.ts [status | run | cleanup] [--submit]
import { vaultCheck } from './lib/check-vault.ts';
import { vaultPort } from './lib/hire-adapter.ts';
import { main } from './lib/main.ts';

await main(vaultCheck('refund', vaultPort));
