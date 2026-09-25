"""Offline tests for probe_fixture.py: no network, no secret, nothing can be submitted."""
from dataclasses import replace
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Asset, Keypair, TransactionBuilder, scval
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus

import probe_fixture as f

XLM = f.XLM
# Mainnet wallet and pool state read on 2026-09-23.
WALLET = f.State(account=f.EXPECTED_ACCOUNT, xlm_balance=146_968_179, min_balance=15_000_000,
                 xlm_liabilities=0, has_trustline=False, usdc_balance=0, usdc_limit=0,
                 usdc_authorized=False, shares=0, reserve_xlm=87_210_619_742_495,
                 reserve_usdc=18_540_535_248_089, total_shares=36_515_598_599_051,
                 pool_hash=b"\xb2" * 32)
DONE = replace(WALLET, min_balance=20_000_000, has_trustline=True, usdc_authorized=True,
               usdc_balance=1_059_784, usdc_limit=9_223_372_036_854_775_807, shares=4_187_058,
               xlm_balance=118_268_179)


def test_parse_horizon_account():
    record = {"subentry_count": 2, "num_sponsoring": 0, "num_sponsored": 0, "balances": [
        {"asset_type": "credit_alphanum4", "asset_code": "USDC", "asset_issuer": f.USDC_ISSUER,
         "balance": "0.1059784", "selling_liabilities": "0.0000000", "limit": "922337203685.4775807",
         "is_authorized": True},
        {"asset_type": "credit_alphanum4", "asset_code": "AQUA", "asset_issuer": "G" + "A" * 55,
         "balance": "5.0000000", "limit": "1.0000000"},
        {"asset_type": "native", "balance": "11.8268179", "selling_liabilities": "0.5000000"}]}
    record["sequence"] = "273850181399610204"
    assert f.parse_account(record) == {
        "sequence": 273850181399610204, "min_balance": 20_000_000, "xlm_balance": 118_268_179, "xlm_liabilities": 5_000_000,
        "has_trustline": True, "usdc_balance": 1_059_784,
        "usdc_limit": 9_223_372_036_854_775_807, "usdc_authorized": True}
    record["balances"] = record["balances"][2:]
    assert f.parse_account(record)["has_trustline"] is False


def test_plan_for_the_current_wallet():
    plan = f.make_plan(WALLET)
    assert [s.kind for s in plan.steps] == ["trustline", "swap", "deposit"]
    trustline, swap, deposit = plan.steps
    assert trustline.reserve == f.BASE_RESERVE and trustline.fee == f.INCLUSION_FEE
    assert swap.xlm_in == 15_000_000 and swap.xlm_in % f.SWAP_ROUNDING == 0
    assert deposit.xlm_in == XLM and deposit.usdc_in == f.paired_usdc(WALLET, XLM)
    assert plan.probe_usdc == f.paired_usdc(WALLET, f.PROBE_DEPOSIT_XLM)
    assert swap.usdc_out >= deposit.usdc_in + plan.usdc_floor
    assert plan.usdc_after >= plan.usdc_floor
    assert plan.spend == 5_000_000 + 100_000 + 15_000_000 + 600_000 + XLM + 3_000_000
    assert plan.spend <= f.MAX_SPEND and plan.xlm_after >= f.MIN_XLM_AFTER
    assert plan.problems == []


def test_plan_is_a_no_op_once_the_fixture_exists():
    plan = f.make_plan(DONE)
    assert plan.steps == [] and plan.problems == [] and plan.spend == 0


def test_plan_resumes_after_a_partial_run():
    after_trustline = replace(WALLET, has_trustline=True, usdc_authorized=True,
                              usdc_limit=10**15, min_balance=20_000_000, xlm_balance=146_968_079)
    assert [s.kind for s in f.make_plan(after_trustline).steps] == ["swap", "deposit"]
    after_swap = replace(after_trustline, usdc_balance=3_185_734, xlm_balance=131_815_000)
    assert [s.kind for s in f.make_plan(after_swap).steps] == ["deposit"]
    # LP present but USDC spent: only top the free USDC back up.
    drained = replace(DONE, usdc_balance=0)
    plan = f.make_plan(drained)
    assert [s.kind for s in plan.steps] == ["swap"]
    assert plan.steps[0].usdc_out >= plan.usdc_floor


