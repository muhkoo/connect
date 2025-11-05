const { parentPort } = require("worker_threads");
const { encode, reconstruct } = require("wasm-reed-solomon-erasure");

function assertType(value, type) {
  if (typeof value !== type) {
    throw new Error(`Expected type ${type}, received ${typeof value}`);
  }
}

class WorkerMessage {
  type;
  data;
  constructor(type, data) {
    assertType(type, "string");
    assertType(data, "object");
    assertType(data.shardsCount, "number");
    assertType(data.parityShards, "number");
    if (!(data.deadSharedIndexes instanceof Array)) {
      throw new Error("WorkerMessage: data.deadSharedIndexes must be an array");
    }
    if (
      typeof data.buffer === "undefined" &&
      typeof data.shards === "undefined"
    ) {
      throw new Error(
        "WorkerMessage: data.buffer or data.shards must be defined"
      );
    }
    this.type = type;
    this.data = data;
  }
}

const encoder = (buf, shardsCount = 10, parityShards = 2) => {
  const dataShards = shardsCount - parityShards;

  const input = new Uint8Array(buf);

  const shardSize = Math.ceil(input.length / dataShards);
  const shardData = [];

  for (let i = 0; i < dataShards; i++) {
    const array = new Uint8Array(shardSize);
    shardData.push(array);
  }

  for (let i = 0; i < input.length; i++) {
    const j = Math.floor(i / shardSize);
    const k = i % shardSize;
    shardData[j][k] = input[i];
  }

  return encode(shardData, parityShards);
};

const decoder = (shards, parityShards, deadSharedIndexes) => {
  const result = reconstruct(
    shards,
    parityShards,
    new Uint32Array(deadSharedIndexes)
  );

  const flatten = [];
  const dataShards = shards.length - parityShards;
  for (let i = 0; i < dataShards; i++) {
    for (const v of result[i]) flatten.push(v);
  }
  return Buffer.from(flatten);
};

parentPort.on("message", (message) => {
  try {
    assertType(message, "object");
    assertType(message.type, "string");
    assertType(message.data, "object");
    assertType(message.data.shardsCount, "number");
    assertType(message.data.parityShards, "number");

    switch (message.type) {
      case "encode":
        if (typeof message.data.buffer === "undefined") {
          throw new Error("WorkerMessage: data.buffer must be defined");
        }
        const encoded = encoder(
          message.data.buffer,
          message.data.shardsCount,
          message.data.parityShards
        );
        const _e_res = {
          type: "encoded",
          data: new WorkerMessage("encoded", {
            shards: encoded,
            parityShards: message.data.parityShards,
            shardsCount: message.data.shardsCount,
            deadSharedIndexes: message.data.deadSharedIndexes,
          }),
        };
        parentPort.postMessage(_e_res);
        break;
      case "decode":
        if (typeof message.data.shards === "undefined") {
          throw new Error("WorkerMessage: data.shards must be defined");
        }
        const decoded = decoder(
          message.data.shards,
          message.data.parityShards,
          message.data.deadSharedIndexes
        );
        const _d_res = {
          type: "decoded",
          data: new WorkerMessage("decoded", {
            buffer: decoded,
            parityShards: message.data.parityShards,
            shardsCount: message.data.shardsCount,
            deadSharedIndexes: message.data.deadSharedIndexes,
          }),
        };
        parentPort.postMessage(_d_res);
        break;
      default:
        throw new Error("Unknown message type");
    }
  } catch (e) {
    if (e instanceof Error) {
      parentPort.postMessage({
        type: "error",
        data: e.message,
      });
    } else {
      parentPort.postMessage({
        type: "error",
        data: "Unknown error",
      });
    }
  }
});
