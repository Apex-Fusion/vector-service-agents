// Vector network endpoints. Defaults target testnet; override via environment.
export const VECTOR_OGMIOS_URL = process.env.VECTOR_OGMIOS_URL || 'https://ogmios.vector.mainnet.apexfusion.org';
export const VECTOR_SUBMIT_URL = process.env.VECTOR_SUBMIT_URL || 'https://submit.vector.mainnet.apexfusion.org/api/submit/tx';
export const VECTOR_KOIOS_URL = process.env.VECTOR_KOIOS_URL || 'https://v2.koios.vector.mainnet.apexfusion.org/';
export const VECTOR_EXPLORER_URL = process.env.VECTOR_EXPLORER_URL || 'https://vector.testnet.apexscan.org';

export function explorerTxLink(txHash: string): string {
  return `${VECTOR_EXPLORER_URL}/transaction/${txHash}`;
}
