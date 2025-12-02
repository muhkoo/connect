// Workers-compatible shim for @zk-kit/groth16
// Only exports verify and buildBn128 - excludes prove() which requires
// @iden3/binfileutils and fastfile (file system operations not available in Workers)

// Import directly from the source files to avoid pulling in prove.ts
// The ffjavascript imports in these files will be intercepted by our ffjavascript alias
export { default as verify } from '../../../node_modules/@zk-kit/groth16/src/verify';
export { default as buildBn128 } from '../../../node_modules/@zk-kit/groth16/src/buildBn128';
export * from '../../../node_modules/@zk-kit/groth16/src/types';
