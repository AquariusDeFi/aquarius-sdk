/**
 * The batch contract: several contract calls in one transaction, under one
 * signature. Used for atomic combinations the router has no single entry
 * point for — trustline + swap, withdraw + claim, create pool + first
 * deposit, claim across pools — and, in simulation, for reading many values
 * in one RPC round-trip.
 *
 * ABI: `batch(Vec<Address> authorizers, Vec<(Address, Symbol, Vec<Val>)> calls,
 * bool return_results) -> Vec<Val>`. The auth tree is built client-side:
 * `batch` at the root, each call's own invocation (with its transfers or
 * burns) as a sub-invocation — so wallets show exactly what is authorized.
 */

import { Address, Operation, xdr } from "@stellar/stellar-sdk";

import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import { AquariusError, ResourceLimitError } from "./errors.js";

/** One call inside a batch. */
export interface BatchCall {
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
}

export function batchCallScVal(call: BatchCall): xdr.ScVal {
  return xdr.ScVal.scvVec([
    new Address(call.contractId).toScVal(),
    xdr.ScVal.scvSymbol(call.fn),
    xdr.ScVal.scvVec(call.args),
  ]);
}

export function batchArgs(user: string, calls: BatchCall[], returnResults: boolean): xdr.ScVal[] {
  return [
    xdr.ScVal.scvVec([new Address(user).toScVal()]),
    xdr.ScVal.scvVec(calls.map(batchCallScVal)),
    xdr.ScVal.scvBool(returnResults),
  ];
}

/**
 * A batch invocation with a client-built authorization tree. `subInvocations`
 * are the authorized invocations of the individual calls, in call order.
 */
export function batchOperation(
  batchId: string,
  user: string,
  calls: BatchCall[],
  subInvocations: xdr.SorobanAuthorizedInvocation[],
  returnResults: boolean,
): xdr.Operation {
  const args = batchArgs(user, calls, returnResults);
  return Operation.invokeContractFunction({
    contract: batchId,
    function: "batch",
    args,
    auth: [sourceAccountEntry(authorizedInvocation(batchId, "batch", args, subInvocations))],
  });
}

/** Unpack a `return_results = true` batch: one value per call, in call order. */
export function batchResults(retval: xdr.ScVal | undefined, expected: number): xdr.ScVal[] {
  if (!retval || retval.type !== "scvVec" || (retval.vec ?? []).length !== expected) {
    throw new AquariusError(
      `Unexpected batch result: expected ${expected} values. Inspect the transaction before retrying.`,
    );
  }
  return retval.vec!;
}

/** The simulation budget is bounded; a batch that overflows it is split. */
export function isBudgetExceeded(error: unknown): boolean {
  return error instanceof ResourceLimitError ||
    (error instanceof Error && error.message.includes("ExceededLimit"));
}
