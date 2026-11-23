from unittest.mock import Mock

import pytest
from stellar_sdk import Keypair, TransactionEnvelope, scval
from stellar_sdk.soroban_rpc import AuthMode

from aquarius import AquariusClient, AquariusError
from test_submit import KEYPAIR, PASSPHRASE, PreparingServer

DELEGATE = Keypair.random().public_key


@pytest.mark.parametrize("build, proxy, method, args, transfer", [
    (lambda ice: ice.build_create_lock(100, 1209600), "locker", "create_lock", [100, 1209600], True),
    (lambda ice: ice.build_active_lock(100, 604800), "locker", "create_shelf", [100, 604800], True),
    (lambda ice: ice.build_start_unlock(2), "locker", "commit_shelf", [2], False),
    (lambda ice: ice.build_stop_unlock(3), "locker", "rearm_shelf", [3], False),
    (lambda ice: ice.build_withdraw(17), "locker", "withdraw", [17], False),
    (lambda ice: ice.build_delegate("upvote", DELEGATE, 2500000), "upvote", "delegate", [DELEGATE, 2500000], False),
    (lambda ice: ice.build_undelegate("govern", DELEGATE), "govern", "undelegate", [DELEGATE], False),
])
def test_ice_builds_an_unsigned_enforced_call(build, proxy, method, args, transfer):
    client = AquariusClient(network="testnet", signer=KEYPAIR, instruction_headroom=0)
    server = client.engine.server = PreparingServer()
    tx = TransactionEnvelope.from_xdr(build(client.ice), PASSPHRASE)
    assert not tx.signatures
    op, = tx.transaction.operations
    entry, = op.auth
    target = entry.root_invocation.function.contract_fn
    assert target == op.host_function.invoke_contract
    assert target.function_name.sc_symbol == method.encode()
    assert scval.to_address(getattr(client.ice.contracts, proxy)).address == target.contract_address
    values = [scval.to_native(arg) for arg in target.args]
    assert [getattr(value, "address", value) for value in values] == [KEYPAIR.public_key, *args]
    assert server.simulations == [(AuthMode.ENFORCE, [entry.to_xdr()])]
    children = entry.root_invocation.sub_invocations
    if transfer:
        child, = children
        call = child.function.contract_fn
        assert call.function_name.sc_symbol == b"transfer"
        assert call.contract_address == scval.to_address(client.ice.contracts.aqua_token).address
        assert [scval.from_address(arg).address for arg in call.args[:2]] == [KEYPAIR.public_key, client.ice.contracts.locker]
        assert scval.from_int128(call.args[2]) == 100
    else:
        assert not children


def test_ice_reads_preserve_precision_without_authorizing_a_restore():
    client = AquariusClient(network="testnet")
    owner = KEYPAIR.public_key
    power = 2 ** 62
    client._read_contract = Mock(return_value=scval.to_int128(power))
    for proxy, part, method in [("ice", "total", "balance"), ("govern", "incoming", "get_incoming_balance"),
                                ("upvote", "retained", "get_retained_balance")]:
        assert client.ice.balance(owner, proxy, part) == power
        client._read_contract.assert_called_with(getattr(client.ice.contracts, proxy), method,
                                                 [scval.to_address(owner)], allow_restore=False)

    client._read_contract.return_value = scval.to_vec([scval.to_vec([
        scval.to_address(DELEGATE), scval.to_uint32(2500000), scval.to_uint64(power),
    ])])
    assert client.ice.delegations(owner, "upvote") == [(DELEGATE, 2500000, power)]
    with pytest.raises(AquariusError, match="No ICE contracts"):
        AquariusClient().ice.balance(owner, "ice")
    with pytest.raises(AquariusError, match="fraction"):
        client.ice.build_delegate("upvote", DELEGATE, None)
