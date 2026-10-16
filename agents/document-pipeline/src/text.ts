// agents/document-pipeline/src/text.ts
// clip, from the one module of packages/service-kit that has no imports: src/request.ts takes it from here, src/render.ts loads src/request.ts (its
// RequestError), and the renderer must not load the fetch of a source (test/source.test.ts).
export { clip } from '@vsa/service-kit/text';
