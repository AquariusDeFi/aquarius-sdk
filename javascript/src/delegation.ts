/**
 * ICE delegation: an owner delegates a share of their upvoteICE and governICE
 * voting power to other accounts through the weighted delegation proxies.
 *
 * ABI (each proxy): `delegate(owner: Address, delegate: Address, fraction: u32)`
 * sets the share delegated to one account (replacing a previous share),
 * `undelegate(owner: Address, delegate: Address)` removes it, and
 * `delegations(owner) -> Vec<(Address, u32, u64)>` lists the current shares.
 * Fractions are parts of DELEGATION_FRACTION_DENOMINATOR (10_000_000 = 100%).
 *
 * Authorization is built client-side: each proxy call authorizes itself with
 * nothing beneath it. Changing both proxies goes through the batch contract,
 * with the proxy calls as sub-invocations of `batch`.
 */

import { Address, StrKey, xdr } from "@stellar/stellar-sdk";

import { BatchCall } from "./batch.js";
import { AquariusError } from "./errors.js";

/** The delegation proxies an owner can write to. */
export type IceProxy = "upvote" | "govern";

/** A fraction of this many parts is 100% of the owner's voting power. */
export const DELEGATION_FRACTION_DENOMINATOR = 10_000_000;

/** Delegates per proxy and owner, as enforced by the proxy contract. */
export const MAX_DELEGATES_PER_PROXY = 2;

/** Proxies in the order their calls are encoded. */
const PROXY_ORDER: readonly IceProxy[] = ["govern", "upvote"];

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

/** @internal One current delegation of an owner on one proxy. */
export interface DelegationEdge {
  delegate: string;
  fraction: number;
}

function fail(): never {
  throw new AquariusError("Unexpected delegations response from the proxy");
}

/** @internal Parse a proxy's `delegations(owner)` result. */
export function parseDelegations(value: xdr.ScVal): DelegationEdge[] {
  if (value.type !== "scvVec" || !value.vec) fail();
  return value.vec.map(row => {
    if (row.type !== "scvVec" || row.vec?.length !== 3) fail();
    const [address, fraction, credit] = row.vec;
    if (address.type !== "scvAddress" || fraction.type !== "scvU32" || credit.type !== "scvU64") {
      fail();
    }
    return { delegate: Address.fromScVal(address).toString(), fraction: fraction.u32 };
  });
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

/**
 * @internal Validate the inputs of a delegation change that need no chain
 * state and return the selected proxies, in encoding order.
 */
export function delegateProxies(owner: string, params: DelegateParams): IceProxy[] {
  if (typeof params.delegate !== "string" || !StrKey.isValidEd25519PublicKey(params.delegate)) {
    throw new AquariusError("delegate must be a Stellar account address (G...)");
  }
  if (params.delegate === owner) {
    throw new AquariusError("You cannot delegate voting power to yourself");
  }
  const fractions = params.fractions ?? {};
  const proxies = selectProxies(Object.keys(fractions));
  for (const proxy of proxies) {
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
  }
  return proxies;
}

/**
 * @internal Validate a delegation change against the owner's current
 * delegations and return one `delegate` call per selected proxy, in encoding
 * order. `current` holds the current delegations of every selected proxy.
 */
export function delegateCalls(
  contracts: Record<IceProxy, string>,
  owner: string,
  params: DelegateParams,
  current: Partial<Record<IceProxy, DelegationEdge[]>>,
): BatchCall[] {
  const proxies = delegateProxies(owner, params);
  return proxies.map(proxy => {
    const fraction = params.fractions[proxy]!;
    const edges = current[proxy];
    if (!edges) throw new AquariusError(`Current ${proxy} delegations are required`);
    const others = edges.filter(edge => edge.delegate !== params.delegate);
    if (others.length === edges.length && others.length >= MAX_DELEGATES_PER_PROXY) {
      throw new AquariusError(
        `The ${proxy} proxy already has ${MAX_DELEGATES_PER_PROXY} delegates for this owner; remove one first`,
      );
    }
    const othersTotal = others.reduce((sum, edge) => sum + edge.fraction, 0);
    if (othersTotal + fraction > DELEGATION_FRACTION_DENOMINATOR) {
      throw new AquariusError(`Total delegated ${proxy} share cannot exceed 100%`);
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
