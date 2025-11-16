declare module 'snarkjs' {
    export interface Groth16 {
        fullProve(
            input: any,
            wasmPath: string,
            zkeyPath: string
        ): Promise<{
            proof: {
                pi_a: string[];
                pi_b: string[][];
                pi_c: string[];
                protocol: string;
                curve: string;
            };
            publicSignals: string[];
        }>;

        prove(
            zkeyPath: string,
            witnessBuffer: Uint8Array
        ): Promise<{
            proof: {
                pi_a: string[];
                pi_b: string[][];
                pi_c: string[];
                protocol: string;
                curve: string;
            };
            publicSignals: string[];
        }>;

        verify(
            verificationKey: any,
            publicSignals: string[],
            proof: any
        ): Promise<boolean>;

        exportSolidityCallData(
            proof: any,
            publicSignals: string[]
        ): Promise<string>;
    }

    export interface Plonk {
        fullProve(
            input: any,
            wasmPath: string,
            zkeyPath: string
        ): Promise<{
            proof: any;
            publicSignals: string[];
        }>;

        prove(
            zkeyPath: string,
            witnessBuffer: Uint8Array
        ): Promise<{
            proof: any;
            publicSignals: string[];
        }>;

        verify(
            verificationKey: any,
            publicSignals: string[],
            proof: any
        ): Promise<boolean>;
    }

    export const groth16: Groth16;
    export const plonk: Plonk;

    export function wtns: {
        calculate(
            input: any,
            wasmPath: string
        ): Promise<Uint8Array>;

        exportJson(witness: Uint8Array): any;
    };

    export function zKey: {
        exportVerificationKey(zkeyPath: string): Promise<any>;
        exportSolidityVerifier(
            zkeyPath: string,
            templatePath?: string
        ): Promise<string>;
        newZKey(
            r1csPath: string,
            ptauPath: string,
            zkeyPath: string,
            logger?: any
        ): Promise<void>;
        contribute(
            zkeyOldPath: string,
            zkeyNewPath: string,
            name: string,
            entropy?: string
        ): Promise<string>;
        beacon(
            zkeyOldPath: string,
            zkeyNewPath: string,
            name: string,
            beaconHash: string,
            numIterations: number
        ): Promise<void>;
        verifyFromR1cs(
            r1csPath: string,
            ptauPath: string,
            zkeyPath: string,
            logger?: any
        ): Promise<boolean>;
        verifyFromInit(
            initZkeyPath: string,
            ptauPath: string,
            zkeyPath: string,
            logger?: any
        ): Promise<boolean>;
    };

    export function powersOfTau: {
        newAccumulator(
            curve: string,
            power: number,
            ceremonyPower: number
        ): Promise<void>;
        exportChallenge(
            ptauPath: string,
            challengePath: string,
            logger?: any
        ): Promise<void>;
        importResponse(
            oldPtauPath: string,
            responsePath: string,
            newPtauPath: string,
            name: string,
            importPoints?: boolean,
            logger?: any
        ): Promise<void>;
        verify(
            ptauPath: string,
            logger?: any
        ): Promise<boolean>;
        beacon(
            oldPtauPath: string,
            newPtauPath: string,
            name: string,
            beaconHash: string,
            numIterations: number,
            logger?: any
        ): Promise<void>;
        contribute(
            oldPtauPath: string,
            newPtauPath: string,
            name: string,
            entropy?: string,
            logger?: any
        ): Promise<string>;
        preparePhase2(
            oldPtauPath: string,
            newPtauPath: string,
            logger?: any
        ): Promise<void>;
    };

    export function r1cs: {
        info(
            r1csPath: string,
            logger?: any
        ): Promise<any>;
        print(
            r1cs: any,
            syms: any,
            logger?: any
        ): void;
        exportJson(
            r1csPath: string,
            logger?: any
        ): Promise<any>;
    };
}