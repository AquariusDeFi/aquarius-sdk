"""HTTP error metadata stays useful to callers without retaining response bodies."""
from datetime import datetime, timezone
from unittest.mock import Mock, patch

import pytest

import aquarius
from aquarius import APIHTTPError, ApiClient, AquariusError
from aquarius.api import _parse_retry_after


@pytest.mark.parametrize(
    ("method", "args", "verb", "message"),
    [
        ("find_path", ({"amount": "1"}, True), "post", "Find-path request failed"),
        ("find_path_split", ({"amount": "1"},), "post", "Find-path-split request failed"),
        ("pools_by_addresses", (["pool"],), "get", "Pools request failed"),
        ("user_pools", ("account",), "get", "User pools request failed"),
        ("create_limit_order_draft", ("https://registry.invalid", {"proof": "PRIVATE_PROOF"}), "post", "Limit-order draft request failed"),
        ("list_limit_orders", ("https://registry.invalid", {}), "get", "Limit-order list request failed"),
        ("get_limit_order", ("https://registry.invalid", "order-id"), "get", "Limit-order detail request failed"),
    ],
)
def test_http_failures_expose_metadata_without_body_or_automatic_retry(method, args, verb, message):
    response = Mock(ok=False, status_code=429, headers={"Retry-After": "7"})
    response.json.return_value = {"detail": "PRIVATE_PROOF"}
    with patch("aquarius.api.requests.get", return_value=response) as get, patch("aquarius.api.requests.post", return_value=response) as post:
        with pytest.raises(AquariusError) as caught:
            getattr(ApiClient("https://api.invalid"), method)(*args)
    error = caught.value
    assert isinstance(error, APIHTTPError)
    assert (error.status_code, error.retry_after) == (429, 7.0)
    assert str(error) == f"{message}: HTTP 429"
    assert "PRIVATE_PROOF" not in repr(vars(error))
    response.json.assert_not_called()
    request = post if verb == "post" else get
    request.assert_called_once()
    assert request.call_args.kwargs["timeout"] == 30
    (get if verb == "post" else post).assert_not_called()


@pytest.mark.parametrize(
    ("value", "expected"),
    [("12", 12.0), (" 1.5 ", 1.5), ("0", 0.0), (None, None), ("", None),
     ("invalid", None), ("-1", None), ("nan", None), ("inf", None),
     ("Thu, 15 Oct 2026 12:01:30 GMT", 90.0), ("Thu, 15 Oct 2026 11:59:00 GMT", 0.0),
     ("Thu, 99 Oct 2026 12:00:00 GMT", None)],
)
def test_retry_after_normalizes_numeric_and_http_date(value, expected):
    now = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)
    assert _parse_retry_after(value, now=now) == expected


def test_non_rate_limit_http_error_remains_typed_without_retry_header():
    response = Mock(ok=False, status_code=503, headers={})
    with patch("aquarius.api.requests.get", return_value=response):
        with pytest.raises(APIHTTPError) as caught:
            ApiClient("https://api.invalid").get_limit_order("https://registry.invalid", "order-id")
    assert (caught.value.status_code, caught.value.retry_after) == (503, None)
    assert caught.value.tx_hash is None


def test_user_pools_404_remains_empty():
    response = Mock(ok=False, status_code=404, headers={})
    with patch("aquarius.api.requests.get", return_value=response):
        assert ApiClient("https://api.invalid").user_pools("account") == []
    response.json.assert_not_called()


def test_http_error_is_part_of_public_surface():
    assert "APIHTTPError" in aquarius.__all__
    assert issubclass(APIHTTPError, AquariusError)
