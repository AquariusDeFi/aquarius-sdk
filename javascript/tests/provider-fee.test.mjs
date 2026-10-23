import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Address, Keypair, scValToNative, StrKey } from "@stellar/stellar-sdk";
import {
  AquariusClient,
  AquariusError,
  Asset,
  XLM,
} from "../dist/index.js";


const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const XLM_ID = XLM.contractId(TESTNET_PASSPHRASE);
const COLLECTOR_ID = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const fixture = JSON.parse(
  readFileSync(new URL("../../testdata/find_path_testnet_xlm_aqua.json", import.meta.url), "utf8"),
);


async function captureOperation(client, quote) {
  let operation;
  client.engine.prepare = async (_source, buildOperation) => {
    operation = buildOperation();
    return { toXDR: () => "unsigned-xdr" };
  };
  assert.equal(await quote.buildTransaction(), "unsigned-xdr");
  return operation;
}


function decodeOperation(operation) {
  const invokeOp = operation.body.invokeHostFunctionOp;
  const invoke = invokeOp.hostFunction.invokeContract;
  const root = invokeOp.auth[0].rootInvocation;
  const rootFn = root.function.contractFn;
  const transferFn = root.subInvocations[0].function.contractFn;
  return {
    contractId: Address.fromScAddress(invoke.contractAddress).toString(),
    functionName: invoke.functionName.toString(),
    args: invoke.args.map(scValToNative),
    rootContractId: Address.fromScAddress(rootFn.contractAddress).toString(),
    transferTo: scValToNative(transferFn.args[1]),
    transferAmount: scValToNative(transferFn.args[2]),
  };
}


test("provider fee config rejects values outside the contract domain", async () => {
  const invalid = [
    { feeFraction: -1, feeDenominator: 10_000 },
    { feeFraction: 30, feeDenominator: 0 },
    { feeFraction: 10_000, feeDenominator: 10_000 },
    { feeFraction: 2 ** 32, feeDenominator: 2 ** 32 + 1 },
    { feeFraction: 1, feeDenominator: 2 ** 32 },
  ];
  for (const values of invalid) {
    const client = new AquariusClient({ network: "testnet" });
    client.api.findPath = async () => {
      throw new Error("provider fee validation must run before the API request");
    };
    await assert.rejects(
      client.quote({
        from: XLM,
        to: AQUA,
        amountIn: 1n,
        providerFee: { contractId: COLLECTOR_ID, ...values },
      }),
      AquariusError,
    );
  }
});


test("exact-input provider quote and destination invocation use net amounts", async () => {
  const sender = Keypair.random();
  const recipient = Keypair.random().publicKey();
  const client = new AquariusClient({ network: "testnet", signer: sender });
  const requests = [];
  client.api.findPath = async (request, exactInput) => {
    requests.push([request, exactInput]);
    return { ...fixture, amount: "1000" };
  };
  const providerFee = {
    contractId: COLLECTOR_ID,
    feeFraction: 30,
    feeDenominator: 10_000,
    recipient,
  };

  const quote = await client.quote({
    from: XLM,
    to: AQUA,
    amountIn: 100n,
    slippage: 0.01,
    providerFee,
  });

  assert.equal(requests[0][0].amount, "100");
  assert.equal(requests[0][1], true);
  assert.equal(quote.amountOut, 997n);
  assert.equal(quote.guard, 987n);

  providerFee.contractId = client.network.router;
  providerFee.feeFraction = 3_000;
  providerFee.recipient = Keypair.random().publicKey();

  const operation = decodeOperation(await captureOperation(client, quote));
  assert.equal(operation.contractId, COLLECTOR_ID);
  assert.equal(operation.functionName, "swap_chained_to");
  assert.equal(operation.args.length, 7);
  assert.equal(operation.args[0], sender.publicKey());
  assert.equal(operation.args[1], recipient);
  assert.equal(operation.args[3], XLM_ID);
  assert.equal(operation.args[4], 100n);
  assert.equal(operation.args[5], 987n);
  assert.equal(operation.args[6], 30);
  assert.equal(operation.rootContractId, COLLECTOR_ID);
  assert.equal(operation.transferTo, COLLECTOR_ID);
  assert.equal(operation.transferAmount, 100n);
});


