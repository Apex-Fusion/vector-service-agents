// Shared by the tests. The manifest needs one setting from the operator, OPERATOR_CONTACT, and has no default for it. Tests use an
// address on the reserved .test domain, never a real one.
export const TEST_CONTACT = 'ops@example.test';
export const TEST_ENV = { OPERATOR_CONTACT: TEST_CONTACT } as const;
