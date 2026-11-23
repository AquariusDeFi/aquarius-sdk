/**
 * ICE delegation: an owner delegates a share of their upvoteICE and governICE
 * voting power to other accounts through the weighted delegation proxies.
 *
 * ABI (each proxy): `delegate(owner: Address, delegate: Address, fraction: u32)`
 * sets the share delegated to one account (replacing a previous share), and
 * `undelegate(owner: Address, delegate: Address)` removes it. Fractions are
 * parts of DELEGATION_FRACTION_DENOMINATOR (10_000_000 = 100%). The proxy
 * enforces the rules that depend on its state and configuration, such as the
 * number of delegates and the 100% total.
 *
 * Authorization is built client-side: each proxy call authorizes itself with
 * nothing beneath it. Changing both proxies goes through the batch contract,
 * with the proxy calls as sub-invocations of `batch`.
 */

import { Address, StrKey, xdr } from "@stellar/stellar-sdk";

import { BatchCall } from "./batch.js";
import { AquariusError, contractErrorCode } from "./errors.js";

/** The delegation proxies an owner can write to. */
export type IceProxy = "upvote" | "govern";

/** A fraction of this many parts is 100% of the owner's voting power. */
export const DELEGATION_FRACTION_DENOMINATOR = 10_000_000;

/** Proxies in the order their calls are encoded. */
const PROXY_ORDER: readonly IceProxy[] = ["govern", "upvote"];

// Weighted-proxy contract errors. Their codes overlap with other contracts'
// (the token contract's among them), so they are stated only for failures of
// the delegation builders.
const PROXY_ERRORS: Record<number, string> = {
  2: "this proxy's voting power cannot be delegated",
  3: "an owner cannot delegate to itself",
  5: "the owner's delegated shares on this proxy would exceed 100% in total",
  8: "the owner already has the most delegates this proxy allows; remove one first",
  9: "the fraction exceeds 100%",
  10: "the fraction must be greater than zero",
  19: "the ICE Locker holds no state for the owner; lock AQUA first",
};

export interface DelegateParams {
  /** The account receiving the delegated voting power (G...). */
  delegate: string;
  /** The share per proxy to set; proxies left out are not changed. */
  fractions: Partial<Record<IceProxy, number>>;
}

export interface UndelegateParams {
  /** The account whose delegation is removed. */
  delegate: string;
  /** The proxies to remove the delegation from. */
  proxies: readonly IceProxy[];
}

function selectProxies(proxies: readonly unknown[]): IceProxy[] {
  if (
    proxies.length === 0 ||
    new Set(proxies).size !== proxies.length ||
    proxies.some(proxy => proxy !== "upvote" && proxy !== "govern")
  ) {
    throw new AquariusError('Select the "upvote" proxy, the "govern" proxy, or both');
  }
  return PROXY_ORDER.filter(proxy => proxies.includes(proxy));
}

function delegationCall(
  contractId: string,
  fn: "delegate" | "undelegate",
  owner: string,
  delegate: string,
  fraction?: number,
): BatchCall {
  const args = [new Address(owner).toScVal(), new Address(delegate).toScVal()];
  if (fraction !== undefined) args.push(xdr.ScVal.scvU32(fraction));
  return { contractId, fn, args };
}

/** @internal One `delegate` call per selected proxy, in encoding order. */
export function delegateCalls(
  contracts: Record<IceProxy, string>,
  owner: string,
  params: DelegateParams,
): BatchCall[] {
  if (typeof params.delegate !== "string" || !StrKey.isValidEd25519PublicKey(params.delegate)) {
    throw new AquariusError("delegate must be a Stellar account address (G...)");
  }
  if (params.delegate === owner) {
    throw new AquariusError("You cannot delegate voting power to yourself");
  }
  const fractions = params.fractions ?? {};
  return selectProxies(Object.keys(fractions)).map(proxy => {
    const fraction = fractions[proxy];
    if (
      typeof fraction !== "number" ||
      !Number.isSafeInteger(fraction) ||
      fraction <= 0 ||
      fraction > DELEGATION_FRACTION_DENOMINATOR
    ) {
      throw new AquariusError(
        `The ${proxy} fraction must be an integer in 1..${DELEGATION_FRACTION_DENOMINATOR}`,
      );
    }
    return delegationCall(contracts[proxy], "delegate", owner, params.delegate, fraction);
  });
}

/** @internal One `undelegate` call per selected proxy, in encoding order. */
export function undelegateCalls(
  contracts: Record<IceProxy, string>,
  owner: string,
  params: UndelegateParams,
): BatchCall[] {
  const { delegate } = params;
  if (
    typeof delegate !== "string" ||
    !(StrKey.isValidEd25519PublicKey(delegate) || StrKey.isValidContract(delegate))
  ) {
    throw new AquariusError("delegate must be a Stellar address");
  }
  if (delegate === owner) {
    throw new AquariusError("delegate must differ from the owner");
  }
  if (!Array.isArray(params.proxies)) {
    throw new AquariusError('Select the "upvote" proxy, the "govern" proxy, or both');
  }
  return selectProxies(params.proxies).map(proxy =>
    delegationCall(contracts[proxy], "undelegate", owner, delegate),
  );
}

/** @internal A delegation build failure, with what a proxy error code means. */
export function delegationError(error: unknown): unknown {
  const code = contractErrorCode(error);
  const detail = code === undefined ? undefined : PROXY_ERRORS[code];
  return detail ? new AquariusError(`Contract error #${code}: ${detail}`) : error;
}
