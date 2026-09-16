/**
 * Client-built Soroban authorization entries.
 *
 * The SDK states what a signature authorizes — deterministically, before
 * simulation — instead of echoing whatever the RPC's simulation returns.
 * Assembly preserves pre-built auth and only fills in resources.
 */

import { Buffer } from "buffer";

import { Address, StrKey, hash, xdr } from "@stellar/stellar-sdk";

/**
 * The address a contract gets when `deployer` deploys it with `salt` —
 * `e.deployer().with_current_contract(salt)` on the contract side. Lets the
 * client name contracts that a call is about to create (a pool's reward
 * gauge, an incentives vault) inside the authorization it builds for that call.
 */
export function deployedContractId(deployer: string, salt: Buffer, passphrase: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(deployer).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(Buffer.from(hash(preimage.toXDR())));
}

/** The contracts' salt convention: sha256 over the ScVal XDR of each address, in order, plus a tag. */
export function addressSalt(addresses: string[], tag = ""): Buffer {
  return Buffer.from(
    hash(
      Buffer.concat([
        ...addresses.map(a => Buffer.from(new Address(a).toScVal().toXDR())),
        Buffer.from(tag),
      ]),
    ),
  );
}

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
