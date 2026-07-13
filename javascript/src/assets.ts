import { Asset as StellarAsset } from "@stellar/stellar-sdk";

/** A token, however you happen to know it: native, code+issuer, or contract ID. */
export class Asset {
  private constructor(
    readonly code?: string,
    readonly issuer?: string,
    private readonly contract_?: string,
  ) {}

  static native(): Asset {
    return new Asset("XLM");
  }

  static classic(code: string, issuer: string): Asset {
    return new Asset(code, issuer);
  }

  static contract(contractId: string): Asset {
    return new Asset(undefined, undefined, contractId);
  }

  get isNative(): boolean {
    return this.contract_ === undefined && this.issuer === undefined;
  }

  /** Resolve to the Soroban contract ID for the given network passphrase. */
  contractId(passphrase: string): string {
    if (this.contract_) return this.contract_;
    if (this.isNative) return StellarAsset.native().contractId(passphrase);
    return new StellarAsset(this.code!, this.issuer!).contractId(passphrase);
  }

  /** @internal The classic-asset form, required for trustline operations. */
  toClassic(): StellarAsset {
    if (this.contract_) {
      throw new Error("This asset is only known by contract ID — trustlines apply to classic assets");
    }
    return this.isNative ? StellarAsset.native() : new StellarAsset(this.code!, this.issuer!);
  }

  toString(): string {
    return this.code ?? this.contract_ ?? "unknown";
  }
}

export const XLM = Asset.native();
