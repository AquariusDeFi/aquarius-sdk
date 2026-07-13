import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AquariusError, Asset, Pool, XLM, sortTokenIds } from "../dist/index.js";
import { parsePoolMeta, resolveAmounts } from "../dist/pool.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");

const XLM_ID = XLM.contractId(TESTNET_PASSPHRASE);
const AQUA_ID = AQUA.contractId(TESTNET_PASSPHRASE);
const SORTED_PAIR = sortTokenIds([AQUA_ID, XLM_ID]);

const poolsFixture = JSON.parse(
  readFileSync(new URL("../../testdata/pools_by_address_testnet.json", import.meta.url), "utf8"),
);

test("token ordering matches the contract rule and is input-order independent", () => {
  assert.deepEqual(sortTokenIds([XLM_ID, AQUA_ID]), SORTED_PAIR);
  assert.deepEqual(sortTokenIds([AQUA_ID, XLM_ID]), SORTED_PAIR);
});

test("resolveAmounts accepts asset entries, id entries, and positional lists", () => {
  const byAsset = resolveAmounts([[XLM, 5n], [AQUA, 7n]], SORTED_PAIR, TESTNET_PASSPHRASE);
  const byId = resolveAmounts([[XLM_ID, 5n], [AQUA_ID, 7n]], SORTED_PAIR, TESTNET_PASSPHRASE);
  assert.deepEqual(byAsset, byId);
  assert.deepEqual([...byAsset].sort(), [5n, 7n]);
  assert.deepEqual(resolveAmounts(byAsset, SORTED_PAIR, TESTNET_PASSPHRASE), byAsset);
  // missing tokens default to zero
  assert.ok(resolveAmounts([[XLM, 5n]], SORTED_PAIR, TESTNET_PASSPHRASE).includes(0n));
});

test("resolveAmounts rejects foreign tokens and bad lengths", () => {
  assert.throws(
    () => resolveAmounts([[Asset.contract("CFOREIGN"), 1n]], SORTED_PAIR, TESTNET_PASSPHRASE),
    AquariusError,
  );
  assert.throws(() => resolveAmounts([1n], SORTED_PAIR, TESTNET_PASSPHRASE), AquariusError);
});

test("pool metadata from the API fixture parses into docs terms", () => {
  const entry = poolsFixture.results[0];
  const parsed = parsePoolMeta(entry);
  assert.equal(parsed.type, "volatile"); // constant_product maps to the docs name
  assert.equal(parsed.feeBps, 30); // "0.0030"
  assert.equal(parsed.labels[0], "native");
});

test("concentrated deposit is blocked before any network call", async () => {
  const pool = new Pool(
    "CPOOL",
    new Uint8Array(32),
    "concentrated",
    30,
    SORTED_PAIR,
    [],
    /* ctx would explode if any network path were reached */ null,
  );
  await assert.rejects(pool.deposit({ amounts: [[XLM, 1n]] }), /full-range/);
});
