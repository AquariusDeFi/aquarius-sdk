import { Buffer } from "buffer";
import { Address, hash, Horizon, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import type { LimitOrderFill, LimitOrderFillAmounts } from "./limit-order-types.js";

export const getLimitOrderFillOperation = (
  operation: Horizon.ServerApi.OperationRecord,
  settlement: string,
  maker: string,
): LimitOrderFill | null => {
  if (
    !settlement ||
    operation.type !== "invoke_host_function" ||
    !operation.transaction_successful ||
    operation.parameters.length < 3
  )
    return null;

  try {
    const decode = (index: number): unknown =>
      scValToNative(xdr.ScVal.fromXDR(operation.parameters[index].value, "base64"));
    if (decode(0) !== settlement || decode(1) !== "fill") return null;
    const orderValue = xdr.ScVal.fromXDR(operation.parameters[2].value, "base64");
    const order: unknown = scValToNative(orderValue);
    if (
      !order ||
      typeof order !== "object" ||
      Array.isArray(order) ||
      !("maker" in order) ||
      order.maker !== maker ||
      !("version" in order) ||
      order.version !== 1
    )
      return null;
    return {
      orderId: Buffer.from(hash(orderValue.toXDR())).toString("hex"),
      maker,
      settlementContract: settlement,
      transactionHash: operation.transaction_hash,
      createdAt: operation.created_at,
    };
  } catch {
    return null;
  }
};

export const getLimitOrderFillAmounts = (
  transaction: rpc.Api.GetTransactionResponse,
  fill: LimitOrderFill,
): LimitOrderFillAmounts | null => {
  if (
    transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS ||
    transaction.txHash !== fill.transactionHash
  )
    return null;

  const events = transaction.events.contractEventsXdr.flat();
  // Older RPC responses carry events only in transaction metadata.
  if (!events.length) {
    const meta = transaction.resultMetaXdr;
    if (meta?.type === "v3") events.push(...(meta.v3.sorobanMeta?.events ?? []));
    if (meta?.type === "v4") {
      events.push(...meta.v4.operations.flatMap((operation) => operation.events));
    }
  }
  for (const event of events) {
    try {
      const contractId = event.contractId;
      if (
        event.type.value !== xdr.ContractEventType.contract.value ||
        !contractId ||
        Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString() !==
          fill.settlementContract
      )
        continue;
      const body = event.body.v0;
      const [name, orderId, maker] = body.topics.map(scValToNative);
      if (
        name !== "filled" ||
        !(orderId instanceof Uint8Array) ||
        Buffer.from(orderId).toString("hex") !== fill.orderId ||
        maker !== fill.maker
      )
        continue;
      const data = scValToNative(body.data);
      if (
        typeof data?.sell_token !== "string" ||
        !StrKey.isValidContract(data.sell_token) ||
        typeof data?.buy_token !== "string" ||
        !StrKey.isValidContract(data.buy_token) ||
        typeof data?.sell_amount !== "bigint" ||
        data.sell_amount <= 0n ||
        typeof data?.maker_buy_delta_before_reward !== "bigint" ||
        data.maker_buy_delta_before_reward <= 0n
      )
        continue;

      return {
        sellToken: data.sell_token,
        sellAmount: data.sell_amount.toString(),
        buyToken: data.buy_token,
        // This is the actual output, net of the execution reward for XLM buys.
        buyAmount: data.maker_buy_delta_before_reward.toString(),
      };
    } catch {
      // An unrelated or malformed event must not hide the matching fill.
    }
  }
  return null;
};
