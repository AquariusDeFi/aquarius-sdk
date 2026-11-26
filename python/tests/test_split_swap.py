import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from stellar_sdk import Keypair, scval

from aquarius import (
    APIHTTPError, ApiClient, AquariusClient, Asset, ProviderFeeConfig, SlippageError,
    build_swap_split_operation, normalize_swap_split_plan,
)

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "testdata/split-plans.json").read_text()
)


def test_find_path_split_posts_the_quote_request():
    response = Mock(ok=True)
    response.json.return_value = FIXTURE["plans"]["diamond"]["response"]
    with patch("aquarius.api.requests.post", return_value=response) as post:
        quote = ApiClient("https://api.invalid/v2").find_path_split(FIXTURE["request"])
    post.assert_called_once_with(
        "https://api.invalid/v2/find-path-split/", json=FIXTURE["request"], timeout=30
    )
    r = FIXTURE["request"]
    plan = normalize_swap_split_plan(
        quote, r["token_in_address"], r["token_out_address"], r["amount"]
    )
    assert [[part.share for part in stage] for stage in plan.stages] == [
        [10000],
        [3500, 6500],
    ]


def test_find_path_quote_keeps_its_endpoints():
    response = Mock(ok=True)
    response.json.return_value = {}
    with patch("aquarius.api.requests.post", return_value=response) as post:
        ApiClient("https://api.invalid/v2").find_path({"amount": "1"}, True)
        ApiClient("https://api.invalid/v2").find_path({"amount": "1"}, False)
    assert [call.args[0] for call in post.call_args_list] == [
        "https://api.invalid/v2/find-path/",
        "https://api.invalid/v2/find-path-strict-receive/",
    ]


def test_swap_retries_exact_input_with_new_plan_and_returns_confirmed_output(monkeypatch):
    signer = Keypair.random()
    client = AquariusClient(network="testnet", signer=signer)
    request = {k: FIXTURE["request"][k] for k in ("token_in_address", "token_out_address", "amount")}
    token_in, token_out, amount = request.values()
    responses = [FIXTURE["plans"][name]["response"] for name in ("single", "parallel")]
    quotes = Mock(side_effect=responses)
    monkeypatch.setattr(client.api, "find_path_split", quotes)
    monkeypatch.setattr(client.api, "find_path", Mock(side_effect=AssertionError("unexpected chained quote")))

    def prepare(source, append, restore_signer):
        response = responses[quotes.call_count - 1]
        expected = build_swap_split_operation(
            source=source, router=client.network.router, token_in=token_in, token_out=token_out,
            plan=normalize_swap_split_plan(response, token_in, token_out, amount),
            minimum=str(int(response["amount_out"]) * 99 // 100),
        )
        builder = Mock()
        append(builder)
        assert builder.append_operation.call_args.args[0].to_xdr_object() == expected.to_xdr_object()
        if quotes.call_count == 1:
            raise SlippageError("guard breached")
        return "prepared"

    monkeypatch.setattr(client.engine, "prepare", prepare)
    received = int(responses[1]["amount_out"]) + 1
    submit = Mock(return_value=SimpleNamespace(tx_hash="confirmed", return_value=scval.to_uint128(received)))
    monkeypatch.setattr(client.engine, "sign_and_submit", submit)
    receipt = client.swap(Asset.contract(token_in), Asset.contract(token_out), amount_in=int(amount), retries=1)
    assert (receipt.tx_hash, receipt.amount_in, receipt.amount_out) == ("confirmed", int(amount), received)
    assert [c.args for c in quotes.call_args_list] == [(request,), (request,)]
    submit.assert_called_once_with("prepared", signer)


@pytest.mark.parametrize("status", [404, 405, 503, 200])
def test_swap_falls_back_only_when_split_endpoint_is_unavailable(monkeypatch, status):
    client = AquariusClient(network="testnet")
    request = FIXTURE["request"]
    args = (Asset.contract(request["token_in_address"]), Asset.contract(request["token_out_address"]))
    kwargs = {"amount_in": int(request["amount"])}
    quote = Mock()
    quote.return_value.execute.return_value = "legacy receipt"
    monkeypatch.setattr(client, "quote", quote)
    response = Mock(ok=status == 200, status_code=status, headers={})
    response.json.return_value = {"success": True}
    with patch("aquarius.api.requests.post", return_value=response):
        if status in (404, 405):
            assert client.swap(*args, **kwargs) == "legacy receipt"
            quote.assert_called_once_with(*args, **kwargs, slippage=0.01)
        else:
            with pytest.raises((APIHTTPError, ValueError), match="HTTP 503|Invalid swap quote"):
                client.swap(*args, **kwargs)
            quote.assert_not_called()


def test_swap_with_provider_fee_uses_chained_collector(monkeypatch):
    client = AquariusClient(network="testnet")
    fee = ProviderFeeConfig(FIXTURE["collector"], 3, 1000)
    request = FIXTURE["request"]
    args = (Asset.contract(request["token_in_address"]), Asset.contract(request["token_out_address"]))
    quote = Mock()
    quote.return_value.execute.return_value = "collector receipt"
    monkeypatch.setattr(client, "quote", quote)
    monkeypatch.setattr(client.api, "find_path_split", Mock(side_effect=AssertionError("unexpected split quote")))
    assert client.swap(*args, amount_in=100, provider_fee=fee) == "collector receipt"
    assert quote.call_args.kwargs["provider_fee"] == fee
