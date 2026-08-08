"""Single-pool swaps: estimate wiring, guard math, and auth shape on a fake client."""
import pytest
from stellar_sdk import Address, scval

from aquarius import AquariusError
from aquarius.pool import Pool
from aquarius.submit import ConfirmedTx

XLM_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
AQUA_ID = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE"
POOL_ID = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"
OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER"


class FakeClient:
    def __init__(self, estimate: int):
        from aquarius.networks import NETWORKS

        self.network = NETWORKS["testnet"]
        self.estimate = estimate
        self.router_reads = []
        self.submitted = []
        self.submit_result = None

    def _read_source(self, require_signer=False):
        return OWNER

    def _read_router(self, fn, args):
        self.router_reads.append((fn, args))
        return scval.to_uint128(self.estimate)

    def _submit_contract(self, contract_id, fn, args, auth=None):
        self.submitted.append((contract_id, fn, args, auth))
        return ConfirmedTx(tx_hash="h", return_value=self.submit_result)


def volatile_pool(client):
    return Pool(
        address=POOL_ID,
        pool_hash=bytes(32),
        type="volatile",
        fee_bps=30,
        tokens=[XLM_ID, AQUA_ID],
        token_labels=[],
        _client=client,
    )


def test_quote_wires_the_pool_estimator_and_derives_the_guard():
    client = FakeClient(estimate=1000)
    quote = volatile_pool(client).quote(XLM_ID, AQUA_ID, amount_in=500)

    fn, args = client.router_reads[0]
    assert fn == "estimate_swap"
    assert [a.address for a in args[0].vec.sc_vec] != []  # tokens vec first
    assert scval.from_uint128(args[4]) == 500
    assert quote.amount_in == 500 and quote.amount_out == 1000
    assert quote.guard == 1000 * 9_900 // 10_000  # default 1% slippage


def test_quote_validates_input():
    pool = volatile_pool(FakeClient(estimate=1))
    with pytest.raises(AquariusError, match="strict-receive"):
        pool.quote(XLM_ID, AQUA_ID, amount_out=100)
    with pytest.raises(AquariusError, match="positive amount_in"):
        pool.quote(XLM_ID, AQUA_ID)
    with pytest.raises(AquariusError, match="not part of this pool"):
        pool.quote(XLM_ID, POOL_ID, amount_in=1)
    with pytest.raises(AquariusError, match="different tokens"):
        pool.quote(XLM_ID, XLM_ID, amount_in=1)


def test_execute_submits_a_pinned_router_swap_with_bounded_auth():
    client = FakeClient(estimate=1000)
    client.submit_result = scval.to_uint128(995)
    receipt = volatile_pool(client).quote(XLM_ID, AQUA_ID, amount_in=500).execute()

    contract, fn, args, auth = client.submitted[0]
    assert contract == client.network.router and fn == "swap"
    assert len(args) == 7
    assert scval.from_uint128(args[5]) == 500          # in_amount
    assert scval.from_uint128(args[6]) == 990          # out_min = the guard
    [entry] = auth
    root = entry.root_invocation
    assert root.function.contract_fn.function_name.sc_symbol == b"swap"
    # Nested exactly like the contracts call each other:
    # router.swap -> pool.swap (require_auth) -> transfer(user, pool, amount).
    [pool_swap] = root.sub_invocations
    pool_fn = pool_swap.function.contract_fn
    assert pool_fn.function_name.sc_symbol == b"swap"
    assert scval.from_uint32(pool_fn.args[1]) == 0   # in_idx (XLM)
    assert scval.from_uint32(pool_fn.args[2]) == 1   # out_idx (AQUA)
    assert scval.from_uint128(pool_fn.args[3]) == 500
    assert scval.from_uint128(pool_fn.args[4]) == 990
    [transfer] = pool_swap.sub_invocations
    transfer_fn = transfer.function.contract_fn
    assert transfer_fn.function_name.sc_symbol == b"transfer"
    assert Address.from_xdr_sc_address(transfer_fn.args[1].address).address == POOL_ID
    assert scval.from_int128(transfer_fn.args[2]) == 500
    assert receipt.amount_in == 500 and receipt.amount_out == 995
