import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ApiClient,
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

test("API HTTP failures raise typed errors and every request is time-bounded", async () => {
  const realFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (url, init) => {
    signals.push(init?.signal);
    return { ok: false, status: 503 };
  };
  try {
    const api = new ApiClient("https://api.invalid");
    await assert.rejects(
      api.findPath({ token_in_address: "a", token_out_address: "b", amount: "1" }, true),
      AquariusError,
    );
    await assert.rejects(api.poolsByAddresses(["CPOOL"]), AquariusError);
    await assert.rejects(api.userPools("GUSER"), AquariusError);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(signals.length, 3);
  assert.ok(signals.every(s => s instanceof AbortSignal));
});

test("toClassic on a contract-only asset raises the SDK's typed error", () => {
  assert.throws(() => Asset.contract("CABC").toClassic(), AquariusError);
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
  assert.ok(errorFromDiagnostics(diagFixture.events_xdr) instanceof NoTrustlineError);
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
  AquariusClient._requoteDelaysMs = [0, 1]; // keep the test fast
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

test("swap backs off between re-quote attempts, first retry immediate", async () => {
  // Asserts on the delays the client requests, not on wall-clock gaps —
  // measured timings flake on busy CI runners (mirrors the Python test,
  // which patches time.sleep the same way).
  AquariusClient._requoteDelaysMs = [0, 40];
  const client = new AquariusClient({ network: "testnet" });
  let quotes = 0;
  client.quote = async () => {
    quotes += 1;
    return {
      execute: async () => {
        throw new SlippageErrorDirect("guard breached");
      },
    };
  };
  const slept = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    slept.push(ms);
    return realSetTimeout(fn, 0);
  };
  try {
    await assert.rejects(
      client.swap({ from: XLM, to: XLM, amountIn: 1n, retries: 2 }),
      SlippageErrorDirect,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(quotes, 3); // initial attempt + 2 retries, each freshly quoted
  // No pause before the first retry, one escalated pause before the second;
  // nothing sleeps after the final attempt.
  assert.deepEqual(slept, [40]);
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

test("positions resolves pools concurrently and filters empty ones", async () => {
  const client = new AquariusClient({ network: "testnet" });
  client.api.userPools = async () => [
    { index: "00", address: "A", tokens_addresses: [] },
    { index: "01", address: "B", tokens_addresses: [] },
    { index: "02", address: "C", tokens_addresses: [] },
  ];
  const balances = { A: 5n, B: 0n, C: 7n };
  let inFlight = 0;
  let peak = 0;
  client.makePool = async (hash, address) => ({
    address,
    shareBalance: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight -= 1;
      return balances[address];
    },
  });
  const positions = await client.positions("GHOLDER");
  assert.deepEqual(
    positions.map(p => [p.pool.address, p.shares]),
    [["A", 5n], ["C", 7n]], // input order kept, empty position dropped
  );
  assert.ok(peak > 1); // the per-pool read chains overlapped
});
