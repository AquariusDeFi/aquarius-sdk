import { rpc, Transaction, xdr } from "@stellar/stellar-sdk";

export type SwapResourceLimits = {
  networkPassphrase: string;
  protocolVersion: number;
  latestLedger: number;
  instructions: bigint;
  diskReadBytes: number;
  writeBytes: number;
  diskReadEntries: number;
  writeEntries: number;
  footprintEntries?: number;
  transactionSizeBytes: number;
  eventsAndReturnBytes: number;
};

// Read once per preparation, never reuse another quote's or network's limits.
export const loadSwapResourceLimits = async (
  connection: {
    getNetwork: () => Promise<rpc.Api.GetNetworkResponse>;
    getLedgerEntries: (
      ...keys: xdr.LedgerKey[]
    ) => Promise<rpc.Api.GetLedgerEntriesResponse>;
  },
  networkPassphrase: string,
): Promise<SwapResourceLimits> => {
  const network = await connection.getNetwork();
  if (network.passphrase !== networkPassphrase)
    throw new Error("Swap resource network changed.");
  const protocolVersion = Number(network.protocolVersion);
  if (
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 20 ||
    protocolVersion > 30
  ) {
    throw new Error("Unsupported swap resource configuration.");
  }
  const ids = [
    xdr.ConfigSettingId.configSettingContractComputeV0,
    xdr.ConfigSettingId.configSettingContractLedgerCostV0,
    xdr.ConfigSettingId.configSettingContractBandwidthV0,
  ];
  if (protocolVersion >= 23)
    ids.push(xdr.ConfigSettingId.configSettingContractLedgerCostExtV0);
  ids.push(xdr.ConfigSettingId.configSettingContractEventsV0);
  const keys = ids.map((configSettingId) =>
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({ configSettingId }),
    ),
  );
  const { entries, latestLedger } = await connection.getLedgerEntries(...keys);
  if (!Number.isSafeInteger(latestLedger) || latestLedger <= 0) {
    throw new Error("Missing swap resource configuration.");
  }
  const configs = keys.map((key, index) => {
    const matches = entries.filter(
      (entry) => entry.key.toXdr("base64") === key.toXdr("base64"),
    );
    if (
      matches.length !== 1 ||
      matches[0].val.type !== "configSetting" ||
      matches[0].val.configSetting!.toXdrObject().configSettingID !==
        ids[index].value
    ) {
      throw new Error("Missing swap resource configuration.");
    }
    return matches[0].val.configSetting!;
  });
  const computeEntry = configs[0],
    ledgerEntry = configs[1],
    bandwidthEntry = configs[2],
    eventsEntry = configs[configs.length - 1];
  if (
    computeEntry.type !== "configSettingContractComputeV0" ||
    ledgerEntry.type !== "configSettingContractLedgerCostV0" ||
    bandwidthEntry.type !== "configSettingContractBandwidthV0" ||
    eventsEntry.type !== "configSettingContractEventsV0"
  )
    throw new Error("Missing swap resource configuration.");
  const footprintEntry = configs[3];
  if (
    protocolVersion >= 23 &&
    footprintEntry.type !== "configSettingContractLedgerCostExtV0"
  )
    throw new Error("Missing swap resource configuration.");
  const compute = computeEntry.contractCompute;
  const ledger = ledgerEntry.contractLedgerCost;
  const limits: SwapResourceLimits = {
    networkPassphrase,
    protocolVersion,
    latestLedger,
    instructions: BigInt(compute.txMaxInstructions.toString()),
    diskReadBytes: ledger.txMaxDiskReadBytes,
    writeBytes: ledger.txMaxWriteBytes,
    diskReadEntries: ledger.txMaxDiskReadEntries,
    writeEntries: ledger.txMaxWriteLedgerEntries,
    footprintEntries:
      protocolVersion >= 23
        ? footprintEntry.type === "configSettingContractLedgerCostExtV0"
          ? footprintEntry.contractLedgerCostExt.txMaxFootprintEntries
          : undefined
        : undefined,
    transactionSizeBytes: bandwidthEntry.contractBandwidth.txMaxSizeBytes,
    eventsAndReturnBytes:
      eventsEntry.contractEvents.txMaxContractEventsSizeBytes,
  };
  if (limits.instructions <= 0n || limits.transactionSizeBytes <= 0) {
    throw new Error("Invalid swap resource configuration.");
  }
  return limits;
};

