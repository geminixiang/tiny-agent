import json
import unittest

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from tiny_agent.telemetry import NoTelemetry, OpenTelemetryMonitor, create_telemetry


class TelemetryTest(unittest.TestCase):
    def monitor(self):
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        return exporter, provider, OpenTelemetryMonitor(provider.get_tracer("test"), provider.shutdown)

    def test_projects_phoenix_friendly_span_tree_without_private_content(self):
        exporter, provider, monitor = self.monitor()
        session_id, operation_id = "session-1", "operation-1"
        monitor.emit({"type": "startup.started", "timestamp": "2026-01-01T00:00:00.000Z", "model": "test-model", "runtime": "python", "plugins": ["read"], "mcp": ["fixture"]})
        monitor.emit({"type": "mcp.started", "timestamp": "2026-01-01T00:00:00.010Z", "server": "fixture"})
        monitor.emit({"type": "mcp.completed", "timestamp": "2026-01-01T00:00:00.020Z", "server": "fixture", "outcome": "succeeded", "protocolVersion": "2026-07-28", "toolCount": 1})
        monitor.emit({"type": "startup.completed", "timestamp": "2026-01-01T00:00:00.030Z", "outcome": "succeeded"})
        monitor.emit({"type": "operation.started", "timestamp": "2026-01-01T00:00:00.040Z", "sessionId": session_id, "operationId": operation_id, "operationKind": "run", "recovery": False})
        monitor.emit({"type": "model.started", "timestamp": "2026-01-01T00:00:00.050Z", "sessionId": session_id, "operationId": operation_id, "operationKind": "run", "stepId": "step-1", "attemptId": "attempt-1", "attempt": 1, "recovery": False})
        monitor.emit({"type": "model.completed", "timestamp": "2026-01-01T00:00:00.100Z", "sessionId": session_id, "operationId": operation_id, "operationKind": "run", "stepId": "step-1", "attemptId": "attempt-1", "recovery": False, "outcome": "succeeded", "usage": {"input": 7, "output": 2, "cacheRead": 3, "cacheWrite": 1}})
        monitor.emit({"type": "tool.started", "timestamp": "2026-01-01T00:00:00.110Z", "sessionId": session_id, "operationId": operation_id, "stepId": "step-1", "attemptId": "tool-attempt-1", "parentAttemptId": "attempt-1", "toolStartedId": "tool-started-1", "toolCallId": "call-1", "tool": "read", "recovery": False, "args": {"path": "/secret"}})
        monitor.emit({"type": "tool.completed", "timestamp": "2026-01-01T00:00:00.130Z", "sessionId": session_id, "operationId": operation_id, "stepId": "step-1", "attemptId": "tool-attempt-1", "parentAttemptId": "attempt-1", "toolStartedId": "tool-started-1", "toolCallId": "call-1", "tool": "read", "recovery": False, "outcome": "succeeded", "result": "secret contents"})
        monitor.emit({"type": "operation.completed", "timestamp": "2026-01-01T00:00:00.150Z", "sessionId": session_id, "operationId": operation_id, "operationKind": "run", "recovery": False, "outcome": "succeeded", "completion": "normal", "answer": "private answer", "errorMessage": "private error"})
        provider.force_flush()

        spans = exporter.get_finished_spans()
        operation = next(span for span in spans if span.name == "tiny.agent.operation")
        model = next(span for span in spans if span.name == "tiny.model.request")
        tool = next(span for span in spans if span.name == "tiny.tool.execute")
        startup = next(span for span in spans if span.name == "tiny.startup")
        mcp = next(span for span in spans if span.name == "tiny.mcp.connect")
        self.assertEqual(operation.attributes["openinference.span.kind"], "AGENT")
        self.assertEqual(operation.attributes["session.id"], session_id)
        self.assertEqual(model.attributes["openinference.span.kind"], "LLM")
        self.assertEqual(model.attributes["gen_ai.request.model"], "test-model")
        self.assertEqual(model.attributes["gen_ai.usage.input_tokens"], 11)
        self.assertEqual(model.attributes["llm.token_count.total"], 13)
        self.assertEqual(tool.attributes["openinference.span.kind"], "TOOL")
        self.assertEqual(tool.attributes["tool.name"], "read")
        self.assertEqual(model.parent.span_id, operation.context.span_id)
        self.assertEqual(tool.parent.span_id, operation.context.span_id)
        self.assertEqual(mcp.parent.span_id, startup.context.span_id)
        encoded = json.dumps([dict(span.attributes) for span in spans])
        self.assertNotIn("/secret", encoded)
        self.assertNotIn("secret contents", encoded)
        self.assertNotIn("private answer", encoded)
        self.assertNotIn("private error", encoded)
        monitor.close()

    def test_stays_disabled_without_trusted_endpoint(self):
        self.assertIsInstance(create_telemetry({}), NoTelemetry)
        self.assertIsInstance(create_telemetry({"OTEL_SDK_DISABLED": "true", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}), NoTelemetry)


if __name__ == "__main__":
    unittest.main()
