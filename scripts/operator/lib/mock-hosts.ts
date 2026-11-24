// scripts/operator/lib/mock-hosts.ts - the two public origins of the mock systems of use case 1 (inventory reorder), and the domain of the insurer organisation that the mock service asks for.
// The env files of the agents hold the two origins, and the task `tenant` sends its call to the first. Each origin is an https origin: a scheme, one host name, and no path.
// The mock service needs two organisations for each tenant. Use case 1 uses only the supplier organisation (the organisation of the Order Desk). The insurer organisation is a fixed name that no agent of use case 1 has.
export const MOCK_PUBLIC_BASE = 'https://mp-mock-systems.vector.apexfusion.org';
export const MOCK_MTLS_BASE = 'https://mp-mock-systems-mtls.vector.apexfusion.org';
export const MOCK_INSURER_DOMAIN = 'delta.vector.apexfusion.org';
