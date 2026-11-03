/** Registry wire payloads. Amounts are decimal strings in token base units. */
export type LimitOrderData = {
  version: number;
  placement_mode: "DETACHED" | "CONTRACT_ONCHAIN";
  salt: string;
  maker: string;
  sell_token: string;
  sell_amount: string;
  buy_token: string;
  min_buy_amount: string;
  valid_after_ledger: number;
  expires_at_ledger: number;
  executor_reward_xlm: string;
};

export type LimitOrderFill = {
  orderId: string;
  maker: string;
  settlementContract: string;
  transactionHash: string;
  createdAt: string;
};

export type LimitOrderFillAmounts = {
  sellToken: string;
  sellAmount: string;
  buyToken: string;
  buyAmount: string;
};

export type LimitOrderRecordPayload = LimitOrderData & {
  order_id: string;
  status: "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED";
  network_id: string;
  settlement_address: string;
  order_xdr: string;
  authorization_xdr?: string;
  admission_ledger: number | null;
  placement_ledger: number | null;
  placement_transaction_hash: string;
  terminal_ledger?: number | null;
  terminal_transaction_hash?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  fill_telemetry?: {
    router_output?: string;
    maker_buy_delta_before_reward?: string;
    reward_xlm?: string;
  };
  funding_snapshot: {
    observed_at_ledger?: number;
    funding_check?: string;
  };
};

export type LimitOrderDraftRequest = Omit<
  LimitOrderData,
  "version" | "salt" | "executor_reward_xlm"
>;

export type DetachedLimitOrderDraftPayload = Omit<
  LimitOrderRecordPayload,
  "authorization_xdr" | "status"
> & {
  placement_mode: "DETACHED";
  status: "DRAFT";
  unsigned_authorization_xdr: string;
};

export type ContractLimitOrderDraftPayload = Omit<
  LimitOrderRecordPayload,
  "authorization_xdr" | "status"
> & {
  placement_mode: "CONTRACT_ONCHAIN";
  status: "AWAITING_PLACEMENT";
};

export type LimitOrderDraftPayload =
  | DetachedLimitOrderDraftPayload
  | ContractLimitOrderDraftPayload;

export type LimitOrderListPayload = {
  orders: LimitOrderRecordPayload[];
  next_cursor?: string | null;
};

/** Maximum allowance lifetime: 180 days minus one ledger. */
export const LIMIT_ORDER_MAX_TTL_LEDGERS = 3_110_399;

/** Maximum requested duration: 6 months (180 days), at 5 seconds per ledger. */
export const LIMIT_ORDER_MAX_DURATION_SECONDS = (LIMIT_ORDER_MAX_TTL_LEDGERS + 1) * 5;
