import { IpfsStorage } from '../../src/storage/IpfsStorage';
import HeliaNode from '../../../src/network/ipfs/HeliaNode';
import DaemonNode from '../../../src/network/ipfs/DaemonNode';
// import { IPFSConfig } from '../../src/network/ipfs/ipfs';

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import DBlibSQL from '../../src/databases/sql/libSQL';

function generateRandomContent(sizeInBytes: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = '';
    for (let i = 0; i < sizeInBytes; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

const nodeConfig: any = {

    Bootstrap: [
        "/ip4/192.168.1.42/tcp/4001/p2p/12D3KooWBNtU55fyA8BpbmCQ6RGym9SCVS6KA1f8eFWTS7sbFtZD",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
        "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
        "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
        "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    ]

}

describe('IpfsStorage', () => {
    it('should create a new IpfsStorage instance', async () => {
        const heilianode = new HeliaNode(nodeConfig);
        await heilianode.ready;
        const db = new DBlibSQL();
        const storage = new IpfsStorage(heilianode, db);
        expect(storage).toBeDefined();
        expect(storage).not.toBeNull();
        expect(storage).toBeInstanceOf(IpfsStorage);
    });

    it('Writes a file using IPFS', async () => {
        const sizeInMB = 1; // Specify size in MB
        const sizeInBytes = sizeInMB * 1024 * 1024; // Convert to bytes
        const content = generateRandomContent(sizeInBytes);
        const db = new DBlibSQL();
        const node = new DaemonNode(nodeConfig);
        await node.ready;
        const storage = new IpfsStorage(node, db);
        const file = new File([content], "test.txt", { type: "text/plain" });
        const ipfsPointer = await storage.write(file);

        fs.writeFileSync(path.join(__dirname, "cid.txt"), ipfsPointer);
        expect(ipfsPointer).toMatch(/(Qm[a-zA-Z0-9]{44}|bafk[a-zA-Z0-9]{56})/);

        // console.log(ipfsPointer.serialize());
    })

    it('Reads a file using IPFS', async () => {
        let ipfsPointer: string | null = null;
        while (!ipfsPointer) {
            console.log("Waiting for CID to be written to file...");
            ipfsPointer = fs.readFileSync(path.join(__dirname, "cid.txt")).toString();
            console.log(ipfsPointer);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const node = new DaemonNode(nodeConfig);
        await node.ready;
        const db = new DBlibSQL();
        const storage = new IpfsStorage(node, db);
        const buffer = await storage.read(ipfsPointer);
        expect(buffer).toBeInstanceOf(ArrayBuffer);

    }, 15000)
});