def test_plan_refuses_low_xlm_and_says_how_much_to_top_up():
    plan = f.make_plan(replace(WALLET, xlm_balance=12 * XLM))
    [problem] = plan.problems
    assert "top up at least 0.8700000 XLM" in problem  # 12 - 0.01 - 1.5 - 0.06 - 1 - 0.3 = 9.13


def test_plan_refuses_over_the_spend_cap():
    plan = f.make_plan(WALLET, {"deposit": 4_000_000, "swap": 1_000_000})
    assert any("exceeds the 3.5000000 XLM cap" in p for p in plan.problems)
    assert f.make_plan(WALLET, {"deposit": 2_583_698, "swap": 153_199}).problems == []


def test_plan_refuses_unauthorized_or_low_limit_trustline():
    assert f.make_plan(replace(DONE, usdc_authorized=False)).problems
    assert f.make_plan(replace(DONE, usdc_limit=10)).problems


def test_fixture_report_matches_exporter_requirements():
    assert all(ok for label, ok, required in f.fixture_report(DONE))
    failing = [label for label, ok, required in f.fixture_report(WALLET) if required and not ok]
    assert [label.split(" ")[:2] for label in failing] == [["USDC", "trustline"], ["free", "USDC"],
                                                           ["LP", "shares"]]


SEED = Keypair.random().secret


def test_signer_never_leaks_the_secret(capsys):
    with pytest.raises(f.Stop, match="set MAINNET_E2E_SECRET"):
        f.load_signer({})
    bad = "S" + SEED[1:-1] + ("A" if SEED[-1] != "A" else "B")
    with pytest.raises(f.Stop) as error:
        f.load_signer({"MAINNET_E2E_SECRET": bad})
    assert bad not in str(error.value) and error.value.__context__ is None
    with pytest.raises(f.Stop, match="refusing: the key derives to") as error:
        f.load_signer({"MAINNET_E2E_SECRET": SEED})
    assert SEED not in str(error.value)
    assert SEED not in capsys.readouterr().out


def test_execute_without_secret_submits_nothing(monkeypatch, capsys):
    monkeypatch.setattr(f, "clients", lambda: pytest.fail("no network before the key check"))
    assert f.main(["--execute", "--yes"], environ={}) == 3
    assert f.main(["--execute", "--yes"], environ={"MAINNET_E2E_SECRET": SEED}) == 3
    assert SEED not in capsys.readouterr().err


def envelope(max_time=1_000):
    source = Account(f.EXPECTED_ACCOUNT, 1)
    tx = (TransactionBuilder(source, f.MAINNET, base_fee=100)
          .append_change_trust_op(asset=Asset(f.USDC_CODE, f.USDC_ISSUER))
          .add_time_bounds(0, max_time).build())
    return tx


class FakeRpc:
    def __init__(self, statuses, send_status=SendTransactionStatus.PENDING, send_raises=False):
        self.statuses, self.send_status, self.send_raises = list(statuses), send_status, send_raises
        self.sent = 0

    def send_transaction(self, envelope):
        self.sent += 1
        if self.send_raises:
            raise ConnectionError("reset")
        return SimpleNamespace(status=self.send_status, error_result_xdr=None)

    def get_transaction(self, tx_hash):
        status, close_time = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return SimpleNamespace(status=status, latest_ledger_close_time=close_time,
                               result_xdr=None, ledger=7)


NOT_FOUND, SUCCESS, FAILED = (GetTransactionStatus.NOT_FOUND, GetTransactionStatus.SUCCESS,
                              GetTransactionStatus.FAILED)


def wait(rpc, env=None):
    return f.submit_and_wait(rpc, env or envelope(), sleep=lambda _: None, now=lambda: 0)


