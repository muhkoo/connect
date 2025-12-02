// Shim for circom_runtime in Cloudflare Workers
// circom_runtime is only needed for proof generation (witness calculation)
// Since Workers only support verification, we stub this out

export function WitnessCalculatorBuilder(): never {
    throw new Error('Proof generation is not supported in Cloudflare Workers. Use verify() with pre-generated proofs.');
}

export default { WitnessCalculatorBuilder };
