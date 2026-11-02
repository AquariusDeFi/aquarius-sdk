from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests

from .errors import APIHTTPError, NoRouteError


def _parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    if value is None:
        return None
    try:
        delay = float(value)
    except (ValueError, TypeError):
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - (now or datetime.now(timezone.utc))).total_seconds())
        except (ValueError, TypeError, OverflowError):
            return None
    return delay if math.isfinite(delay) and delay >= 0 else None


def _http_error(message: str, response: requests.Response) -> APIHTTPError:
    return APIHTTPError(
        f"{message}: HTTP {response.status_code}",
        status_code=response.status_code,
        retry_after=_parse_retry_after(response.headers.get("Retry-After")),
    )


@dataclass
class ParsedRoute:
    amount_in: int
    amount_out: int
    guard: int
    route: list[str]
    swap_chain_xdr: str


class ApiClient:
    """Typed client for the public backend API."""

    def __init__(self, base_url: str):
        self.base_url = base_url

    def find_path(self, request: dict, exact_input: bool) -> dict:
        endpoint = "/find-path/" if exact_input else "/find-path-strict-receive/"
        response = requests.post(f"{self.base_url}{endpoint}", json=request, timeout=30)
        if not response.ok:
            raise _http_error("Find-path request failed", response)
        return response.json()

    def pools_by_addresses(self, addresses: list[str]) -> list[dict]:
        """Indexed metadata for the given pool addresses (type, fee, token labels)."""
        response = requests.get(
            f"{self.base_url}/pools/",
            params={"address__in": ",".join(addresses)},
            timeout=30,
        )
        if not response.ok:
            raise _http_error("Pools request failed", response)
        return response.json().get("results", [])

    def user_pools(self, address: str) -> list[dict]:
        """Pools where the address holds a position. Empty when it holds none."""
        response = requests.get(f"{self.base_url}/pools/user/{address}/", timeout=30)
        if response.status_code == 404:
            return []
        if not response.ok:
            raise _http_error("User pools request failed", response)
        data = response.json()
        return data.get("results", data) if isinstance(data, dict) else data

    def create_limit_order_draft(self, base_url: str, request: dict) -> dict:
        response = requests.post(
            f"{base_url.rstrip('/')}/drafts/",
            json=request,
            timeout=30,
        )
        if not response.ok:
            raise _http_error("Limit-order draft request failed", response)
        return response.json()

    def list_limit_orders(self, base_url: str, params: dict) -> dict:
        response = requests.get(
            f"{base_url.rstrip('/')}/orders/",
            params=params,
            timeout=30,
        )
        if not response.ok:
            raise _http_error("Limit-order list request failed", response)
        return response.json()

    def get_limit_order(self, base_url: str, order_id: str) -> dict:
        response = requests.get(
            f"{base_url.rstrip('/')}/orders/{order_id}/",
            timeout=30,
        )
        if not response.ok:
            raise _http_error("Limit-order detail request failed", response)
        return response.json()


def parse_find_path_response(
    response: dict,
    *,
    amount_in: int | None = None,
    amount_out: int | None = None,
    slippage_bps: int,
    pair_label: str,
) -> ParsedRoute:
    """Turn a find-path response into quote numbers.

    Guards: min-out rounds down, max-in rounds up — never in the caller's favor.
    """
    if not response.get("success"):
        raise NoRouteError(f"No route found for {pair_label}")
    quoted = int(response["amount"])
    if amount_in is not None:
        return ParsedRoute(
            amount_in=amount_in,
            amount_out=quoted,
            guard=quoted * (10_000 - slippage_bps) // 10_000,
            route=response["pools"],
            swap_chain_xdr=response["swap_chain_xdr"],
        )
    return ParsedRoute(
        amount_in=quoted,
        amount_out=amount_out,
        guard=(quoted * (10_000 + slippage_bps) + 9_999) // 10_000,
        route=response["pools"],
        swap_chain_xdr=response["swap_chain_xdr"],
    )