def test_submit_sends_once_and_follows_the_hash():
    rpc = FakeRpc([(NOT_FOUND, 900), (NOT_FOUND, 950), (SUCCESS, 960)])
    assert wait(rpc).status == SUCCESS and rpc.sent == 1


def test_submit_never_resends_after_the_time_bound():
    rpc = FakeRpc([(NOT_FOUND, 990), (NOT_FOUND, 1_005)])
    with pytest.raises(f.Stop, match="can never apply"):
        wait(rpc)
    assert rpc.sent == 1
    rpc = FakeRpc([(NOT_FOUND, 1_005)], send_status=SendTransactionStatus.TRY_AGAIN_LATER)
    with pytest.raises(f.Stop, match="can never apply"):
        wait(rpc)
    assert rpc.sent == 1


def test_submit_outcomes_when_send_fails_or_is_rejected():
    rpc = FakeRpc([(SUCCESS, 900)], send_raises=True)
    assert wait(rpc).status == SUCCESS and rpc.sent == 1
    with pytest.raises(f.Stop, match="rejected on submission"):
        wait(FakeRpc([(SUCCESS, 900)], send_status=SendTransactionStatus.ERROR))
    with pytest.raises(f.Stop, match="failed on-chain"):
        wait(FakeRpc([(FAILED, 900)]))


def test_submit_gives_up_without_resending_when_status_is_unknowable():
    class Down(FakeRpc):
        def get_transaction(self, tx_hash):
            raise ConnectionError("down")
    rpc, clock = Down([]), iter(range(0, 10_000, 100))
    with pytest.raises(f.Stop, match="cannot determine the outcome"):
        f.submit_and_wait(rpc, envelope(), sleep=lambda _: None, now=lambda: next(clock))
    assert rpc.sent == 1


def test_router_call_stops_on_restore_or_error_without_assembling():
    class Rpc:
        def __init__(self, simulation):
            self.simulation = simulation
        def load_account(self, account):
            return Account(account, 1)
        def simulate_transaction(self, tx):
            return self.simulation
        def prepare_transaction(self, *a):
            pytest.fail("must not assemble")
    base = dict(error=None, results=[SimpleNamespace(xdr="AAAA")], restore_preamble=None)
    with pytest.raises(f.Stop, match="never restores"):
        f.router_call(Rpc(SimpleNamespace(**(base | {"restore_preamble": object(), "error": "x"}))),
                      f.EXPECTED_ACCOUNT, "swap", [])
    with pytest.raises(f.Stop, match="failed: HostError"):
        f.router_call(Rpc(SimpleNamespace(**(base | {"error": "HostError: x\nmore"}))),
                      f.EXPECTED_ACCOUNT, "swap", [])


def deposit_envelope(state, step, auth, fee=2_000_000, contract=f.ROUTER, min_shares=None):
    from stellar_sdk import TransactionBuilder as Builder
    guard = step.min_out if min_shares is None else min_shares
    tx = (Builder(Account(state.account, 1), f.MAINNET, base_fee=fee)
          .append_invoke_contract_function_op(
              contract_id=contract, function_name="deposit",
              parameters=f.deposit_params(state, [step.xlm_in, step.usdc_in], guard), auth=auth)
          .set_timeout(90).build())
    return tx


def swap_envelope(state, step, out_min=None):
    from aquarius.authorization import authorized_invocation, source_account_entry
    guard = step.min_out if out_min is None else out_min
    params = f.swap_params(state, step.xlm_in, guard)
    transfer = authorized_invocation(f.XLM_SAC, "transfer", [
        scval.to_address(state.account), scval.to_address(f.POOL), scval.to_int128(step.xlm_in)])
    auth = [source_account_entry(authorized_invocation(
        f.ROUTER, "swap", params, [authorized_invocation(f.POOL, "swap", [], [transfer])]))]
    return (TransactionBuilder(Account(state.account, 1), f.MAINNET, base_fee=150_000)
            .append_invoke_contract_function_op(contract_id=f.ROUTER, function_name="swap",
                                                parameters=params, auth=auth)
            .set_timeout(90).build())


