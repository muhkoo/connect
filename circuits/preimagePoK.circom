pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

template PreimagePoK() {
    // Public inputs
    signal input commitment;
    signal input nonce;
    signal input ecdsaPubHash;

    // Private inputs
    signal input secret;
    signal input salt;
    signal input ecdsaPub;

    // Calculate ecdsaPub hash and verify it matches the public input
    component ecdsaHasher = Poseidon(1);
    ecdsaHasher.inputs[0] <== ecdsaPub;
    ecdsaPubHash === ecdsaHasher.out;

    // Calculate commitment and verify it matches the public input
    component commitmentHasher = Poseidon(3);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== salt;
    commitmentHasher.inputs[2] <== ecdsaHasher.out;
    commitment === commitmentHasher.out;

    // The nonce is just passed through as a public signal for binding
    signal nonceCheck;
    nonceCheck <== nonce * 1;
}

component main {public [commitment, nonce, ecdsaPubHash]} = PreimagePoK();