// This checks declared resources, including the RPC's reserve, against per-tx
// caps. Host simulation still checks execution/memory; this is not full Core
// admission. Do not reduce resources to make an over-limit candidate fit.
export const assertSwapResources = (
  tx: Transaction,
  limits: SwapResourceLimits,
  invocation: { events: xdr.DiagnosticEvent[]; retval: xdr.ScVal },
) => {
  if (tx.networkPassphrase !== limits.networkPassphrase) {
    throw new Error("Swap resource network changed.");
  }
  const envelope = tx.toEnvelope();
  if (
    envelope.type !== "envelopeTypeTx" ||
    envelope.v1.tx.ext.type !== "sorobanData"
  )
    throw new Error("Invalid swap envelope.");
  const data = envelope.v1.tx.ext.sorobanData!;
  const resources = data.resources;
  const footprint = resources.footprint;
  const readWrite = footprint.readWrite;
  const keys = [...footprint.readOnly, ...readWrite];
  const archived =
    data.ext.type === "resourceExt"
      ? data.ext.resourceExt!.archivedSorobanEntries
      : [];
  const isContractKey = (key: xdr.LedgerKey) =>
    key.type === "contractData" || key.type === "contractCode";
  if (
    (limits.protocolVersion < 23 && data.ext.toXdrObject().v !== 0) ||
    new Set(archived).size !== archived.length ||
    archived.some(
      (index) => index >= readWrite.length || !isContractKey(readWrite[index]),
    )
  ) {
    throw new Error("Invalid swap resource footprint.");
  }
  const diskReadEntries =
    limits.protocolVersion >= 23
      ? keys.filter((key) => !isContractKey(key)).length + archived.length
      : keys.length;
  // The current Sell flow uses a V1 envelope (no fee bump). Reserve every
  // legal decorated-signature slot: 4-byte hint + 4-byte length + 64 bytes.
  // This also covers public/multisig signing without changing wallet flows.
  const signedSize = envelope.toXdr().length + (20 - tx.signatures.length) * 72;
  // RPC wraps all host events in DiagnosticEvent. Core charges only successful
  // non-diagnostic ContractEvent XDR, plus the final return ScVal (including
  // the outer batch vector for trust + split); never the diagnostic wrapper.
  if (!Array.isArray(invocation.events))
    throw new Error("Missing swap simulation events.");
  const eventBytes = invocation.events.reduce((total, diagnostic) => {
    const event = diagnostic.event;
    return diagnostic.inSuccessfulContractCall &&
      event.type !== xdr.ContractEventType.diagnostic
      ? total + event.toXdr().length
      : total;
  }, invocation.retval.toXdr().length);
  const checks: [string, bigint | number, bigint | number][] = [
    ["instructions", BigInt(resources.instructions), limits.instructions],
    ["disk read bytes", resources.diskReadBytes, limits.diskReadBytes],
    ["write bytes", resources.writeBytes, limits.writeBytes],
    ["disk read entries", diskReadEntries, limits.diskReadEntries],
    ["write entries", readWrite.length, limits.writeEntries],
    ["transaction size", signedSize, limits.transactionSizeBytes],
    ["events and return bytes", eventBytes, limits.eventsAndReturnBytes],
  ];
  if (limits.footprintEntries !== undefined) {
    checks.push(["footprint entries", keys.length, limits.footprintEntries]);
  }
  for (const [name, used, max] of checks) {
    if (BigInt(used) > BigInt(max)) {
      throw new Error(`Swap exceeds the network limit for ${name}.`);
    }
  }
};

// Simulation supplies resources and fees, never additional spending authority.
export const assertSwapAuthorization = (
  tx: Transaction,
  source: string,
  expected: string,
) => {
  const operation = tx.operations[0];
  const body = xdr.Operation.fromXdr(expected, "base64").body;
  if (body.type !== "invokeHostFunction")
    throw new Error("Invalid swap operation.");
  const expectedInvoke = body.invokeHostFunctionOp;
  if (
    tx.source !== source ||
    tx.operations.length !== 1 ||
    operation.type !== "invokeHostFunction" ||
    (operation.source && operation.source !== source) ||
    operation.func.toXdr("base64") !==
      expectedInvoke.hostFunction.toXdr("base64") ||
    JSON.stringify(
      (operation.auth ?? []).map((entry) => entry.toXdr("base64")),
    ) !==
      JSON.stringify(expectedInvoke.auth.map((entry) => entry.toXdr("base64")))
  ) {
    throw new Error("Swap authorization changed. Please try again.");
  }
};

export const getSwapResult = (
  result: xdr.ScVal,
  withTrustline: boolean,
): xdr.ScVal => {
  if (!withTrustline) return result;
  if (result.type !== "scvVec") {
    throw new Error(
      "Unexpected swap result. Check the transaction in the explorer.",
    );
  }
  const values = result.vec!;
  if (
    values.length !== 2 ||
    values[0].type !== "scvVoid" ||
    values[1].type !== "scvU128"
  ) {
    throw new Error(
      "Unexpected swap result. Check the transaction in the explorer.",
    );
  }
  return values[1];
};

export const getSellSwapResult = (
  result: xdr.ScVal,
  legCount: number,
  withTrustline: boolean,
): bigint[] => {
  const invalid = () =>
    new Error("Unexpected swap result. Check the transaction in the explorer.");
  if (!Number.isInteger(legCount) || legCount < 1 || legCount > 4)
    throw invalid();
  let swapResult = result;
  if (withTrustline) {
    if (result.type !== "scvVec") throw invalid();
    const batch = result.vec!;
    if (batch.length !== 2 || batch[0].type !== "scvVoid") throw invalid();
    swapResult = batch[1];
  }
  if (legCount > 1 && swapResult.type !== "scvVec") throw invalid();
  const values =
    legCount === 1
      ? [swapResult]
      : swapResult.type === "scvVec"
        ? (swapResult.vec ?? [])
        : [];
  if (values.length !== legCount) throw invalid();
  return values.map((value) => {
    if (value.type !== "scvU128") throw invalid();
    return (
      (BigInt(value.u128!.hi.toString()) << 64n) +
      BigInt(value.u128!.lo.toString())
    );
  });
};
