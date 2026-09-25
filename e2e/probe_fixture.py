#!/usr/bin/env python3
"""Set up the probe wallet fixture for the Aquarius availability exporter.

The availability exporter checks mainnet deposits and withdrawals by
simulating, from the SDK's mainnet E2E wallet (EXPECTED_ACCOUNT), a 0.1 XLM
deposit into and a small withdraw from the XLM/USDC 0.10% constant-product
pool (POOL). Those simulations pass only while the wallet holds this fixture:

  * a trustline to Circle USDC,
  * free USDC >= 3x the USDC leg of the 0.1 XLM probe deposit,
  * LP shares in POOL,
  * >= 10 XLM total, so the nightly E2E lifecycle keeps running without warnings.

Steps, each run only while its target is unmet (a re-run resumes a partial
run and is a no-op once the fixture exists):
  1. add the USDC trustline (locks a 0.5 XLM reserve);
  2. swap XLM -> USDC through POOL via the router when free USDC is below what
     the deposit plus the 3x floor need: the shortfall + 10%, rounded up to
     0.1 XLM, with out_min = the router's estimate - 1%;
  3. deposit 1 XLM + the pool-ratio USDC amount + 1% (the pool refunds the
     rest) when the wallet holds no LP shares, with min_shares = the
     simulated mint - 1%.

Modes:
  --check [--account G...]  read-only; never reads the secret. Reports every
                            requirement and runs the exporter's deposit and
                            withdraw simulations. Exit 0 when the fixture
                            satisfies the exporter, 1 when it does not.
  (default)                 dry run. Reads state, plans, and builds and
                            simulates the steps whose inputs already exist;
                            signs and submits nothing. Exit 0, or 2 when the
                            plan is refused. If MAINNET_E2E_SECRET is set, it
                            is used only to confirm that it derives to
                            EXPECTED_ACCOUNT.
  --execute [--yes]         signs and submits the planned steps with
                            MAINNET_E2E_SECRET, after a typed EXECUTE
                            confirmation unless --yes, then runs --check.
  Every mode exits 3 on STOP: a safety check refused, or an outcome needs
  inspection before re-running.

Never run --execute while a mainnet E2E lifecycle is running: both use the
same account and its sequence number.

Safety properties:
  * the secret is read only from the MAINNET_E2E_SECRET environment variable and
    is never printed or written anywhere (an invalid seed is reported without
    echoing it); only --execute signs;
  * refuses unless the key derives to EXPECTED_ACCOUNT and both Soroban RPC and
    Horizon report the mainnet passphrase;
  * every transaction is checked before signing: one operation from the wallet,
    mainnet passphrase, an upper time bound, a per-step fee ceiling, router
    arguments equal to the plan including the exact positive slippage guard,
    and an authorization tree with source-account credentials only that
    touches only the router, POOL, the XLM SAC and the Circle USDC SAC, with
    transfers only from the wallet to POOL and not above the planned amounts;
    the only classic operation is the USDC trustline;
  * hard cap on XLM spent in a run (MAX_SPEND = 3.5 XLM, including the trustline
    reserve and fees), enforced on the plan and again before each submission;
    refuses when the wallet would end below MIN_XLM_AFTER and says how much to
    top up;
  * never restores archived entries: a simulation that reports a restore
    preamble stops the run;
  * never resubmits: each transaction is sent once with a 90-second time bound,
    then its hash is followed until it succeeds, fails, or the ledger has closed
    past its time bound (after which it can never apply); a step that ran but
    is still needed stops the run for inspection.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field, replace
from decimal import Decimal

import requests

EXPECTED_ACCOUNT = "GACBDYR3MNVUYY7NXP47ZL6JAWZNFXXXHTHLKWENADUMAWRO762L32WW"
MAINNET = "Public Global Stellar Network ; September 2015"
RPC_URL = "https://soroban-rpc.aqua.network"
HORIZON_URL = "https://horizon.stellar.org"
EXPLORER = "https://stellar.expert/explorer/public/tx/"

ROUTER = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK"
POOL = "CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE"
XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
USDC_CODE = "USDC"
USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
ALLOWED_CONTRACTS = {ROUTER, POOL, XLM_SAC, USDC_SAC}

XLM = 10_000_000  # stroops per XLM; USDC and pool shares also use 7 decimals
# Mirrors of the availability exporter's probe constants.
PROBE_DEPOSIT_XLM = XLM // 10
PROBE_WITHDRAW_SHARES = 100_000
PROBE_USDC_MULTIPLE = 3

FIXTURE_DEPOSIT_XLM = 1 * XLM
SWAP_BUFFER_BPS = 11_000   # buy 10% more USDC than the plan needs
SWAP_ROUNDING = XLM // 10  # swap amounts are rounded up to 0.1 XLM
SLIPPAGE_BPS = 100
MIN_XLM_AFTER = 10 * XLM   # the E2E lifecycle warns below 10 XLM total balance
MAX_SPEND = 35 * XLM // 10  # 3.5 XLM, including the trustline reserve and fees
BASE_RESERVE = XLM // 2
INCLUSION_FEE = 100_000     # max inclusion fee bid per transaction (0.01 XLM)
# Planning estimates for steps that cannot be simulated yet (their input does
# not exist until an earlier step lands), and hard per-transaction fee ceilings.
# Measured on mainnet 2026-09-23: swap resource fee ~0.005 XLM, first deposit
# into the pool ~0.25 XLM (rent for the new share balance and reward entries).
FEE_ESTIMATE = {"trustline": INCLUSION_FEE, "swap": 600_000, "deposit": 3_000_000}
FEE_CEILING = {"trustline": INCLUSION_FEE, "swap": 1_000_000, "deposit": 4_000_000}
TX_TIMEOUT = 90
STATUS_GRACE_SECONDS = 600


class Stop(Exception):
    """Stop the run with a message for the operator; nothing further is submitted."""


def fmt(stroops: int) -> str:
    sign = "-" if stroops < 0 else ""
    whole, frac = divmod(abs(int(stroops)), XLM)
    return f"{sign}{whole}.{frac:07d}"


def ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def to_stroops(value) -> int:
    amount = Decimal(str(value)) * XLM
    if amount != amount.to_integral_value():
        raise Stop(f"unexpected amount precision: {value}")
    return int(amount)


# --- state ---------------------------------------------------------------------------


@dataclass(frozen=True)
class State:
    account: str
    xlm_balance: int      # total native balance, what the E2E lifecycle measures
    min_balance: int      # native locked by base reserve and subentries
    xlm_liabilities: int
    has_trustline: bool
    usdc_balance: int     # free USDC (balance minus selling liabilities)
    usdc_limit: int
    usdc_authorized: bool
    shares: int           # LP shares held in the sentinel pool
    reserve_xlm: int
    reserve_usdc: int
    total_shares: int
    pool_hash: bytes = field(repr=False)
    sequence: int = 0     # account sequence number as Horizon sees it

    @property
    def xlm_spendable(self) -> int:
        return self.xlm_balance - self.min_balance - self.xlm_liabilities


def parse_account(record: dict) -> dict:
    """Balances and reserve from a Horizon account record, in stroops."""
    counts = [int(record.get(k, 0)) for k in ("subentry_count", "num_sponsoring", "num_sponsored")]
    result = {"min_balance": (2 + counts[0] + counts[1] - counts[2]) * BASE_RESERVE,
              "sequence": int(record.get("sequence", 0)),
              "xlm_balance": 0, "xlm_liabilities": 0, "has_trustline": False,
              "usdc_balance": 0, "usdc_limit": 0, "usdc_authorized": False}
    for balance in record["balances"]:
        if balance.get("asset_type") == "native":
            result["xlm_balance"] = to_stroops(balance["balance"])
            result["xlm_liabilities"] = to_stroops(balance.get("selling_liabilities", "0"))
        elif (balance.get("asset_code"), balance.get("asset_issuer")) == (USDC_CODE, USDC_ISSUER):
            result.update(
                has_trustline=True,
                usdc_balance=to_stroops(balance["balance"])
                - to_stroops(balance.get("selling_liabilities", "0")),
                usdc_limit=to_stroops(balance["limit"]),
                usdc_authorized=bool(balance.get("is_authorized", True)),
            )
    return result


def usdc_asset():
    from aquarius import Asset
    return Asset.classic(USDC_CODE, USDC_ISSUER)


def sentinel_pool(client):
    """The pinned pool, confirmed through the router's own pool registry."""
    from aquarius import XLM as XLM_ASSET
    if client.network.router != ROUTER or client.network.passphrase != MAINNET:
        raise Stop("the SDK's mainnet router or passphrase differs from the pinned values")
    pools = [p for p in client.pools_for_pair(XLM_ASSET, usdc_asset()) if p.address == POOL]
    if len(pools) != 1 or pools[0].type != "volatile":
        raise Stop(f"router registry does not list {POOL} as a volatile XLM/USDC pool")
    if list(pools[0].tokens) != [XLM_SAC, USDC_SAC]:
        raise Stop("sentinel pool tokens differ from [XLM SAC, USDC SAC]")
    return pools[0]


