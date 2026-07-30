import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AquariusClient,
  AquariusError,
  Asset,
  NoRouteError,
  PausedError,
  SlippageError,
  XLM,
  parseFindPathResponse,
} from "../dist/index.js";
import { NoTrustlineError, SlippageError as SlippageErrorDirect, StaleSimulationError } from "../dist/index.js";
import { classifyContractError, errorFromDiagnostics, isUserRejection } from "../dist/errors.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");

const fixture = JSON.parse(
  readFileSync(new URL("../../testdata/find_path_testnet_xlm_aqua.json", import.meta.url), "utf8"),
);

test("asset forms resolve to known contract IDs", () => {
  assert.equal(
    XLM.contractId(TESTNET_PASSPHRASE),
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  );
  assert.equal(
    AQUA.contractId(TESTNET_PASSPHRASE),
    "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE",
  );
  assert.equal(Asset.contract("CABC").contractId(TESTNET_PASSPHRASE), "CABC");
});

test("golden fixture parses into an exact-input quote", () => {
  const parsed = parseFindPathResponse(fixture, {
    amountIn: 100_000_000n,
    slippageBps: 100,
    pairLabel: "XLM -> AQUA",
  });
  assert.equal(parsed.amountIn, 100_000_000n);
  assert.equal(parsed.amountOut, BigInt(fixture.amount));
  assert.equal(parsed.guard, (BigInt(fixture.amount) * 9_900n) / 10_000n);
  assert.deepEqual(parsed.route, fixture.pools);
  assert.equal(parsed.swapChainXdr, fixture.swap_chain_xdr);
});

test("exact-output guard rounds up, never in the caller's favor", () => {
  const parsed = parseFindPathResponse(
    { ...fixture, amount: "999" },
    { amountOut: 5_000n, slippageBps: 100, pairLabel: "XLM -> AQUA" },
  );
  assert.equal(parsed.amountIn, 999n);
  assert.equal(parsed.amountOut, 5_000n);
  assert.equal(parsed.guard, 1_009n); // ceil(999 * 1.01)
});

test("no route raises the typed error", () => {
  assert.throws(
    () =>
      parseFindPathResponse(
        { success: false },
        { amountIn: 1n, slippageBps: 100, pairLabel: "XLM -> AQUA" },
      ),
    NoRouteError,
  );
});

test("quote requires exactly one amount", async () => {
  const client = new AquariusClient({ network: "testnet" });
  await assert.rejects(client.quote({ from: XLM, to: AQUA }), AquariusError);
  await assert.rejects(
    client.quote({ from: XLM, to: AQUA, amountIn: 1n, amountOut: 1n }),
    AquariusError,
  );
});

test("contract errors classify into typed errors", () => {
  assert.ok(classifyContractError("HostError: Error(Contract, #2006)") instanceof SlippageError);
  assert.ok(classifyContractError("HostError: Error(Contract, #2020)") instanceof SlippageError);
  assert.ok(classifyContractError("HostError: Error(Contract, #206)") instanceof PausedError);
  assert.ok(classifyContractError("Error(Budget, ExceededLimit)") instanceof AquariusError);
  assert.equal(classifyContractError("something unrelated"), null);
  assert.equal(classifyContractError("Error(Contract, #301)").message, "Contract error #301");
});

test("wallet rejections are recognized across signers", () => {
  assert.ok(isUserRejection(new Error("The user rejected this request.")));
  assert.ok(isUserRejection(new Error("cancelled_by_user")));
  assert.ok(!isUserRejection(new Error("tx_bad_seq")));
});


const diagFixture = JSON.parse(
  readFileSync(
    new URL("../../testdata/diagnostic_events_missing_trustline.json", import.meta.url),
    "utf8",
  ),
);

test("diagnostics detect a missing trustline", () => {
  const error = errorFromDiagnostics(diagFixture.events_xdr);
  assert.ok(error instanceof NoTrustlineError);
  assert.match(error.message, /output recipient/);
  assert.doesNotMatch(error.message, /ensureTrustline/);
});

test("diagnostics fall back to the contract error code", () => {
  const withoutTrustline = diagFixture.events_xdr.filter(
    e => !Buffer.from(e, "base64").includes("trustline entry is missing"),
  );
  const error = errorFromDiagnostics(withoutTrustline);
  assert.ok(error);
  assert.match(error.message, /#13/);
});

test("trustline marker wins over contract code", () => {
  const message = "HostError: Error(Contract, #2006)\n... trustline entry is missing for account ...";
  assert.ok(classifyContractError(message) instanceof NoTrustlineError);
});

test("timeout resolution follows the signer type", async () => {
  const { Keypair } = await import("@stellar/stellar-sdk");
  assert.equal(
    new AquariusClient({ network: "testnet", signer: Keypair.random() }).engine.timeoutSeconds,
    300,
  );
  assert.equal(new AquariusClient({ network: "testnet" }).engine.timeoutSeconds, null);
  assert.equal(
    new AquariusClient({ network: "testnet", timeoutSeconds: 120 }).engine.timeoutSeconds,
    120,
  );
  assert.equal(
    new AquariusClient({ network: "testnet", signer: Keypair.random(), timeoutSeconds: "infinite" })
      .engine.timeoutSeconds,
    null,
  );
});

test("swap retries re-quote on slippage", async () => {
  const client = new AquariusClient({ network: "testnet" });
  let attempts = 0;
  client.quote = async () => ({
    execute: async () => {
      attempts += 1;
      if (attempts < 3) throw new SlippageErrorDirect("moved");
      return "receipt";
    },
  });
  assert.equal(await client.swap({ from: XLM, to: XLM, amountIn: 1n, retries: 2 }), "receipt");
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    client.swap({ from: XLM, to: XLM, amountIn: 1n, retries: 1 }),
    SlippageErrorDirect,
  );
  assert.equal(attempts, 2);
});

test("buffer import present for diagnostics", () => {
  assert.ok(Buffer.isBuffer(Buffer.from("dGVzdA==", "base64")));
});


const footprintFixture = JSON.parse(
  readFileSync(
    new URL("../../testdata/diagnostic_events_footprint_withdraw.json", import.meta.url),
    "utf8",
  ),
);

test("handled probe errors do not drive the diagnosis", () => {
  // The footprint fixture contains a handled trustline probe before the
  // fatal storage error - the diagnosis must report the storage failure.
  assert.ok(errorFromDiagnostics(footprintFixture.events_xdr) instanceof StaleSimulationError);
});
