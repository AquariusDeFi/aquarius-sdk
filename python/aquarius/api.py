from __future__ import annotations

from dataclasses import dataclass

import requests

from .errors import AquariusError, NoRouteError


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
            raise AquariusError(f"Find-path request failed: HTTP {response.status_code}")
        return response.json()

    def pools_by_addresses(self, addresses: list[str]) -> list[dict]:
        """Indexed metadata for the given pool addresses (type, fee, token labels)."""
        response = requests.get(
            f"{self.base_url}/pools/",
            params={"address__in": ",".join(addresses)},
            timeout=30,
        )
        if not response.ok:
            raise AquariusError(f"Pools request failed: HTTP {response.status_code}")
        return response.json().get("results", [])

    def user_pools(self, address: str) -> list[dict]:
        """Pools where the address holds a position. Empty when it holds none."""
        response = requests.get(f"{self.base_url}/pools/user/{address}/", timeout=30)
        if response.status_code == 404:
            return []
        if not response.ok:
            raise AquariusError(f"User pools request failed: HTTP {response.status_code}")
        data = response.json()
        return data.get("results", data) if isinstance(data, dict) else data

    def create_limit_order_draft(self, base_url: str, request: dict) -> dict:
        response = requests.post(
            f"{base_url.rstrip('/')}/drafts/",
            json=request,
            timeout=30,
        )
        if not response.ok:
            detail = None
            try:
                detail = response.json().get("detail")
            except Exception:  # noqa: BLE001 - best-effort API detail
                pass
            suffix = f": {detail}" if detail else ""
            raise AquariusError(
                f"Limit-order draft request failed: HTTP {response.status_code}{suffix}"
            )
        return response.json()

    def list_limit_orders(self, base_url: str, params: dict) -> dict:
        response = requests.get(
            f"{base_url.rstrip('/')}/orders/",
            params=params,
            timeout=30,
        )
        if not response.ok:
            raise AquariusError(
                f"Limit-order list request failed: HTTP {response.status_code}"
            )
        return response.json()

    def get_limit_order(self, base_url: str, order_id: str) -> dict:
        response = requests.get(
            f"{base_url.rstrip('/')}/orders/{order_id}/",
            timeout=30,
        )
        if not response.ok:
            raise AquariusError(
                f"Limit-order detail request failed: HTTP {response.status_code}"
            )
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
