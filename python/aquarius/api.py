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
