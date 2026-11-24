// The public origins of the mock systems.
// The env files of the agents hold the two origins, and the task `tenant` sends its call to the first. Each origin is an https origin: a scheme, one host name, and no path.
export const MOCK_PUBLIC_BASE = 'https://mp-mock-systems.vector.apexfusion.org';
export const MOCK_MTLS_BASE = 'https://mp-mock-systems-mtls.vector.apexfusion.org';