def check_network(server) -> None:
    if server.get_network().passphrase != MAINNET:
        raise Stop("Soroban RPC is not on mainnet")
    root = requests.get(HORIZON_URL, timeout=20).json()
    if root.get("network_passphrase") != MAINNET:
        raise Stop("Horizon is not on mainnet")


def read_state(account: str, client, server) -> State:
    response = requests.get(f"{HORIZON_URL}/accounts/{account}", timeout=20)
    if response.status_code == 404:
        raise Stop(f"account {account} does not exist")
    response.raise_for_status()
    balances = parse_account(response.json())
    pool = sentinel_pool(client)
    reserve_xlm, reserve_usdc = pool.reserves()
    if reserve_xlm <= 0 or reserve_usdc <= 0:
        raise Stop("sentinel pool is empty")
    return State(account=account, shares=pool.share_balance(account),
                 reserve_xlm=reserve_xlm, reserve_usdc=reserve_usdc,
                 total_shares=pool.total_shares(), pool_hash=pool.pool_hash, **balances)


# --- planning (pure) --------------------------------------------------------------------


def paired_usdc(state: State, xlm_amount: int) -> int:
    """USDC desired alongside xlm_amount: pool ratio + 1%, rounded up (the exporter's rule)."""
    return ceil_div(xlm_amount * state.reserve_usdc * 101, state.reserve_xlm * 100)


