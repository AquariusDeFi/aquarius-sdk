import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as it, describe } from "node:test";
import { format } from "node:util";
import * as sdk from "../dist/index.js";
import { Address, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
const fixture = JSON.parse(
  readFileSync(new URL("../../testdata/limit_order_filled_event.json", import.meta.url), "utf8"),
);
const { getLimitOrderFillAmounts } = sdk;
const each = (cases, name, run) => {
  for (const item of cases) {
    const args = Array.isArray(item) ? item : [item];
    it(format(name, ...args), () => run(...args));
  }
};
const event = () => xdr.ContractEvent.fromXDR(fixture.eventXdr, "base64");
const transaction = (events = [event()]) => ({
  status: rpc.Api.GetTransactionStatus.SUCCESS,
  txHash: fixture.fill.transactionHash,
  events: {
    contractEventsXdr: [events],
    transactionEventsXdr: [],
  },
});
describe("confirmed limit-order fill amounts", () => {
  it("decodes the real settlement event and uses net XLM output, excluding its reward", () => {
    assert.deepEqual(getLimitOrderFillAmounts(transaction(), fixture.fill), {
      sellToken: "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE",
      sellAmount: "11000000000000",
      buyToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      buyAmount: "289307109354",
    });
  });
  each(["FAILED", "NOT_FOUND"], "does not read events from a %s transaction", (status) => {
    const response = {
      ...transaction(),
      status,
    };
    assert.equal(getLimitOrderFillAmounts(response, fixture.fill), null);
  });
  it("does not use a receipt belonging to another transaction", () => {
    const response = {
      ...transaction(),
      txHash: "00".repeat(32),
    };
    assert.equal(getLimitOrderFillAmounts(response, fixture.fill), null);
  });
  each(
    ["contract", "order", "maker", "name", "type"],
    "ignores an event with a different %s",
    (field) => {
      const other = event();
      const topics = other.body.v0.topics;
      if (field === "contract")
        Object.assign(other, {
          contractId: Address.fromString(
            "CCYPRFTJIIOLQUSQUPQKQJ36PELTK662G5NYAMUOFM6JM7HFOGL2WYQX",
          ).toScAddress().contractId,
        });
      if (field === "order") topics[1] = xdr.ScVal.scvBytes(Buffer.alloc(32));
      if (field === "maker")
        topics[2] = Address.fromString(fixture.fill.settlementContract).toScVal();
      if (field === "name") topics[0] = xdr.ScVal.scvSymbol("cancelled");
      if (field === "type")
        Object.assign(other, {
          type: xdr.ContractEventType.diagnostic,
        });
      assert.equal(getLimitOrderFillAmounts(transaction([other]), fixture.fill), null);
      assert.notEqual(getLimitOrderFillAmounts(transaction([other, event()]), fixture.fill), null);
    },
  );
  each(
    [
      ["sell_amount", -1n],
      ["sell_amount", "100"],
      ["maker_buy_delta_before_reward", 0n],
      ["maker_buy_delta_before_reward", undefined],
      ["sell_token", "invalid contract"],
      ["buy_token", 123],
    ],
    "does not invent amounts from malformed %s data",
    (field, value) => {
      const invalid = event();
      const data = scValToNative(invalid.body.v0.data);
      Object.assign(invalid.body.v0, {
        data: nativeToScVal({
          ...data,
          [String(field)]: value,
        }),
      });
      assert.equal(getLimitOrderFillAmounts(transaction([invalid]), fixture.fill), null);
    },
  );
  each([3, 4], "reads events from version %s metadata on older RPC servers", (version) => {
    const response = transaction([]);
    response.resultMetaXdr = {
      type: version === 3 ? "v3" : "v4",
      v3: {
        sorobanMeta: {
          events: [event()],
        },
      },
      v4: {
        operations: [
          {
            events: [event()],
          },
        ],
      },
    };
    assert.deepEqual(
      getLimitOrderFillAmounts(response, fixture.fill),
      getLimitOrderFillAmounts(transaction(), fixture.fill),
    );
  });
});
