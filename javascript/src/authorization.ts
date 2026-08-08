/**
 * Client-built Soroban authorization entries.
 *
 * The SDK states what a signature authorizes — deterministically, before
 * simulation — instead of echoing whatever the RPC's simulation returns.
 * Assembly preserves pre-built auth and only fills in resources.
 */

import { Address, xdr } from "@stellar/stellar-sdk";

export function authorizedContractFn(
  contractId: string,
  name: string,
  args: xdr.ScVal[],
): xdr.SorobanAuthorizedFunction {
  return xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName: name,
      args,
    }),
  );
}

export function authorizedInvocation(
  contractId: string,
  name: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: authorizedContractFn(contractId, name, args),
    subInvocations,
  });
}

/** An auth entry covered by the transaction envelope's own signature. */
export function sourceAccountEntry(
  root: xdr.SorobanAuthorizedInvocation,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
}
