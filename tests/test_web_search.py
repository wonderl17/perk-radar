"""Offline provider-boundary tests; run with the isolated search Python."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("web_search", Path(__file__).resolve().parents[1] / "scripts/web-search.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

HIT = {"title": "Official free labs", "href": "https://aws.amazon.com/education/free/", "body": "Free labs without a credit card."}
PAGE = "<html><title>Search</title><body>Search results</body></html>"


class Factory:
    def __init__(self, plans, clock=None):
        self.plans, self.calls, self.requests, self.clock = plans, [], [], clock

    def __call__(self, **kwargs):
        owner = self

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def _get_engines(self, category, backend):
                self.backend = backend
                plan = owner.plans.get(backend, {"status": 403})

                def request(*args, **kwargs):
                    owner.requests.append({"backend": backend, "timeout": kwargs.get("timeout")})
                    if owner.clock:
                        owner.clock.now += min(plan.get("seconds", 0), kwargs["timeout"])
                    if plan.get("exception"):
                        raise plan["exception"]("private diagnostic URL and secret")
                    return SimpleNamespace(status_code=plan.get("status", 200), text=plan.get("text", PAGE))

                self.engine = SimpleNamespace(name=backend, http_client=SimpleNamespace(request=request))
                return [self.engine]

            def text(self, query, **kwargs):
                owner.calls.append({"query": query, **kwargs})
                plan = owner.plans.get(self.backend, {"status": 403})
                for _ in range(plan.get("requests", 1)):
                    self.engine.http_client.request("GET", "https://provider.invalid/search")
                if not plan.get("hits"):
                    from ddgs.exceptions import DDGSException
                    raise DDGSException("No results found.")
                return plan["hits"]

        return Client()


class SearchTests(unittest.TestCase):
    def test_non_200_is_not_empty_and_fallback_keeps_original_query(self):
        query = "site:aws.amazon.com AWS Educate FAQ free labs age credit card"
        factory = Factory({"yahoo": {"status": 429}, "brave": {"hits": [HIT]}})
        response = bridge.search(query, 5, client_factory=factory)
        self.assertEqual(response["status"], "ok")
        self.assertEqual([x["status"] for x in response["attempts"]], ["blocked", "ok"])
        self.assertEqual([x["query"] for x in factory.calls], [query, query])
        self.assertEqual([x["region"] for x in factory.calls], ["us-en", "us-en"])
        self.assertEqual([x["backend"] for x in factory.calls], ["yahoo", "brave"])

    def test_blocked_statuses_and_challenge_pages_never_become_empty(self):
        for plan in [{"status": status} for status in (202, 403, 429)] + [{"text": "<html><title>Captcha</title><body>no results found</body></html>"}]:
            with self.subTest(plan=plan):
                response = bridge.search("free credits", 5, client_factory=Factory({name: plan for name in bridge.BACKENDS}))
                self.assertEqual(response["error"], "SEARCH_UNAVAILABLE")
                self.assertEqual(len(response["attempts"]), 5)
                self.assertTrue(all(x["status"] == "blocked" for x in response["attempts"]))

    def test_recognized_empty_with_other_blocked_backends_remains_healthy_empty(self):
        factory = Factory({"yahoo": {"text": '<div class="compNoResult">We did not find results for: this query</div>'}})
        response = bridge.search("free credits", 5, client_factory=factory)
        self.assertEqual(response["status"], "empty")
        self.assertEqual(len(response["attempts"]), 5)
        self.assertEqual(response["attempts"][0]["status"], "empty")
        self.assertTrue(all(x["status"] == "blocked" for x in response["attempts"][1:]))
        self.assertEqual(response["results"], [])

    def test_empty_primary_does_not_hide_a_later_backend_hit(self):
        query = "site:aws.amazon.com official free labs"
        factory = Factory({"yahoo": {"text": '<div class="compNoResult">We did not find results for: this query</div>'}, "brave": {"hits": [HIT]}})
        response = bridge.search(query, 5, client_factory=factory)
        self.assertEqual(response["status"], "ok")
        self.assertEqual([x["status"] for x in response["attempts"]], ["empty", "ok"])
        self.assertEqual([x["query"] for x in factory.calls], [query, query])
        self.assertEqual(response["results"][0]["url"], HIT["href"])

    def test_http_200_without_parseable_results_is_unparsed_not_empty(self):
        response = bridge.search("free credits", 5, client_factory=Factory({name: {} for name in bridge.BACKENDS}))
        self.assertEqual(response["status"], "unavailable")
        self.assertTrue(all(x["status"] == "unparsed" for x in response["attempts"]))

    def test_site_operator_mismatch_falls_back_without_broadening_query(self):
        factory = Factory({"yahoo": {"hits": [{**HIT, "href": "https://unrelated.com/free/"}]}, "brave": {"hits": [{**HIT, "href": "https://docs.aws.amazon.com/free/"}]}})
        response = bridge.search("site:aws.amazon.com official free labs", 5, client_factory=factory)
        self.assertEqual(response["status"], "ok")
        self.assertEqual([x["status"] for x in response["attempts"]], ["unparsed", "ok"])
        self.assertEqual(response["results"][0]["url"], "https://docs.aws.amazon.com/free/")
        # Multiple sites and OR have provider-defined semantics; do not silently
        # reinterpret them as requiring both domains or a single domain.
        self.assertEqual(len(bridge.normalize_results([HIT], "site:one.com OR site:aws.amazon.com free", 5)), 1)

    def test_multirequest_backend_shares_total_deadline(self):
        clock = SimpleNamespace(now=0)
        factory = Factory({"yahoo": {"seconds": 0.6, "requests": 2}}, clock=clock)
        response = bridge.search("free credits", 5, timeout_ms=1500, client_factory=factory, clock=lambda: clock.now)
        self.assertEqual(response["error"], "SEARCH_TIMEOUT")
        self.assertLessEqual(clock.now, 1)
        self.assertAlmostEqual(factory.requests[0]["timeout"], 1)
        self.assertAlmostEqual(factory.requests[1]["timeout"], 0.4)
        self.assertEqual(len(response["attempts"]), 1)

    def test_timeout_and_generic_provider_errors_never_expose_diagnostics(self):
        from ddgs.exceptions import TimeoutException
        for error, expected in [(TimeoutException, "timeout"), (RuntimeError, "unavailable")]:
            response = bridge.search("免费 开发者 云额度 官方", 5, client_factory=Factory({name: {"exception": error} for name in bridge.BACKENDS}))
            self.assertTrue(all(x["status"] == expected for x in response["attempts"]))
            self.assertNotIn("private", str(response))
            self.assertEqual(response["error"], "SEARCH_TIMEOUT" if expected == "timeout" else "SEARCH_UNAVAILABLE")

    def test_pinned_ddgs_hooks_work_without_network(self):
        from ddgs import DDGS
        from unittest.mock import patch
        from ddgs.http_client import HttpClient
        # Exercise the real pinned cache, thread aggregation and parser rather
        # than merely duplicating the bridge's control flow in a fake client.
        html = '<div class="relsrch"><div class="Title"><h3>Official free labs</h3><a href="https://aws.amazon.com/education/free/">Link</a></div><div class="Text">Free labs.</div></div>'
        with patch.object(HttpClient, "request", return_value=SimpleNamespace(status_code=200, text=html)) as request:
            response = bridge.search("site:aws.amazon.com free labs", 5)
            self.assertEqual(response["status"], "ok")
            self.assertEqual(response["results"][0]["url"], HIT["href"])
            self.assertLessEqual(request.call_args.kwargs["timeout"], bridge.MAX_REQUEST_SECONDS)
        with patch.object(HttpClient, "request", return_value=SimpleNamespace(status_code=429, text="private")):
            response = bridge.search("free credits", 5)
            self.assertEqual(response["error"], "SEARCH_UNAVAILABLE")
            self.assertTrue(all(x["status"] == "blocked" for x in response["attempts"]))
        with patch.object(HttpClient, "request", return_value=SimpleNamespace(status_code=200, text='<div class="compNoResult">We did not find results for: no matches</div>')):
            response = bridge.search("free credits", 5)
            self.assertEqual(response["status"], "empty")
            self.assertEqual(len(response["attempts"]), 5)
            self.assertTrue(all(x["status"] == "empty" for x in response["attempts"]))


if __name__ == "__main__":
    unittest.main()
