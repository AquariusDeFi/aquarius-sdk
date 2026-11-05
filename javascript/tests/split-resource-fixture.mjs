import { Networks, xdr } from "@stellar/stellar-sdk";

export const swapResourceConfig = (protocol = 29) => {
  const zero = 0n;
  const configs = [
    xdr.ConfigSettingEntry.configSettingContractComputeV0(
      new xdr.ConfigSettingContractComputeV0({
        ledgerMaxInstructions: zero,
        txMaxInstructions: 1000n,
        feeRatePerInstructionsIncrement: zero,
        txMemoryLimit: 40_000_000,
      }),
    ),
    xdr.ConfigSettingEntry.configSettingContractLedgerCostV0(
      new xdr.ConfigSettingContractLedgerCostV0({
        ledgerMaxDiskReadEntries: 0,
        ledgerMaxDiskReadBytes: 0,
        ledgerMaxWriteLedgerEntries: 0,
        ledgerMaxWriteBytes: 0,
        txMaxDiskReadEntries: 2,
        txMaxDiskReadBytes: 2000,
        txMaxWriteLedgerEntries: 2,
        txMaxWriteBytes: 1000,
        feeDiskReadLedgerEntry: zero,
        feeWriteLedgerEntry: zero,
        feeDiskRead1Kb: zero,
        sorobanStateTargetSizeBytes: zero,
        rentFee1KbSorobanStateSizeLow: zero,
        rentFee1KbSorobanStateSizeHigh: zero,
        sorobanStateRentFeeGrowthFactor: 0,
      }),
    ),
    xdr.ConfigSettingEntry.configSettingContractBandwidthV0(
      new xdr.ConfigSettingContractBandwidthV0({
        ledgerMaxTxsSizeBytes: 0,
        txMaxSizeBytes: 100_000,
        feeTxSize1Kb: zero,
      }),
    ),
  ];
  if (protocol >= 23) {
    configs.push(
      xdr.ConfigSettingEntry.configSettingContractLedgerCostExtV0(
        new xdr.ConfigSettingContractLedgerCostExtV0({
          txMaxFootprintEntries: 4,
          feeWrite1Kb: zero,
        }),
      ),
    );
  }
  configs.push(
    xdr.ConfigSettingEntry.configSettingContractEventsV0(
      new xdr.ConfigSettingContractEventsV0({
        txMaxContractEventsSizeBytes: 1024,
        feeContractEvents1Kb: zero,
      }),
    ),
  );
  return {
    latestLedger: 1,
    entries: configs.map((config) => ({
      lastModifiedLedgerSeq: 1,
      key: xdr.LedgerKey.configSetting(
        new xdr.LedgerKeyConfigSetting({
          configSettingId: xdr.ConfigSettingId[config.type],
        }),
      ),
      val: xdr.LedgerEntryData.configSetting(config),
    })),
  };
};

export const swapResourceNetwork = (protocol = 29) => ({
  passphrase: Networks.TESTNET,
  protocolVersion: String(protocol),
});