def auth_tree(state, step, transfer_to=f.POOL, token=f.USDC_SAC, amount=None, credentials=None):
    from aquarius.authorization import authorized_invocation, source_account_entry
    transfers = [authorized_invocation(t, "transfer", [
        scval.to_address(state.account), scval.to_address(transfer_to),
        scval.to_int128(a if amount is None else amount)])
        for t, a in [(f.XLM_SAC, step.xlm_in), (token, step.usdc_in)]]
    pool = authorized_invocation(f.POOL, "deposit", [], transfers)
    entry = source_account_entry(authorized_invocation(
        f.ROUTER, "deposit", f.deposit_params(state, [step.xlm_in, step.usdc_in], step.min_out), [pool]))
    if credentials is not None:
        entry.credentials = credentials
    return [entry]


def test_verify_envelope_allowlist():
    step = f.make_plan(WALLET).steps[2]
    f.verify_envelope(deposit_envelope(WALLET, step, auth_tree(WALLET, step)), step, WALLET)
    stranger = "CDLJFX3H3V4WJ4SYNBWUUFKMIYCZVZ3BMHSD6C53RKR7YBLYPBHFLF6X"
    bad = {
        "outside the allowlist": auth_tree(WALLET, step, token=stranger),
        "transfer differs": auth_tree(WALLET, step, transfer_to=f.ROUTER),
        "differs from the plan": auth_tree(WALLET, step, amount=step.usdc_in + XLM),
    }
    for message, auth in bad.items():
        with pytest.raises(f.Stop, match=message):
            f.verify_envelope(deposit_envelope(WALLET, step, auth), step, WALLET)
    from stellar_sdk.xdr import SorobanCredentials, SorobanCredentialsType
    address_auth = auth_tree(WALLET, step, credentials=SorobanCredentials(
        type=SorobanCredentialsType.SOROBAN_CREDENTIALS_ADDRESS))
    with pytest.raises(f.Stop, match="source-account auth only"):
        f.verify_envelope(deposit_envelope(WALLET, step, address_auth), step, WALLET)
    with pytest.raises(f.Stop, match="exceeds its"):
        f.verify_envelope(deposit_envelope(WALLET, step, auth_tree(WALLET, step), fee=5_000_000),
                          step, WALLET)
    with pytest.raises(f.Stop, match="expected router.deposit"):
        f.verify_envelope(deposit_envelope(WALLET, step, auth_tree(WALLET, step), contract=f.POOL),
                          step, WALLET)
    with pytest.raises(f.Stop, match="router arguments differ"):
        f.verify_envelope(deposit_envelope(WALLET, step, auth_tree(WALLET, step)),
                          replace(step, usdc_in=step.usdc_in + 1), WALLET)
    with pytest.raises(f.Stop, match="no authorization entries"):
        f.verify_envelope(deposit_envelope(WALLET, step, []), step, WALLET)


def test_verify_trustline_envelope():
    step = f.make_plan(WALLET).steps[0]
    tx = (TransactionBuilder(Account(f.EXPECTED_ACCOUNT, 1), f.MAINNET, base_fee=f.INCLUSION_FEE)
          .append_change_trust_op(asset=Asset(f.USDC_CODE, f.USDC_ISSUER)).set_timeout(90).build())
    f.verify_envelope(tx, step, WALLET)
    other = (TransactionBuilder(Account(f.EXPECTED_ACCOUNT, 1), f.MAINNET, base_fee=f.INCLUSION_FEE)
             .append_change_trust_op(asset=Asset("USDC", Keypair.random().public_key)).set_timeout(90).build())
    with pytest.raises(f.Stop, match="not a USDC ChangeTrust"):
        f.verify_envelope(other, step, WALLET)
    testnet = (TransactionBuilder(Account(f.EXPECTED_ACCOUNT, 1), "Test SDF Network ; September 2015",
                                  base_fee=f.INCLUSION_FEE)
               .append_change_trust_op(asset=Asset(f.USDC_CODE, f.USDC_ISSUER)).set_timeout(90).build())
    with pytest.raises(f.Stop, match="not built for mainnet"):
        f.verify_envelope(testnet, step, WALLET)


