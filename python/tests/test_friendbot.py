"""Friendbot readiness checks never fund twice or retry infrastructure failures."""
from types import SimpleNamespace

import pytest
import requests
from stellar_sdk import Keypair, SorobanServer
from stellar_sdk.exceptions import AccountNotFoundException, SorobanRpcErrorResponse

from aquarius import AquariusClient, AquariusError
import aquarius.client as client_module


@pytest.fixture
def funding(monkeypatch):
    signer = Keypair.random()
    client = AquariusClient(
        network="testnet", signer=signer,
        horizon_url="https://horizon.example", rpc_url="https://rpc.example",
    )
    state = SimpleNamespace(
        now=0.0, horizon_ready_at=0, rpc_ready_at=0,
        horizon_status=200, rpc_error=None, friendbot_calls=0,
        horizon_calls=0, rpc_calls=0, slow_horizon=0, slow_rpc=0,
    )

    def sleep(seconds):
        state.now += seconds

    def get(url, *, timeout, params=None):
        if url == "https://friendbot.stellar.org":
            assert params == {"addr": signer.public_key}
            state.friendbot_calls += 1
            return SimpleNamespace(ok=True)
        assert url == f"https://horizon.example/accounts/{signer.public_key}"
        assert 0 < timeout <= 30 - state.now
        state.horizon_calls += 1
        state.now += state.slow_horizon
        status = 404 if state.now < state.horizon_ready_at else state.horizon_status
        return SimpleNamespace(ok=status == 200, status_code=status)

    def load_account(server, public_key):
        assert server.server_url == "https://rpc.example"
        assert public_key == signer.public_key
        assert server._client.num_retries == 0
        assert 0 < server._client.post_timeout <= 30 - state.now
        state.rpc_calls += 1
        state.now += state.slow_rpc
        if state.rpc_error is not None:
            raise state.rpc_error
        if state.now < state.rpc_ready_at:
            raise AccountNotFoundException(public_key)
        return object()

    monkeypatch.setattr(client_module.time, "monotonic", lambda: state.now)
    monkeypatch.setattr(client_module.time, "sleep", sleep)
    monkeypatch.setattr(client_module.requests, "get", get)
    monkeypatch.setattr(SorobanServer, "load_account", load_account)
    return client, state


def test_waits_for_horizon_and_rpc_after_funding_once(funding):
    client, state = funding
    state.horizon_ready_at = 1
    state.rpc_ready_at = 3
    assert client.fund_with_friendbot() is None
    assert state.now == 3
    assert state.rpc_calls == 3
    assert state.friendbot_calls == 1


def test_returns_immediately_when_both_backends_are_ready(funding):
    client, state = funding
    assert client.fund_with_friendbot() is None
    assert (state.horizon_calls, state.rpc_calls, state.now) == (1, 1, 0)


@pytest.mark.parametrize("backend", ["horizon", "rpc"])
def test_absence_times_out_without_refunding(funding, backend):
    client, state = funding
    setattr(state, f"{backend}_ready_at", float("inf"))
    with pytest.raises(AquariusError, match="Timed out.*Horizon.*RPC"):
        client.fund_with_friendbot()
    assert state.now == 30
    assert state.friendbot_calls == 1


@pytest.mark.parametrize("backend", ["horizon", "rpc"])
def test_request_time_counts_toward_deadline(funding, backend):
    client, state = funding
    setattr(state, f"{backend}_ready_at", float("inf"))
    setattr(state, f"slow_{backend}", 29.75)
    with pytest.raises(AquariusError, match="Timed out"):
        client.fund_with_friendbot()
    assert state.now == 30
    assert getattr(state, f"{backend}_calls") == 1


@pytest.mark.parametrize("status", [403, 429, 503])
def test_horizon_errors_are_not_retried(funding, status):
    client, state = funding
    state.horizon_status = status
    with pytest.raises(AquariusError, match=f"HTTP {status}"):
        client.fund_with_friendbot()
    assert (state.horizon_calls, state.now) == (1, 0)


@pytest.mark.parametrize("error", [
    SorobanRpcErrorResponse(-32603, "internal error"),
    requests.Timeout("RPC timed out"),
])
def test_rpc_errors_are_propagated_without_retry(funding, error):
    client, state = funding
    state.rpc_error = error
    with pytest.raises(type(error)) as caught:
        client.fund_with_friendbot()
    assert caught.value is error
    assert (state.rpc_calls, state.now) == (1, 0)
