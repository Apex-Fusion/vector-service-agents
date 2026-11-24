// The fakes of the checks that the tests of the operator pack share: a clock that moves when it sleeps, a screen that keeps its lines, a signer that must never be asked, a node over a
// world, and the world of wallets and fixtures that the node reads.
export { FakeClock, FakeNode, MemoryOutput, ThrowingSigner } from '../../../checks/test/support/fakes.ts';
export { World } from '../../../checks/test/support/world.ts';
