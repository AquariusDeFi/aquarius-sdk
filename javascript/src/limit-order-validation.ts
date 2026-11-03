import { Buffer } from "buffer";
import { Address, hash, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { authorizedInvocation } from "./authorization.js";
import { AquariusError } from "./errors.js";
import { limitOrderFromScVal } from "./limit-orders.js";
import type {
  LimitOrderRecordPayload,
  LimitOrderDraftPayload,
  LimitOrderDraftRequest,
} from "./limit-order-types.js";
const ORDER_FIELDS = [
  "buy_token",
  "executor_reward_xlm",
  "expires_at_ledger",
  "maker",
  "min_buy_amount",
  "placement_mode",
  "salt",
  "sell_amount",
  "sell_token",
  "valid_after_ledger",
  "version",
];

export const validateLimitOrderRecord = (
  order: LimitOrderRecordPayload | LimitOrderDraftPayload,
  expectedSettlement: string,
  expectedMaker: string,
  networkPassphrase: string,
  allowedStatuses: Array<LimitOrderRecordPayload["status"] | LimitOrderDraftPayload["status"]> = [
    "OPEN",
  ],
): xdr.ScVal => {
  const expectedNetworkId = Buffer.from(hash(Buffer.from(networkPassphrase))).toString("hex");
  const detached = order.placement_mode === "DETACHED";
  if (
    order.version !== 1 ||
    !["DETACHED", "CONTRACT_ONCHAIN"].includes(order.placement_mode) ||
    !/^[0-9a-f]{64}$/i.test(order.salt) ||
    order.sell_token === order.buy_token ||
    ![order.sell_amount, order.min_buy_amount, order.executor_reward_xlm].every(
      (amount) =>
        /^\d+$/.test(amount) &&
        BigInt(amount) > 0n &&
        BigInt(amount) <= 170141183460469231731687303715884105727n,
    ) ||
    ![order.valid_after_ledger, order.expires_at_ledger].every(
      (ledger) => Number.isInteger(ledger) && ledger >= 0 && ledger <= 0xffffffff,
    ) ||
    order.valid_after_ledger > order.expires_at_ledger ||
    !allowedStatuses.includes(order.status) ||
    order.settlement_address !== expectedSettlement ||
    order.network_id !== expectedNetworkId ||
    order.maker !== expectedMaker ||
    (detached &&
      order.status === "OPEN" &&
      (!("authorization_xdr" in order) || !order.authorization_xdr)) ||
    (!detached && "authorization_xdr" in order && Boolean(order.authorization_xdr))
  ) {
    throw new AquariusError("The order registry returned a record for another execution context.");
  }

  let orderValue: xdr.ScVal;
  try {
    orderValue = xdr.ScVal.fromXDR(order.order_xdr, "base64");
  } catch {
    throw new AquariusError("The order registry returned invalid canonical order XDR.");
  }
  if (Buffer.from(hash(orderValue.toXDR())).toString("hex") !== order.order_id) {
    throw new AquariusError("The order registry returned an order ID that does not match its XDR.");
  }

  limitOrderFromScVal(orderValue);
  const nativeValue = scValToNative(orderValue) as unknown;
  if (!nativeValue || typeof nativeValue !== "object" || Array.isArray(nativeValue)) {
    throw new AquariusError("The order registry returned a non-struct canonical order.");
  }
  const native = nativeValue as Record<string, unknown>;
  const salt = native.salt;
  const fieldsMatch =
    Object.keys(native).sort().join(",") === ORDER_FIELDS.join(",") &&
    native.version === order.version &&
    Array.isArray(native.placement_mode) &&
    native.placement_mode.length === 1 &&
    native.placement_mode[0] === (detached ? "Detached" : "ContractOnChain") &&
    salt instanceof Uint8Array &&
    Buffer.from(salt).toString("hex") === order.salt &&
    native.maker === order.maker &&
    native.sell_token === order.sell_token &&
    String(native.sell_amount) === order.sell_amount &&
    native.buy_token === order.buy_token &&
    String(native.min_buy_amount) === order.min_buy_amount &&
    native.valid_after_ledger === order.valid_after_ledger &&
    native.expires_at_ledger === order.expires_at_ledger &&
    String(native.executor_reward_xlm) === order.executor_reward_xlm;
  if (!fieldsMatch) {
    throw new AquariusError("The order registry JSON does not match its canonical order XDR.");
  }
  if (
    !detached &&
    order.status === "OPEN" &&
    (!order.placement_ledger || !/^[0-9a-f]{64}$/i.test(order.placement_transaction_hash))
  ) {
    throw new AquariusError("The contract order has no confirmed placement reference.");
  }
  return orderValue;
};

// Verify what is being authorized BEFORE opening a wallet. Comparing the wallet's
// response with an unverified server draft would still allow a substituted order.
export const validateLimitOrderDraft = (
  draft: LimitOrderDraftPayload,
  intent: LimitOrderDraftRequest,
  settlement: string,
  xlmToken: string,
  reward: string,
  networkPassphrase: string,
  allowAutoTrust = false,
  requireAutoTrust = false,
) => {
  const orderValue = validateLimitOrderRecord(draft, settlement, intent.maker, networkPassphrase, [
    intent.placement_mode === "DETACHED" ? "DRAFT" : "AWAITING_PLACEMENT",
  ]);
  if (
    draft.executor_reward_xlm !== reward ||
    Object.entries(intent).some(([key, value]) => draft[key as keyof typeof draft] !== value)
  )
    throw new AquariusError("The order draft does not match the details you confirmed.");

  if (draft.placement_mode === "CONTRACT_ONCHAIN") {
    if ("unsigned_authorization_xdr" in draft || "authorization_xdr" in draft)
      throw new AquariusError("The on-chain order draft contains an unexpected authorization.");
    return;
  }

  const transfer = (token: string, amount: string) =>
    authorizedInvocation(token, "transfer", [
      Address.fromString(intent.maker).toScVal(),
      Address.fromString(settlement).toScVal(),
      nativeToScVal(BigInt(amount), { type: "i128" }),
    ]);
  const expected = authorizedInvocation(
    settlement,
    "fill",
    [orderValue],
    [transfer(intent.sell_token, intent.sell_amount), transfer(xlmToken, reward)],
  );
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(draft.unsigned_authorization_xdr, "base64");
  const withTrust = authorizedInvocation(
    settlement,
    "fill",
    [orderValue],
    [
      authorizedInvocation(intent.buy_token, "trust", [Address.fromString(intent.maker).toScVal()]),
      ...expected.subInvocations,
    ],
  );
  const hasTrust =
    allowAutoTrust &&
    intent.maker.startsWith("G") &&
    intent.buy_token !== xlmToken &&
    entry.rootInvocation.toXDR("base64") === withTrust.toXDR("base64");
  if (requireAutoTrust && !hasTrust)
    throw new AquariusError(
      "Automatic trustline creation is unavailable. Refresh the order details.",
    );
  if (entry.credentials.type !== "sorobanCredentialsAddressV2") {
    throw new AquariusError("The order draft uses unsupported authorization credentials.");
  }
  const credentials = entry.credentials.addressV2;
  if (
    Address.fromScAddress(credentials.address).toString() !== intent.maker ||
    credentials.signatureExpirationLedger !== intent.expires_at_ledger ||
    credentials.signature.type !== "scvVoid" ||
    !(hasTrust || entry.rootInvocation.toXDR("base64") === expected.toXDR("base64"))
  )
    throw new AquariusError(
      "The order authorization does not match the exact order and transfers.",
    );
};

export const assertSignedAuthorizationMatchesDraft = (
  unsignedXdr: string,
  signedXdr: string,
  maker: string,
) => {
  const unsigned = xdr.SorobanAuthorizationEntry.fromXDR(unsignedXdr, "base64");
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(signedXdr, "base64");
  if (signed.credentials.type !== "sorobanCredentialsAddressV2") {
    throw new AquariusError("Wallet returned an authorization with unsupported credentials.");
  }
  if (signed.rootInvocation.toXDR("base64") !== unsigned.rootInvocation.toXDR("base64")) {
    throw new AquariusError("Wallet changed the order authorization invocation.");
  }
  const signedCredentials = signed.credentials.addressV2;
  const signature = signedCredentials.signature;
  if (signature.type === "scvVoid") {
    throw new AquariusError("Wallet returned an unsigned authorization.");
  }
  if (Address.fromScAddress(signedCredentials.address).toString() !== maker) {
    throw new AquariusError("Wallet signed the authorization for another account.");
  }
  const unsignedCredentials = xdr.SorobanCredentials.sorobanCredentialsAddressV2(
    new xdr.SorobanAddressCredentials({ ...signedCredentials, signature: xdr.ScVal.scvVoid() }),
  );
  if (unsignedCredentials.toXDR("base64") !== unsigned.credentials.toXDR("base64")) {
    throw new AquariusError("Wallet changed the order authorization credentials.");
  }
};
