/**
 * ICE Locker transactions: lock AQUA until an unlock time, and withdraw
 * positions whose unlock time has passed.
 *
 * ABI: `create_lock(owner: Address, amount: u64, unlock_time: u64) -> u32`
 * (the new position id) and `withdraw(owner: Address, position_id: u32) -> u64`
 * (the amount paid out). The contract enforces the unlock-time rules: a
 * Monday 00:00 UTC, more than 24 hours ahead, at most three years ahead.
 *
 * Authorization is built client-side: `create_lock` authorizes the AQUA
 * transfer from the owner to the Locker beneath it; `withdraw` authorizes
 * the call alone, since the Locker pays out from its own balance.
 */

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { authorizedInvocation } from "./authorization.js";
import { BatchCall } from "./batch.js";
import { AquariusError, NoTrustlineError, contractErrorCode } from "./errors.js";

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

// The token contract's error for a balance below the transferred amount.
const TOKEN_BALANCE_ERROR = 10;

export interface CreateLockParams {
  /** AQUA to lock, in base units (stroops). */
  amount: bigint;
  /** Unix time in seconds at which the position unlocks. */
  unlockTime: bigint | number;
}

/** @internal `create_lock` arguments and its authorized invocation. */
export function createLockPlan(
  locker: string,
  token: string,
  owner: string,
  params: CreateLockParams,
): { args: xdr.ScVal[]; auth: xdr.SorobanAuthorizedInvocation } {
  const { amount, unlockTime } = params;
  if (typeof amount !== "bigint" || amount <= 0n || amount > U64_MAX) {
    throw new AquariusError("Lock amount must be a positive u64 bigint");
  }
  let unlock: bigint;
  if (typeof unlockTime === "bigint") {
    unlock = unlockTime;
  } else if (Number.isSafeInteger(unlockTime)) {
    unlock = BigInt(unlockTime);
  } else {
    throw new AquariusError("unlockTime must be an integer number of seconds");
  }
  if (unlock < 0n || unlock > U64_MAX) {
    throw new AquariusError("unlockTime must fit in u64");
  }
  const ownerScVal = new Address(owner).toScVal();
  const args = [
    ownerScVal,
    nativeToScVal(amount, { type: "u64" }),
    nativeToScVal(unlock, { type: "u64" }),
  ];
  const transfer = authorizedInvocation(token, "transfer", [
    ownerScVal,
    new Address(locker).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
  ]);
  return { args, auth: authorizedInvocation(locker, "create_lock", args, [transfer]) };
}

/**
 * @internal A `create_lock` failure in the owner's terms. The Locker's own
 * errors are 24xx; a missing trustline or a token error comes from the AQUA
 * transfer out of the owner's account.
 */
export function createLockError(error: unknown): unknown {
  if (error instanceof NoTrustlineError) {
    return new NoTrustlineError("The owner has no AQUA trustline — add it before locking AQUA");
  }
  if (contractErrorCode(error) === TOKEN_BALANCE_ERROR) {
    return new AquariusError("The owner's AQUA balance is below the lock amount");
  }
  return error;
}

/** @internal One `withdraw` call per position id, in the given order. */
export function withdrawCalls(
  locker: string,
  owner: string,
  positionIds: readonly number[],
): BatchCall[] {
  if (!Array.isArray(positionIds) || positionIds.length === 0) {
    throw new AquariusError("Pass at least one position id to withdraw");
  }
  for (const id of positionIds) {
    if (!Number.isInteger(id) || id < 0 || id > U32_MAX) {
      throw new AquariusError(`Invalid position id: ${String(id)}`);
    }
  }
  if (new Set(positionIds).size !== positionIds.length) {
    throw new AquariusError("Each position can be withdrawn only once per transaction");
  }
  const ownerScVal = new Address(owner).toScVal();
  return positionIds.map(id => ({
    contractId: locker,
    fn: "withdraw",
    args: [ownerScVal, xdr.ScVal.scvU32(id)],
  }));
}