class ExecuteHarness:
    """run_execute with every network edge faked; the chain state advances per submission."""
    def __init__(self, monkeypatch, states, effective=True, fee=None):
        self.states, self.effective, self.submitted = list(states), effective, []
        self.keypair = Keypair.random()
        self.current = self.states.pop(0)
        monkeypatch.setattr(f, "load_signer", lambda environ: self.keypair)
        monkeypatch.setattr(f, "clients", lambda: (object(), object()))
        monkeypatch.setattr(f, "read_state", lambda account, client, server: self.current)
        monkeypatch.setattr(f, "wait_for_horizon", lambda sequence: None)
        monkeypatch.setattr(f, "run_check", lambda account: 0)
        monkeypatch.setattr(f, "return_value", lambda result: None)
        def build_step(step, state, server, client):
            if step.kind == "trustline":
                tx = (TransactionBuilder(Account(state.account, 1), f.MAINNET, base_fee=f.INCLUSION_FEE)
                      .append_change_trust_op(asset=Asset(f.USDC_CODE, f.USDC_ISSUER))
                      .set_timeout(90).build())
            else:  # shape is irrelevant here: verify_envelope is covered separately
                tx = deposit_envelope(state, step, auth_tree(state, step),
                                      fee=fee or (150_000 if step.kind == "swap" else 2_000_000))
            return tx, step, step.kind
        monkeypatch.setattr(f, "build_step", build_step)
        monkeypatch.setattr(f, "verify_envelope", lambda envelope, step, state: None)
        def submit(server, envelope):
            assert envelope.signatures, "must be signed before submission"
            self.submitted.append(envelope)
            if self.effective and self.states:
                self.current = self.states.pop(0)
            return SimpleNamespace(ledger=1)
        monkeypatch.setattr(f, "submit_and_wait", submit)


AFTER_TRUSTLINE = replace(WALLET, has_trustline=True, usdc_authorized=True, usdc_limit=10**15,
                          min_balance=20_000_000, xlm_balance=146_968_079)
AFTER_SWAP = replace(AFTER_TRUSTLINE, usdc_balance=3_185_734, xlm_balance=131_815_000)


def test_execute_runs_each_step_once_in_order(monkeypatch):
    harness = ExecuteHarness(monkeypatch, [WALLET, AFTER_TRUSTLINE, AFTER_SWAP, DONE])
    assert f.run_execute({}, assume_yes=True) == 0
    assert len(harness.submitted) == 3


def test_execute_is_a_no_op_on_a_complete_fixture(monkeypatch):
    harness = ExecuteHarness(monkeypatch, [DONE])
    assert f.run_execute({}, assume_yes=True) == 0
    assert harness.submitted == []


def test_execute_stops_when_a_step_had_no_effect(monkeypatch):
    harness = ExecuteHarness(monkeypatch, [WALLET], effective=False)
    with pytest.raises(f.Stop, match="trustline already ran but is still needed"):
        f.run_execute({}, assume_yes=True)
    assert len(harness.submitted) == 1


def test_execute_requires_typed_confirmation(monkeypatch):
    harness = ExecuteHarness(monkeypatch, [WALLET])
    monkeypatch.setattr("builtins.input", lambda prompt: "yes")
    assert f.run_execute({}, assume_yes=False) == 1
    assert harness.submitted == []


