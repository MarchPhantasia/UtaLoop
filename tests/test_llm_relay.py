"""Loopback-only integration tests for the local model relay."""

import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pipeline.serve import RangeHandler


class ModelRelayTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.next_chunk = threading.Event()
        self.provider = self.start_server(self.provider_handler())
        self.relay = self.start_server(RangeHandler)
        self.origin = f"http://127.0.0.1:{self.relay.server_port}"
        self.endpoint = f"http://127.0.0.1:{self.provider.server_port}"

    def start_server(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .03}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def provider_handler(self):
        requests, next_chunk = self.requests, self.next_chunk

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requests.append((self.command, self.path, self.headers, None))
                if self.path == "/redirect/models":
                    self.send_response(307)
                    self.send_header("Location", "/should-not-send-key/models")
                    self.end_headers()
                    return
                if self.path == "/denied/models":
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b"private upstream error details")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", "upstream=private")
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"practice-model"}]}')

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.command, self.path, self.headers, body))
                self.send_response(200)
                if body.get("stream"):
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
                    self.wfile.flush()
                    if next_chunk.wait(3):
                        self.wfile.write(b"data: [DONE]\n\n")
                else:
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"choices":[{"message":{"content":"OK"}}]}')

        return Provider

    def request(self, path, endpoint, payload=None, **overrides):
        connection = HTTPConnection("127.0.0.1", self.relay.server_port, timeout=5)
        self.addCleanup(connection.close)
        headers = {"Origin": self.origin, "X-UtaLoop-LLM": "1", "Content-Type": "application/json",
                   "Authorization": "Bearer sample-key", "Cookie": "music=local", **overrides}
        connection.request("POST", path, json.dumps({"endpoint": endpoint, "payload": payload}), headers)
        return connection.getresponse()

    def test_catalog_and_chat_forward_only_the_model_request(self):
        response = self.request("/llm/models", self.endpoint + "/vendor/v1/models?team=practice")
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read()), {"data": [{"id": "practice-model"}]})
        self.assertEqual(response.getheader("X-UtaLoop-LLM"), "1")
        self.assertIsNone(response.getheader("Set-Cookie"))
        method, path, headers, _ = self.requests[0]
        self.assertEqual((method, path), ("GET", "/vendor/v1/models?team=practice"))
        self.assertEqual(headers["Authorization"], "Bearer sample-key")
        self.assertIsNone(headers["Cookie"])
        self.assertIsNone(headers["Origin"])
        payload = {"model": "practice-model", "messages": [{"role": "user", "content": "日语歌词"}]}
        response = self.request("/llm/chat", self.endpoint + "/v1/chat/completions", payload)
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read())["choices"][0]["message"]["content"], "OK")
        self.assertEqual(self.requests[-1][3], payload)

    def test_stream_reaches_browser_before_upstream_finishes(self):
        response = self.request("/llm/chat", self.endpoint + "/v1/chat/completions", {"stream": True})
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        self.assertIn(b'"first"', response.readline())
        self.next_chunk.set()
        self.assertIn(b"[DONE]", response.read())

    def test_origin_protocol_and_operation_are_checked_before_network_access(self):
        for endpoint, headers, status in [
            (self.endpoint + "/v1/models", {"Origin": "https://other.example"}, 403),
            (self.endpoint + "/v1/models", {"Host": "other.example", "Origin": "http://other.example"}, 403),
            (self.endpoint + "/v1/models", {"X-UtaLoop-LLM": ""}, 403),
            ("file:///tmp/models", {}, 400),
            (self.endpoint + "/health", {}, 400),
        ]:
            with self.subTest(endpoint=endpoint, headers=headers):
                response = self.request("/llm/models", endpoint, **headers)
                self.assertEqual(response.status, status)
        self.assertEqual(self.requests, [])

    def test_redirect_and_upstream_error_do_not_leak_provider_data(self):
        response = self.request("/llm/models", self.endpoint + "/redirect/models")
        self.assertEqual(response.status, 502)
        self.assertEqual(response.getheader("X-UtaLoop-LLM-Error"), "redirect")
        self.assertEqual([request[1] for request in self.requests], ["/redirect/models"])
        response = self.request("/llm/models", self.endpoint + "/denied/models")
        self.assertEqual(response.status, 401)
        self.assertEqual(response.read(), b"{}")