def swap_out(state: State, xlm_in: int, fee_bps: int = 10) -> int:
    """Constant-product output for xlm_in (planning only; execution uses the router quote)."""
    effective = xlm_in * (10_000 - fee_bps)
    return state.reserve_usdc * effective // (state.reserve_xlm * 10_000 + effective)


@dataclass(frozen=True)
class Step:
    kind: str           # "trustline" | "swap" | "deposit"
    xlm_in: int = 0     # XLM leaving the wallet (swap input, deposit leg)
    usdc_in: int = 0    # USDC desired for a deposit
    reserve: int = 0    # native newly locked as reserve
    fee: int = 0        # max fee (inclusion bid + resource fee)
    fee_source: str = "estimate"
    usdc_out: int = 0   # expected USDC received (swap) or used (deposit)
    # Slippage guard: swap out_min (USDC) or deposit min_shares. make_plan fills
    # an estimate for display; build_step replaces it with the exact guard that
    # goes into the transaction, and verify_envelope requires that exact value.
    min_out: int = 0
    min_out_source: str = "estimate"


@dataclass(frozen=True)
class Plan:
    steps: list
    probe_usdc: int
    usdc_floor: int
    spend: int
    xlm_after: int
    spendable_after: int
    usdc_after: int
    problems: list


def make_plan(state: State, simulated_fees: dict | None = None) -> Plan:
    """Steps still needed, in order. simulated_fees replaces the fee estimate of
    steps that could be simulated; the trustline fee is the exact classic bid."""
    simulated_fees = simulated_fees or {}
    fees = {**FEE_ESTIMATE, **simulated_fees}
    sources = {k: "simulated" if k in simulated_fees else "estimate" for k in FEE_ESTIMATE}
    sources["trustline"] = "exact"
    probe_usdc = paired_usdc(state, PROBE_DEPOSIT_XLM)
    usdc_floor = PROBE_USDC_MULTIPLE * probe_usdc
    needs_deposit = state.shares <= 0
    deposit_usdc = paired_usdc(state, FIXTURE_DEPOSIT_XLM) if needs_deposit else 0
    deposit_used = ceil_div(FIXTURE_DEPOSIT_XLM * state.reserve_usdc, state.reserve_xlm) if needs_deposit else 0
    usdc_needed = usdc_floor + deposit_usdc
    problems, steps = [], []

    if not state.has_trustline:
        steps.append(Step("trustline", reserve=BASE_RESERVE, fee=fees["trustline"],
                          fee_source=sources["trustline"]))
    elif not state.usdc_authorized:
        problems.append("the USDC trustline is not authorized")
    if state.has_trustline and state.usdc_limit < usdc_needed:
        problems.append(f"the USDC trustline limit {fmt(state.usdc_limit)} is below {fmt(usdc_needed)}")

    usdc_have = state.usdc_balance
    if usdc_have < usdc_needed:
        missing = usdc_needed - usdc_have
        raw = ceil_div(missing * state.reserve_xlm * SWAP_BUFFER_BPS, state.reserve_usdc * 9_990)
        xlm_in = ceil_div(raw, SWAP_ROUNDING) * SWAP_ROUNDING
        out = swap_out(state, xlm_in)
        steps.append(Step("swap", xlm_in=xlm_in, fee=fees["swap"], fee_source=sources["swap"],
                          usdc_out=out, min_out=out * (10_000 - SLIPPAGE_BPS) // 10_000))
        if out < missing:
            problems.append("the planned swap would not deliver enough USDC")
        usdc_have += out
    if needs_deposit:
        shares = FIXTURE_DEPOSIT_XLM * state.total_shares // state.reserve_xlm
        steps.append(Step("deposit", xlm_in=FIXTURE_DEPOSIT_XLM, usdc_in=deposit_usdc,
                          fee=fees["deposit"], fee_source=sources["deposit"], usdc_out=deposit_used,
                          min_out=shares * (10_000 - SLIPPAGE_BPS) // 10_000))
        usdc_have -= deposit_used

    spend = sum(s.xlm_in + s.reserve + s.fee for s in steps)
    xlm_after = state.xlm_balance - sum(s.xlm_in + s.fee for s in steps)
    spendable_after = (xlm_after - state.min_balance - state.xlm_liabilities
                       - sum(s.reserve for s in steps))
    if spend > MAX_SPEND:
        problems.append(f"planned spend {fmt(spend)} XLM exceeds the {fmt(MAX_SPEND)} XLM cap")
    if steps and xlm_after < MIN_XLM_AFTER:
        problems.append(f"XLM would drop to {fmt(xlm_after)}, below {fmt(MIN_XLM_AFTER)}: top up "
                        f"at least {fmt(MIN_XLM_AFTER - xlm_after)} XLM to {state.account} first")
    if steps and spendable_after < 0:
        problems.append("the wallet cannot cover the plan above its minimum balance")
    return Plan(steps=steps, probe_usdc=probe_usdc, usdc_floor=usdc_floor, spend=spend,
                xlm_after=xlm_after, spendable_after=spendable_after, usdc_after=usdc_have,
                problems=problems)


def fixture_report(state: State) -> list:
    """(requirement, satisfied, required-for-probes) rows for --check."""
    probe_usdc = paired_usdc(state, PROBE_DEPOSIT_XLM)
    return [
        (f"USDC trustline ({USDC_CODE}:{USDC_ISSUER[:8]}...)", state.has_trustline and state.usdc_authorized, True),
        (f"free USDC {fmt(state.usdc_balance)} >= probe deposit leg {fmt(probe_usdc)}",
         state.usdc_balance >= probe_usdc, True),
        (f"free USDC {fmt(state.usdc_balance)} >= {PROBE_USDC_MULTIPLE}x leg {fmt(PROBE_USDC_MULTIPLE * probe_usdc)}",
         state.usdc_balance >= PROBE_USDC_MULTIPLE * probe_usdc, False),
        (f"spendable XLM {fmt(state.xlm_spendable)} >= probe deposit {fmt(PROBE_DEPOSIT_XLM)}",
         state.xlm_spendable >= PROBE_DEPOSIT_XLM, True),
        (f"LP shares {fmt(state.shares)} > 0", state.shares > 0, True),
        (f"LP shares {fmt(state.shares)} >= probe withdraw {fmt(PROBE_WITHDRAW_SHARES)}",
         state.shares >= PROBE_WITHDRAW_SHARES, False),
        (f"total XLM {fmt(state.xlm_balance)} >= {fmt(MIN_XLM_AFTER)} (E2E warning level)",
         state.xlm_balance >= MIN_XLM_AFTER, False),
    ]


# --- transactions ---------------------------------------------------------------------


def router_call(server, account: str, function: str, parameters: list):
    """Build, simulate and assemble a router call. Never restores; stops instead."""
    from stellar_sdk import TransactionBuilder
    tx = (TransactionBuilder(server.load_account(account), MAINNET, base_fee=INCLUSION_FEE)
          .append_invoke_contract_function_op(contract_id=ROUTER, function_name=function,
                                              parameters=parameters)
          .set_timeout(TX_TIMEOUT).build())
    simulation = server.simulate_transaction(tx)
    if simulation.restore_preamble is not None:
        raise Stop(f"simulating {function} reports archived ledger entries that need a restore. "
                   "This script never restores; let the background restore process handle it "
                   "(or restore deliberately) and re-run.")
    if simulation.error:
        raise Stop(f"simulating {function} failed: {simulation.error.splitlines()[0][:300]}")
    if not simulation.results or not simulation.results[0].xdr:
        raise Stop(f"simulating {function} returned no result")
    return server.prepare_transaction(tx, simulation), simulation


def simulated_value(simulation):
    from stellar_sdk import scval
    from stellar_sdk.xdr import SCVal
    return scval.to_native(SCVal.from_xdr(simulation.results[0].xdr))


def swap_params(state: State, amount_in: int, out_min: int) -> list:
    from stellar_sdk import scval
    return [scval.to_address(state.account),
            scval.to_vec([scval.to_address(XLM_SAC), scval.to_address(USDC_SAC)]),
            scval.to_address(XLM_SAC), scval.to_address(USDC_SAC),
            scval.to_bytes(state.pool_hash), scval.to_uint128(amount_in), scval.to_uint128(out_min)]


def deposit_params(state: State, desired: list, min_shares: int) -> list:
    from stellar_sdk import scval
    return [scval.to_address(state.account),
            scval.to_vec([scval.to_address(XLM_SAC), scval.to_address(USDC_SAC)]),
            scval.to_bytes(state.pool_hash),
            scval.to_vec([scval.to_uint128(a) for a in desired]), scval.to_uint128(min_shares)]


def withdraw_params(state: State, shares: int) -> list:
    from stellar_sdk import scval
    return [scval.to_address(state.account),
            scval.to_vec([scval.to_address(XLM_SAC), scval.to_address(USDC_SAC)]),
            scval.to_bytes(state.pool_hash), scval.to_uint128(shares),
            scval.to_vec([scval.to_uint128(0), scval.to_uint128(0)])]


GUARD_TOLERANCE_BPS = 300  # exact guard may sit at most 3% below the plan's reserve-based estimate


def check_guard(step: Step, guard: int, expected: int, what: str) -> int:
    """0 < guard <= expected, and not far below the plan's own estimate."""
    if not 0 < guard <= expected:
        raise Stop(f"degenerate {step.kind} guard: {what} {guard} for expected {expected}; "
                   f"not submitting the {step.kind}")
    if step.min_out > 0 and guard * 10_000 < step.min_out * (10_000 - GUARD_TOLERANCE_BPS):
        raise Stop(f"{step.kind} guard {what} {fmt(guard)} is more than 3% below the planned "
                   f"{fmt(step.min_out)}; pool state moved, re-run to plan again")
    return guard


def swap_guard(step: Step, amount_out: int, guard: int) -> int:
    """The router estimate's guard (estimate - 1%)."""
    return check_guard(step, guard, amount_out, "out_min")


def deposit_guard(step: Step, simulated_shares: int) -> int:
    """min_shares = simulated mint - 1%."""
    return check_guard(step, simulated_shares * (10_000 - SLIPPAGE_BPS) // 10_000,
                       simulated_shares, "min_shares")


def build_step(step: Step, state: State, server, client):
    """Simulated, assembled, unsigned envelope for the step, the step carrying the exact
    guard that went into it, and a description of its simulated result."""
    from stellar_sdk import Asset, TransactionBuilder
    if step.kind == "trustline":
        tx = (TransactionBuilder(server.load_account(state.account), MAINNET, base_fee=INCLUSION_FEE)
              .append_change_trust_op(asset=Asset(USDC_CODE, USDC_ISSUER))
              .set_timeout(TX_TIMEOUT).build())
        return tx, step, "USDC ChangeTrust checked"
    if step.kind == "swap":
        from aquarius import XLM as XLM_ASSET
        quote = sentinel_pool(client).quote(XLM_ASSET, usdc_asset(), amount_in=step.xlm_in,
                                            slippage=SLIPPAGE_BPS / 10_000)
        guard = swap_guard(step, int(quote.amount_out), int(quote.guard))
        envelope, simulation = router_call(server, state.account, "swap",
                                           swap_params(state, step.xlm_in, guard))
        out = int(simulated_value(simulation))
        if out < guard:
            raise Stop("simulated swap output is below the slippage guard")
        step = replace(step, min_out=guard, min_out_source="router estimate - 1%")
        return envelope, step, f"swaps {fmt(step.xlm_in)} XLM for ~{fmt(out)} USDC (out_min {fmt(guard)})"
    if step.kind == "deposit":
        desired = [step.xlm_in, step.usdc_in]
        _, simulation = router_call(server, state.account, "deposit", deposit_params(state, desired, 0))
        _, shares = simulated_value(simulation)
        min_shares = deposit_guard(step, int(shares))
        envelope, simulation = router_call(server, state.account, "deposit",
                                           deposit_params(state, desired, min_shares))
        amounts, shares = simulated_value(simulation)
        if int(shares) < min_shares:
            raise Stop("simulated deposit mints fewer shares than its guard")
        step = replace(step, min_out=min_shares, min_out_source="simulated mint - 1%")
        return envelope, step, (f"deposits {fmt(amounts[0])} XLM + {fmt(amounts[1])} USDC for "
                                f"~{fmt(int(shares))} shares (min_shares {fmt(min_shares)})")
    raise Stop(f"unknown step {step.kind}")


def verify_envelope(envelope, step: Step, state: State) -> None:
    """Allowlist: only the planned operation on the pinned contracts, source-account auth only."""
    from stellar_sdk import Address, scval
    from stellar_sdk.operation import ChangeTrust, InvokeHostFunction
    from stellar_sdk.xdr import HostFunctionType, SorobanAuthorizedFunctionType, SorobanCredentialsType
    tx = envelope.transaction
    if envelope.network_passphrase != MAINNET:
        raise Stop("transaction is not built for mainnet")
    if tx.source.account_id != state.account or len(tx.operations) != 1:
        raise Stop("unexpected transaction source or operation count")
    if tx.fee > FEE_CEILING[step.kind]:
        raise Stop(f"{step.kind} fee {fmt(tx.fee)} XLM exceeds its {fmt(FEE_CEILING[step.kind])} XLM ceiling")
    if tx.preconditions is None or tx.preconditions.time_bounds is None \
            or tx.preconditions.time_bounds.max_time <= 0:
        raise Stop("transaction has no upper time bound")
    [op] = tx.operations
    if op.source is not None and op.source.account_id != state.account:
        raise Stop("unexpected operation source")
    if step.kind == "trustline":
        if not isinstance(op, ChangeTrust) or (op.asset.code, op.asset.issuer) != (USDC_CODE, USDC_ISSUER):
            raise Stop("trustline step is not a USDC ChangeTrust")
        return
    if not isinstance(op, InvokeHostFunction) \
            or op.host_function.type != HostFunctionType.HOST_FUNCTION_TYPE_INVOKE_CONTRACT:
        raise Stop("expected a contract invocation")
    call = op.host_function.invoke_contract
    if Address.from_xdr_sc_address(call.contract_address).address != ROUTER \
            or call.function_name.sc_symbol.decode() != step.kind:
        raise Stop(f"expected router.{step.kind}")
    args = [scval.to_native(a) for a in call.args]
    tokens = [a.address for a in args[1]]
    if args[0].address != state.account or tokens != [XLM_SAC, USDC_SAC]:
        raise Stop("unexpected user or token arguments")
    if step.kind == "swap":
        ok = (len(args) == 7 and (args[2].address, args[3].address, args[4], args[5])
              == (XLM_SAC, USDC_SAC, state.pool_hash, step.xlm_in))
        guard = args[6] if len(args) == 7 else None
        limits = {XLM_SAC: step.xlm_in}
    else:
        ok = len(args) == 5 and (args[2], list(args[3])) == (state.pool_hash, [step.xlm_in, step.usdc_in])
        guard = args[4] if len(args) == 5 else None
        limits = {XLM_SAC: step.xlm_in, USDC_SAC: step.usdc_in}
    if not ok:
        raise Stop("router arguments differ from the plan")
    if not (isinstance(step.min_out, int) and step.min_out > 0 and guard == step.min_out):
        raise Stop(f"{step.kind} slippage guard {guard} differs from the planned {step.min_out} "
                   "or is not positive")
    if not op.auth:
        raise Stop("no authorization entries")

    def walk(invocation, depth):
        function = invocation.function
        if function.type != SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN:
            raise Stop("authorization tree contains a non-contract function")
        fn = function.contract_fn
        contract = Address.from_xdr_sc_address(fn.contract_address).address
        name = fn.function_name.sc_symbol.decode()
        if contract not in ALLOWED_CONTRACTS:
            raise Stop(f"authorization tree touches a contract outside the allowlist: {contract}")
        if depth == 0 and (contract, name) != (ROUTER, step.kind):
            raise Stop("authorization root is not the planned router call")
        if name == "transfer":
            source, target, amount = [scval.to_native(a) for a in fn.args]
            if source.address != state.account or target.address != POOL \
                    or amount > limits.get(contract, -1):
                raise Stop("authorized transfer differs from the plan")
        elif name not in {"swap", "deposit"}:
            raise Stop(f"authorization tree contains {name}")
        for sub in invocation.sub_invocations:
            walk(sub, depth + 1)

    for entry in op.auth:
        if entry.credentials.type != SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT:
            raise Stop("authorization needs a separate signature; expected source-account auth only")
        walk(entry.root_invocation, 0)


def result_code(result_xdr: str | None) -> str:
    from stellar_sdk.xdr import TransactionResult
    try:
        return TransactionResult.from_xdr(result_xdr).result.code.name
    except Exception:
        return "unknown"


def submit_and_wait(server, envelope, sleep=time.sleep, now=time.time, poll_seconds=2.0):
    """Send once, then follow the hash. Never resubmits: a transaction that is not
    found after its time bound has passed can no longer be applied."""
    from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus
    tx_hash = envelope.hash_hex()
    max_time = envelope.transaction.preconditions.time_bounds.max_time
    print(f"    tx {tx_hash}\n    {EXPLORER}{tx_hash}", flush=True)
    try:
        sent = server.send_transaction(envelope)
    except Exception as error:
        print(f"    sendTransaction raised {type(error).__name__}; outcome unknown, following the hash")
        sent = None
    if sent is not None and sent.status == SendTransactionStatus.ERROR:
        raise Stop(f"rejected on submission ({result_code(sent.error_result_xdr)}); nothing was applied")
    if sent is not None and sent.status == SendTransactionStatus.TRY_AGAIN_LATER:
        print("    RPC deferred it (TRY_AGAIN_LATER); not resending, waiting for its time bound")
    deadline = max_time + STATUS_GRACE_SECONDS
    while True:
        try:
            result = server.get_transaction(tx_hash)
        except Exception as error:
            result = None
            print(f"    getTransaction raised {type(error).__name__}; retrying the lookup")
        if result is not None:
            if result.status == GetTransactionStatus.SUCCESS:
                return result
            if result.status == GetTransactionStatus.FAILED:
                raise Stop(f"failed on-chain ({result_code(result.result_xdr)}); fees were charged. "
                           "Inspect it before re-running; a re-run re-reads the chain.")
            if result.latest_ledger_close_time > max_time:
                raise Stop("not included before its time bound passed, so it can never apply. "
                           "Re-run to plan again from the chain state.")
        if now() > deadline:
            raise Stop(f"cannot determine the outcome of {tx_hash}; check the explorer before re-running")
        sleep(poll_seconds)


def return_value(result):
    from stellar_sdk import scval
    from stellar_sdk.xdr import TransactionMeta
    if not result.result_meta_xdr:
        return None
    meta = TransactionMeta.from_xdr(result.result_meta_xdr)
    soroban = meta.v4.soroban_meta if meta.v == 4 else meta.v3.soroban_meta
    return scval.to_native(soroban.return_value) if soroban and soroban.return_value else None


# --- signer ---------------------------------------------------------------------------


def load_signer(environ=os.environ):
    """Keypair from MAINNET_E2E_SECRET; the value never appears in output or errors."""
    from stellar_sdk import Keypair
    secret = environ.get("MAINNET_E2E_SECRET", "").strip()
    if not secret:
        raise Stop("set MAINNET_E2E_SECRET in the environment (never on the command line)")
    try:
        keypair = Keypair.from_secret(secret)
    except Exception:
        keypair = None
    del secret
    if keypair is None:
        raise Stop("MAINNET_E2E_SECRET is not a valid Stellar secret seed")
    if keypair.public_key != EXPECTED_ACCOUNT:
        raise Stop(f"refusing: the key derives to {keypair.public_key}, not {EXPECTED_ACCOUNT}")
    return keypair


# --- output ---------------------------------------------------------------------------


def print_state(state: State, title: str) -> None:
    print(f"{title} ({state.account})")
    print(f"  XLM   total {fmt(state.xlm_balance)}  min balance {fmt(state.min_balance)}  "
          f"spendable {fmt(state.xlm_spendable)}")
    print(f"  USDC  trustline {'yes' if state.has_trustline else 'no'}  free {fmt(state.usdc_balance)}")
    print(f"  LP    shares {fmt(state.shares)} in {POOL}")
    print(f"  pool  reserves {fmt(state.reserve_xlm)} XLM / {fmt(state.reserve_usdc)} USDC, "
          f"price {state.reserve_usdc / state.reserve_xlm:.6f} USDC/XLM")


def print_plan(plan: Plan, notes: dict) -> None:
    print(f"probe deposit USDC leg {fmt(plan.probe_usdc)}; USDC floor after the plan "
          f"({PROBE_USDC_MULTIPLE}x) {fmt(plan.usdc_floor)}")
    if not plan.steps:
        print("plan: nothing to do; the fixture is already in place")
    for number, step in enumerate(plan.steps, 1):
        detail = {"trustline": f"add USDC trustline (locks {fmt(step.reserve)} XLM reserve)",
                  "swap": f"swap {fmt(step.xlm_in)} XLM -> ~{fmt(step.usdc_out)} USDC via the sentinel pool",
                  "deposit": f"deposit {fmt(step.xlm_in)} XLM + up to {fmt(step.usdc_in)} USDC "
                             f"(~{fmt(step.usdc_out)} used) into the sentinel pool"}[step.kind]
        print(f"  {number}. {detail}; max fee {fmt(step.fee)} XLM ({step.fee_source})")
        if step.kind != "trustline":
            unit = "USDC out_min" if step.kind == "swap" else "min_shares"
            print(f"     guard: {unit} {fmt(step.min_out)} ({step.min_out_source})")
        if step.kind in notes:
            print(f"     {notes[step.kind]}")
    if plan.steps:
        print(f"  XLM spent incl. reserve and fees <= {fmt(plan.spend)} (cap {fmt(MAX_SPEND)})")
        print(f"  after: XLM total >= {fmt(plan.xlm_after)} (spendable {fmt(plan.spendable_after)}), "
              f"free USDC ~{fmt(plan.usdc_after)}, LP shares > 0")
    for problem in plan.problems:
        print(f"  REFUSED: {problem}")


# --- modes ----------------------------------------------------------------------------


def clients():
    from aquarius import AquariusClient
    from stellar_sdk import SorobanServer
    from stellar_sdk.client.requests_client import RequestsClient
    client = AquariusClient(network="mainnet")  # no signer: reads only, no SDK restore path
    # No HTTP-level retries: every send is a single deliberate request.
    server = SorobanServer(RPC_URL, RequestsClient(num_retries=0))
    check_network(server)
    return client, server


def run_check(account: str) -> int:
    from stellar_sdk import StrKey
    if not StrKey.is_valid_ed25519_public_key(account):
        raise Stop("--account must be a public key (G...)")
    client, server = clients()
    state = read_state(account, client, server)
    print_state(state, "fixture check")
    required_ok = True
    for label, ok, required in fixture_report(state):
        required_ok &= ok or not required
        print(f"  [{'ok' if ok else ('FAIL' if required else 'warn')}] {label}")
    # The same simulations the exporter runs.
    probes = {}
    try:
        desired = [PROBE_DEPOSIT_XLM, paired_usdc(state, PROBE_DEPOSIT_XLM)]
        router_call(server, account, "deposit", deposit_params(state, desired, 0))
        probes["deposit_simulation"] = "passes"
    except Stop as error:
        probes["deposit_simulation"] = f"fails: {error}"
    if state.shares > 0:
        try:
            router_call(server, account, "withdraw",
                        withdraw_params(state, min(PROBE_WITHDRAW_SHARES, state.shares)))
            probes["withdraw_simulation"] = "passes"
        except Stop as error:
            probes["withdraw_simulation"] = f"fails: {error}"
    else:
        probes["withdraw_simulation"] = "fails: no LP shares"
    for name, outcome in probes.items():
        print(f"  {name}: {outcome}")
    ok = required_ok and all(v == "passes" for v in probes.values())
    print("fixture satisfies the exporter" if ok else "fixture does NOT satisfy the exporter")
    return 0 if ok else 1


def simulate_plan(plan: Plan, state: State, client, server) -> tuple[dict, dict, dict]:
    """Simulate every step whose inputs exist now; later steps keep fee and guard estimates."""
    fees, notes, guards = {}, {}, {}
    for step in plan.steps:
        ready = {"trustline": True, "swap": state.has_trustline,
                 "deposit": state.has_trustline and state.usdc_balance >= step.usdc_in}[step.kind]
        if not ready:
            before = "the trustline" if step.kind == "swap" else "the USDC from the swap"
            notes[step.kind] = f"not simulated: needs {before} first; fee is an estimate"
            continue
        envelope, built, description = build_step(step, state, server, client)
        verify_envelope(envelope, built, state)
        if step.kind != "trustline":
            fees[step.kind] = envelope.transaction.fee
            guards[step.kind] = (built.min_out, built.min_out_source)
        notes[step.kind] = f"{'built' if step.kind == 'trustline' else 'simulated'}: {description}"
    return fees, notes, guards


def with_guards(plan: Plan, guards: dict) -> Plan:
    """Show exact simulated guards in the printed plan (execution rebuilds them anyway)."""
    steps = [replace(s, min_out=guards[s.kind][0], min_out_source=guards[s.kind][1])
             if s.kind in guards else s for s in plan.steps]
    return replace(plan, steps=steps)


def run_dry(environ) -> int:
    if environ.get("MAINNET_E2E_SECRET"):
        load_signer(environ)  # identity check only; nothing is signed in a dry run
        print("MAINNET_E2E_SECRET matches the expected account (not used in a dry run)")
    client, server = clients()
    state = read_state(EXPECTED_ACCOUNT, client, server)
    print_state(state, "current state")
    fees, notes, guards = simulate_plan(make_plan(state), state, client, server)
    plan = with_guards(make_plan(state, fees), guards)
    print("DRY RUN, nothing submitted")
    print_plan(plan, notes)
    return 2 if plan.problems else 0


def wait_for_horizon(sequence: int, sleep=time.sleep, attempts: int = 30) -> None:
    """Balances come from Horizon; wait until it has ingested the confirmed transaction."""
    for _ in range(attempts):
        response = requests.get(f"{HORIZON_URL}/accounts/{EXPECTED_ACCOUNT}", timeout=20)
        if response.ok and int(response.json().get("sequence", 0)) >= sequence:
            return
        sleep(2)
    raise Stop("Horizon has not caught up with the confirmed transaction; re-run shortly "
               "(the next run re-reads the chain and skips completed steps)")


def run_execute(environ, assume_yes: bool) -> int:
    keypair = load_signer(environ)
    client, server = clients()
    start = read_state(EXPECTED_ACCOUNT, client, server)
    print_state(start, "current state")
    fees, notes, guards = simulate_plan(make_plan(start), start, client, server)
    plan = with_guards(make_plan(start, fees), guards)
    print_plan(plan, notes)
    if plan.problems:
        return 2
    if not plan.steps:
        return run_check(EXPECTED_ACCOUNT)
    if not assume_yes and input("type EXECUTE to sign and submit these steps: ").strip() != "EXECUTE":
        print("aborted; nothing submitted")
        return 1
    done = set()
    while True:
        state = read_state(EXPECTED_ACCOUNT, client, server)
        plan = make_plan(state)
        if plan.problems:
            raise Stop("; ".join(plan.problems))
        if not plan.steps:
            break
        step = plan.steps[0]
        if step.kind in done:
            raise Stop(f"{step.kind} already ran but is still needed; stopping for manual inspection")
        envelope, step, description = build_step(step, state, server, client)
        verify_envelope(envelope, step, state)
        spent = (start.xlm_balance - state.xlm_balance) + (state.min_balance - start.min_balance)
        worst = spent + step.xlm_in + step.reserve + envelope.transaction.fee
        if worst > MAX_SPEND:
            raise Stop(f"{step.kind} would take total spend to {fmt(worst)} XLM, over the {fmt(MAX_SPEND)} cap")
        print(f"{step.kind}: {description}; fee <= {fmt(envelope.transaction.fee)} XLM")
        envelope.sign(keypair)
        result = submit_and_wait(server, envelope)
        done.add(step.kind)
        wait_for_horizon(envelope.transaction.sequence)
        value = return_value(result)
        print(f"    confirmed in ledger {result.ledger}" + (f"; returned {value}" if value is not None else ""))
    print_state(read_state(EXPECTED_ACCOUNT, client, server), "final state")
    return run_check(EXPECTED_ACCOUNT)


def main(argv=None, environ=os.environ) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="read-only fixture check, no secret")
    mode.add_argument("--execute", action="store_true", help="sign and submit (needs MAINNET_E2E_SECRET)")
    parser.add_argument("--account", default=EXPECTED_ACCOUNT, help="public key for --check")
    parser.add_argument("--yes", action="store_true", help="skip the interactive confirmation")
    args = parser.parse_args(argv)
    try:
        if args.check:
            return run_check(args.account)
        if args.account != EXPECTED_ACCOUNT:
            raise Stop("--account applies to --check only")
        return run_execute(environ, args.yes) if args.execute else run_dry(environ)
    except Stop as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
