#!/usr/bin/env python3
"""Offline reconciliation checks for sanitized capturer v6 and v7 exports."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
from analyze_capture import validate_raw_capture, validate_snapshot


TOKEN_KEYS = ("input_tokens", "cached_input_tokens", "uncached_input_tokens",
              "output_tokens", "reasoning_tokens", "provider_attempts")
COVERAGE_KEYS = ("complete_attempts", "incomplete_attempts", "unknown_attempts", "missing_attempts")
TRANSPORT_KEYS = ("client_requests", "provider_attempt_requests", "provider_responses", "client_responses",
                  "client_control_requests", "provider_control_requests", "provider_control_responses",
                  "client_control_responses")


def published_usage(state=None):
    result = dict.fromkeys(TOKEN_KEYS + COVERAGE_KEYS, 0)
    if state is not None:
        result.update(input_tokens=100, cached_input_tokens=20, uncached_input_tokens=80,
                      output_tokens=10, reasoning_tokens=2, provider_attempts=1)
        result[state + "_attempts"] = 1
    return result


def fixture(states=("complete",), throughput=False, local=False, version=7):
    """Mirror snapshot.go usageOf/addExchange and capturer.go ProviderUsage wire shapes."""
    zero = {"bytes": 0, "tokens": 0}
    exchange = {"sequence": 1, "thread_id": "test-thread", "status": "completed",
                "status_code": 200, "response_complete": True, "duration_ms": 10,
                "client_request": dict(zero), "client_response": dict(zero), "provider_attempts": []}
    front = {"schema_version": 7, "boundary": "codex", "capture_id": "test-capture",
             "request_sequence": 1, "mode": "mekugi", "thread_id": "test-thread",
             "status_code": 200, "response_status": "completed", "response_complete": True,
             "request": dict(zero), "response": dict(zero), "duration_ms": 10}
    records = [front]
    total = published_usage()
    measured = {"output_tokens": 0, "duration_ns": 0, "measured_requests": 0}
    for number, state in enumerate(() if local else states, 1):
        attempt = {"attempt": number, "model": "gpt-6-luna", "status": "completed",
                   "status_code": 200, "response_complete": True, "duration_ms": 10,
                   "request": dict(zero), "projected_request": dict(zero), "response": dict(zero)}
        raw = dict(front, boundary="provider", provider_attempt=number, request_model="gpt-6-luna",
                   projected_request=dict(zero))
        evidence = {"cached_tokens_state": "unavailable", "service_tier": "default"}
        if state == "missing":
            total["missing_attempts"] += 1
        else:
            value = published_usage(state)
            raw_usage = {key: value[key] for key in
                         ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens")}
            if state != "unknown":
                raw_usage["evidence_complete"] = state == "complete"
            if throughput:
                timing = {"output_tokens": 10, "duration_ns": number * 1000000, "measured_requests": 1}
                value["output_throughput"] = dict(timing)
                raw_usage["output_throughput"] = dict(timing)
                for key in measured:
                    measured[key] += timing[key]
            attempt["usage"] = value
            raw["usage"] = raw_usage
            evidence.update(cached_tokens_state="present", cached_tokens=20)
            for key in TOKEN_KEYS + COVERAGE_KEYS:
                total[key] += value[key]
        attempt["provider_response"] = dict(evidence)
        raw["provider_response"] = dict(evidence)
        exchange["provider_attempts"].append(attempt)
        records.append(raw)
    if throughput and measured["measured_requests"]:
        total["output_throughput"] = measured
    if local:
        exchange.update(request_kind="compaction", compaction_answer="router")
        front.update(request_kind="compaction", provider_expected=False, compaction_answer="router")
    if total["provider_attempts"] or local:
        exchange["usage"] = copy.deepcopy(total)
    metrics = {"schema": f"mekugi.capture.metrics.v{version}", "mode": "mekugi",
               "exchanges": [exchange], "usage": total,
               "requests": {"logical": 1, "provider_attempts": len(records)-1, "completed": 1,
                            "failed": 0, "retries": max(0, len(records)-2)},
               "cache": {"provider_cache_rate": 0.2 if total["input_tokens"] else None},
               "transport": {key: dict(zero) for key in TRANSPORT_KEYS},
               "semantic": {"provider_attempt_outputs": dict(zero), "client_outputs": dict(zero)},
               "provider_tools": {}, "delivered_tools": {},
               "capture": dict.fromkeys(("capture_errors", "incomplete_records", "missing_provider_records",
                                         "provider_attempt_gaps", "write_errors", "skipped_requests",
                                         "dropped_exchange_details"), 0)}
    metrics["capture"]["records"] = len(records)
    if version == 6:
        del metrics["requests"]["retries"]
        metrics["cache"].update(cold_or_new_uncached_input_tokens=80, eligible_prefix_tokens=0,
                                eligible_prefix_cached_tokens=0, eligible_prefix_miss_tokens=0,
                                eligible_prefix_cache_rate=None)
        for value in (total, exchange["usage"], exchange["provider_attempts"][0]["usage"]):
            for key in COVERAGE_KEYS:
                del value[key]
        for record, attempt in zip(records[1:], exchange["provider_attempts"]):
            del record["usage"]["evidence_complete"]
            del record["provider_response"]["service_tier"]
            del attempt["provider_response"]["service_tier"]
    return metrics, records


class CaptureV7Tests(unittest.TestCase):
    def validate(self, metrics, records):
        validate_snapshot(metrics, "mekugi", {})
        return self.validate_raw(metrics, records)

    def validate_raw(self, metrics, records):
        with tempfile.TemporaryDirectory(prefix="capture-v7-test-") as directory:
            path = Path(directory) / "capture.jsonl"
            path.write_text("".join(json.dumps(record) + "\n" for record in records))
            return validate_raw_capture(path, metrics)

    def test_valid_v6_is_retained(self):
        self.assertEqual(self.validate(*fixture(version=6)), set())

    def test_v7_retry_coverage_and_additive_throughput(self):
        for timing in (False, True):
            with self.subTest(throughput=timing):
                self.assertEqual(self.validate(*fixture(("complete", "incomplete", "unknown", "missing"),
                                                       throughput=timing)), set())

    def test_v7_missing_usage_is_not_zero_usage(self):
        metrics, records = fixture(("missing",))
        self.assertNotIn("usage", metrics["exchanges"][0])
        self.assertEqual(self.validate(metrics, records), set())
        metrics["usage"]["missing_attempts"] = 0
        with self.assertRaises(ValueError):
            validate_snapshot(metrics, "mekugi", {})

    def test_router_local_compaction_has_explicit_zero_usage(self):
        metrics, records = fixture(local=True)
        self.assertEqual(self.validate(metrics, records), {1})
        del metrics["exchanges"][0]["compaction_answer"]
        with self.assertRaises(ValueError):
            validate_snapshot(metrics, "mekugi", {})

    def test_retry_and_coverage_tampering_is_rejected(self):
        original, _ = fixture(("complete", "incomplete", "unknown", "missing"))
        paths = [("requests", "retries"), ("usage", "complete_attempts"),
                 ("usage", "incomplete_attempts"), ("usage", "unknown_attempts"),
                 ("usage", "missing_attempts")]
        for section, key in paths:
            with self.subTest(section=section, key=key):
                metrics = copy.deepcopy(original)
                metrics[section][key] += 1
                with self.assertRaises(ValueError):
                    validate_snapshot(metrics, "mekugi", {})
        metrics = copy.deepcopy(original)
        metrics["exchanges"][0]["usage"]["missing_attempts"] = 0
        with self.assertRaises(ValueError):
            validate_snapshot(metrics, "mekugi", {})

    def test_raw_evidence_completeness_reconciles_attempt_coverage(self):
        metrics, records = fixture()
        records[1]["usage"]["evidence_complete"] = False
        with self.assertRaises(ValueError):
            self.validate_raw(metrics, records)
        records[1]["usage"]["evidence_complete"] = "true"
        with self.assertRaises(ValueError):
            self.validate_raw(metrics, records)

    def test_throughput_reconciles_at_each_published_level(self):
        original, records = fixture(("complete", "unknown"), throughput=True)
        for level in ("aggregate", "exchange"):
            for key in ("output_tokens", "duration_ns", "measured_requests"):
                with self.subTest(level=level, key=key):
                    metrics = copy.deepcopy(original)
                    value = metrics["usage"] if level == "aggregate" else metrics["exchanges"][0]["usage"]
                    value["output_throughput"][key] += 1
                    with self.assertRaises(ValueError):
                        validate_snapshot(metrics, "mekugi", {})
        for key in ("output_tokens", "duration_ns", "measured_requests"):
            with self.subTest(raw_field=key):
                raw = copy.deepcopy(records)
                raw[1]["usage"]["output_throughput"][key] += 1
                with self.assertRaises(ValueError):
                    self.validate_raw(original, raw)

    def test_safe_service_tier_is_validated_and_reconciled(self):
        original, records = fixture()
        for invalid in ("unsafe\ntext", "x" * 257, 42):
            with self.subTest(service_tier=invalid):
                metrics = copy.deepcopy(original)
                metrics["exchanges"][0]["provider_attempts"][0]["provider_response"]["service_tier"] = invalid
                with self.assertRaises(ValueError):
                    validate_snapshot(metrics, "mekugi", {})
        records[1]["provider_response"]["service_tier"] = "priority"
        with self.assertRaises(ValueError):
            self.validate_raw(original, records)

    def test_raw_status_metadata_reconciles_snapshot(self):
        metrics, original = fixture()
        for boundary in (0, 1):
            for key, value in (("status_code", 201), ("response_status", "incomplete")):
                with self.subTest(boundary=boundary, key=key):
                    records = copy.deepcopy(original)
                    records[boundary][key] = value
                    with self.assertRaises(ValueError):
                        self.validate_raw(metrics, records)

    def test_failed_capture_and_health_are_rejected(self):
        metrics, original = fixture()
        for key, value in (("capture_error", "response_read_failed"), ("response_complete", False)):
            with self.subTest(field=key):
                records = copy.deepcopy(original)
                records[1][key] = value
                with self.assertRaises(ValueError):
                    self.validate_raw(metrics, records)
        metrics["capture"]["write_errors"] = 1
        with self.assertRaises(ValueError):
            self.validate_raw(metrics, original)


if __name__ == "__main__":
    unittest.main()
