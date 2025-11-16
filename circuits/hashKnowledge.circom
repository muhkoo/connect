pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

template HashKnowledge() {
    signal input secret;
    signal output hash;

    // Use Poseidon hash for the secret
    component hasher = Poseidon(1);
    hasher.inputs[0] <== secret;
    hash <== hasher.out;
}

component main = HashKnowledge();