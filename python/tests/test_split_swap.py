import json
from pathlib import Path
from unittest.mock import Mock, patch

from aquarius import ApiClient, normalize_swap_split_plan

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