test("exact-output provider quote grosses up route and uses the legacy collector method", async () => {
  const sender = Keypair.random();
  const client = new AquariusClient({ network: "testnet", signer: sender });
  const requests = [];
  client.api.findPath = async (request, exactInput) => {
    requests.push([request, exactInput]);
    return { ...fixture, amount: "999" };
  };

  const quote = await client.quote({
    from: XLM,
    to: AQUA,
    amountOut: 997n,
    slippage: 0.01,
    providerFee: {
      contractId: COLLECTOR_ID,
      feeFraction: 30,
      feeDenominator: 10_000,
    },
  });

  assert.equal(requests[0][0].amount, "1000");
  assert.equal(requests[0][1], false);
  assert.equal(quote.amountIn, 999n);
  assert.equal(quote.amountOut, 997n);
  assert.equal(quote.guard, 1009n);

  const operation = decodeOperation(await captureOperation(client, quote));
  assert.equal(operation.contractId, COLLECTOR_ID);
  assert.equal(operation.functionName, "swap_chained_strict_receive");
  assert.equal(operation.args.length, 6);
  assert.equal(operation.args[0], sender.publicKey());
  assert.equal(operation.args[2], XLM_ID);
  assert.equal(operation.args[3], 997n);
  assert.equal(operation.args[4], 1009n);
  assert.equal(operation.args[5], 30);
  assert.equal(operation.rootContractId, COLLECTOR_ID);
  assert.equal(operation.transferTo, COLLECTOR_ID);
  assert.equal(operation.transferAmount, 1009n);
});


test("exact-output destination uses the redirected collector ABI", async () => {
  const sender = Keypair.random();
  const recipient = Keypair.random().publicKey();
  const client = new AquariusClient({ network: "testnet", signer: sender });
  client.api.findPath = async () => ({ ...fixture, amount: "999" });

  const quote = await client.quote({
    from: XLM,
    to: AQUA,
    amountOut: 997n,
    providerFee: {
      contractId: COLLECTOR_ID,
      feeFraction: 30,
      feeDenominator: 10_000,
      recipient,
    },
  });
  const operation = decodeOperation(await captureOperation(client, quote));

  assert.equal(operation.contractId, COLLECTOR_ID);
  assert.equal(operation.functionName, "swap_chained_strict_receive_to");
  assert.equal(operation.args.length, 7);
  assert.equal(operation.args[0], sender.publicKey());
  assert.equal(operation.args[1], recipient);
  assert.equal(operation.args[3], XLM_ID);
  assert.equal(operation.args[4], 997n);
  assert.equal(operation.args[5], 1009n);
  assert.equal(operation.args[6], 30);
  assert.equal(operation.rootContractId, COLLECTOR_ID);
  assert.equal(operation.transferTo, COLLECTOR_ID);
  assert.equal(operation.transferAmount, 1009n);
});


test("direct swap keeps targeting and authorizing the router", async () => {
  const sender = Keypair.random();
  const client = new AquariusClient({ network: "testnet", signer: sender });
  client.api.findPath = async () => ({ ...fixture, amount: "1000" });

  const quote = await client.quote({ from: XLM, to: AQUA, amountIn: 100n });
  const operation = decodeOperation(await captureOperation(client, quote));

  assert.equal(operation.contractId, client.network.router);
  assert.equal(operation.functionName, "swap_chained");
  assert.equal(operation.args.length, 5);
  assert.equal(operation.rootContractId, client.network.router);
  assert.equal(operation.transferTo, client.network.router);
  assert.equal(operation.transferAmount, 100n);
});