def test_execute_enforces_the_running_spend_cap(monkeypatch):
    # The swap landed but the wallet lost 0.6 XLM elsewhere meanwhile: the deposit
    # would take the total spend past the cap although the plan alone looks fine.
    drained = replace(AFTER_SWAP, xlm_balance=AFTER_SWAP.xlm_balance - 6 * XLM // 10)
    assert f.make_plan(drained).problems == []
    harness = ExecuteHarness(monkeypatch, [WALLET, AFTER_TRUSTLINE, drained])
    with pytest.raises(f.Stop, match="deposit would take total spend to 3.8153179 XLM"):
        f.run_execute({}, assume_yes=True)
    assert len(harness.submitted) == 2


def test_plan_carries_positive_guard_estimates():
    _, swap, deposit = f.make_plan(WALLET).steps
    assert 0 < swap.min_out <= swap.usdc_out and swap.min_out == swap.usdc_out * 99 // 100
    assert deposit.min_out == (XLM * WALLET.total_shares // WALLET.reserve_xlm) * 99 // 100 > 0


def test_verify_envelope_requires_the_exact_positive_guard():
    _, swap, deposit = f.make_plan(WALLET).steps
    f.verify_envelope(swap_envelope(WALLET, swap), swap, WALLET)
    f.verify_envelope(deposit_envelope(WALLET, deposit, auth_tree(WALLET, deposit)), deposit, WALLET)
    for out_min in (0, swap.min_out - 1, swap.min_out + 1):
        with pytest.raises(f.Stop, match="swap slippage guard"):
            f.verify_envelope(swap_envelope(WALLET, swap, out_min=out_min), swap, WALLET)
    for min_shares in (0, 1, deposit.min_out - 1):
        with pytest.raises(f.Stop, match="deposit slippage guard"):
            f.verify_envelope(deposit_envelope(WALLET, deposit, auth_tree(WALLET, deposit),
                                               min_shares=min_shares), deposit, WALLET)
    # A step whose guard is zero cannot pass even when the envelope matches it.
    zero = replace(swap, min_out=0)
    with pytest.raises(f.Stop, match="not positive"):
        f.verify_envelope(swap_envelope(WALLET, zero), zero, WALLET)


def build_with(monkeypatch, step, quote=None, shares=None):
    monkeypatch.setattr(f, "sentinel_pool", lambda client: SimpleNamespace(
        quote=lambda *a, **k: quote))
    calls = []
    def router_call(server, account, function, parameters):
        calls.append(function)
        simulation = SimpleNamespace(value=([step.xlm_in, step.usdc_in], shares)
                                     if function == "deposit" else quote.amount_out)
        return SimpleNamespace(transaction=None), simulation
    monkeypatch.setattr(f, "router_call", router_call)
    monkeypatch.setattr(f, "simulated_value", lambda simulation: simulation.value)
    return f.build_step(step, WALLET, None, None), calls


def test_build_step_stops_on_degenerate_guards(monkeypatch):
    _, swap, deposit = f.make_plan(WALLET).steps
    for quote in [SimpleNamespace(amount_out=swap.usdc_out, guard=0),
                  SimpleNamespace(amount_out=swap.usdc_out, guard=swap.usdc_out + 1),
                  SimpleNamespace(amount_out=0, guard=0)]:
        with pytest.raises(f.Stop, match="degenerate swap guard"):
            build_with(monkeypatch, swap, quote=quote)
    for shares in (0, 1):
        with pytest.raises(f.Stop, match="degenerate deposit guard"):
            build_with(monkeypatch, deposit, shares=shares)
    # Sane but far below what the plan expected from the reserves it just read.
    with pytest.raises(f.Stop, match="more than 3% below the planned"):
        build_with(monkeypatch, swap, quote=SimpleNamespace(amount_out=swap.usdc_out // 2,
                                                            guard=swap.usdc_out // 2 * 99 // 100))


def test_build_step_puts_the_exact_guard_on_the_step(monkeypatch):
    _, swap, deposit = f.make_plan(WALLET).steps
    quote = SimpleNamespace(amount_out=swap.usdc_out + 10, guard=(swap.usdc_out + 10) * 99 // 100)
    (_, built, _), calls = build_with(monkeypatch, swap, quote=quote)
    assert built.min_out == quote.guard and calls == ["swap"]
    shares = deposit.min_out * 100 // 99 + 5
    (_, built, _), calls = build_with(monkeypatch, deposit, shares=shares)
    assert built.min_out == shares * 99 // 100 and calls == ["deposit", "deposit"]
