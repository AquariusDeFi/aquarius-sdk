import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

import { LIMIT_ORDER_MAX_TTL_LEDGERS } from "./limit-order-types.js";
import { AquariusError } from "./errors.js";

// SEP-41 allowance() returns only an amount. Read the logical deadline from
// SAC / Aquarius token storage, not the entry TTL (which can outlive a grant).
// Unknown storage layouts fail closed when the caller compares with allowance().
export const readTokenAllowances = async (
  connection: Pick<rpc.Server, "getLedgerEntries">,
  tokens: string[],
  maker: string,
  spender: string,
) => {
  const allowanceKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Allowance"),
    xdr.ScVal.scvMap(
      [
        ["from", maker],
        ["spender", spender],
      ].map(
        ([name, address]) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(name),
            val: new Address(address).toScVal(),
          }),
      ),
    ),
  ]);
  const keys = tokens.map((token) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(token).toScAddress(),
        key: allowanceKey,
        durability: xdr.ContractDataDurability.temporary,
      }),
    ),
  );
  const { entries, latestLedger } = await connection.getLedgerEntries(...keys);
  const invalid = () =>
    new AquariusError("Could not verify the current token allowance and expiry.");
  if (
    !Number.isInteger(latestLedger) ||
    latestLedger < 0 ||
    latestLedger > 0xffffffff ||
    !Array.isArray(entries)
  )
    throw invalid();
  const requested = new Set(keys.map((key) => key.toXDR("base64")));
  const grants = new Map<string, { amount: bigint; expiration: number }>();
  for (const entry of entries) {
    const id = entry.key.toXDR("base64");
    if (!requested.has(id) || grants.has(id)) throw invalid();
    if (entry.val.type !== "contractData") throw invalid();
    const data = entry.val.contractData;
    const actualKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: data.contract,
        key: data.key,
        durability: data.durability,
      }),
    );
    if (actualKey.toXDR("base64") !== entry.key.toXDR("base64")) throw invalid();
    if (data.val.type !== "scvMap") throw invalid();
    const fields = data.val.map;
    if (
      fields?.length !== 2 ||
      fields[0].key.type !== "scvSymbol" ||
      fields[1].key.type !== "scvSymbol" ||
      fields[0].key.sym.toString() !== "amount" ||
      !["live_until_ledger", "expiration_ledger"].includes(fields[1].key.sym.toString()) ||
      fields[0].val.type !== "scvI128" ||
      fields[1].val.type !== "scvU32"
    )
      throw invalid();
    const amount: bigint = scValToNative(fields[0].val);
    const expiration = fields[1].val.u32;
    if (
      amount < 0n ||
      expiration > latestLedger + LIMIT_ORDER_MAX_TTL_LEDGERS ||
      typeof entry.liveUntilLedgerSeq !== "number" ||
      !Number.isInteger(entry.liveUntilLedgerSeq) ||
      entry.liveUntilLedgerSeq < latestLedger ||
      (amount > 0n && entry.liveUntilLedgerSeq < expiration)
    )
      throw invalid();
    grants.set(
      id,
      expiration < latestLedger ? { amount: 0n, expiration: 0 } : { amount, expiration },
    );
  }
  return {
    latestLedger,
    allowances: keys.map((key) => grants.get(key.toXDR("base64")) ?? { amount: 0n, expiration: 0 }),
  };
};
