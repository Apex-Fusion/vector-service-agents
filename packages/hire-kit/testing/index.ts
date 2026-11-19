// packages/hire-kit/testing/index.ts
// The shared stubs of the kit, served as `@vsa/hire-kit/testing`: the in-memory marketplace of the tests (a FakeChain, an indexer, a model supplier and a template
// supplier behind one fetch). Test code imports it. No service imports it.
export * from './stub-suppliers.ts';
