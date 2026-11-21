"""Forward the local UtaLoop page's OpenAI-compatible model requests."""

from __future__ import annotations

import json
from http.client import HTTPException
from ipaddress import ip_address
from ssl import SSLError
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MODEL_ROUTES = {"/llm/models": "models", "/llm/chat": "chat/completions"}
_HEADER = "X-UtaLoop-LLM"
_MAX_INPUT = 2 * 1024 * 1024
_MAX_OUTPUT = 8 * 1024 * 1024
_STREAM_ERROR = b'\n\ndata: {"error":{"code":"relay_interrupted"}}\n\n'


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an authorization header to a different endpoint.
        return None


def _allowed(handler) -> bool:
    port = handler.server.server_address[1]
    hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
    if port == 80:
        hosts.update(("localhost", "127.0.0.1"))
    host = handler.headers.get("Host")
    return (ip_address(handler.client_address[0]).is_loopback and host in hosts
            and handler.headers.get("Origin") == f"http://{host}"
            and handler.headers.get("Sec-Fetch-Site", "same-origin") == "same-origin"
            and handler.headers.get(_HEADER) == "1"
            and handler.headers.get_content_type() == "application/json")


def _headers(handler, status, content_type, *, length=None, error=None):
    handler.send_response(status)
    handler.send_header(_HEADER, "1")
    handler.send_header("Content-Type", content_type)
    handler.send_header("X-Content-Type-Options", "nosniff")
    if length is not None:
        handler.send_header("Content-Length", str(length))
    if error:
        handler.send_header(_HEADER + "-Error", error)
    handler.end_headers()


def _json(handler, status, data=b"{}", *, error=None):
    _headers(handler, status, "application/json; charset=utf-8", length=len(data), error=error)
    handler.wfile.write(data)


def _model_request(handler, resource):
    length = int(handler.headers.get("Content-Length", "0"))
    if not 0 < length <= _MAX_INPUT:
        raise ValueError("request size")
    envelope = json.loads(handler.rfile.read(length))
    if not isinstance(envelope, dict):
        raise ValueError("request body")
    endpoint = envelope.get("endpoint")
    if (not isinstance(endpoint, str) or len(endpoint) > 8192 or "\\" in endpoint
            or not all(32 < ord(ch) < 127 for ch in endpoint)):
        raise ValueError("endpoint")
    url = urlsplit(endpoint)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username is not None
            or url.password is not None or url.fragment or url.port == 0
            or not url.path.endswith("/" + resource)):
        raise ValueError("endpoint")
    key = handler.headers.get("Authorization", "")
    if key and (not key.startswith("Bearer ") or len(key) > 8192 or not key[7:]
                or not all(32 <= ord(ch) < 127 for ch in key)):
        raise ValueError("authorization")
    headers = {"Accept": "application/json, text/event-stream", "Accept-Encoding": "identity"}
    if key:
        headers["Authorization"] = key
    if resource == "models":
        return Request(endpoint, headers=headers, method="GET")
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("completion body")
    headers["Content-Type"] = "application/json"
    return Request(endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   headers=headers, method="POST")


def _stream(handler, upstream):
    _headers(handler, upstream.status, "text/event-stream; charset=utf-8")
    total = 0
    while True:
        try:
            chunk = upstream.read1(16384)
        except (OSError, HTTPException):
            handler.wfile.write(_STREAM_ERROR)
            return
        if not chunk:
            return
        total += len(chunk)
        if total > _MAX_OUTPUT:
            handler.wfile.write(_STREAM_ERROR)
            return
        handler.wfile.write(chunk)
        handler.wfile.flush()


def _connection_error(handler, error):
    cause = error.reason if isinstance(error, URLError) else error
    if isinstance(cause, TimeoutError):
        _json(handler, 504, error="timeout")
    else:
        _json(handler, 502, error="tls" if isinstance(cause, SSLError) else "unreachable")


def forward_model_request(handler, resource):
    try:
        _forward(handler, resource)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        # The browser cancelled while the provider was responding.
        pass


def _forward(handler, resource):
    if not _allowed(handler):
        _json(handler, 403, error="origin")
        return
    try:
        request = _model_request(handler, resource)
    except (ValueError, RecursionError):
        _json(handler, 400, error="request")
        return
    try:
        upstream = build_opener(_NoRedirect()).open(request, timeout=15 if resource == "models" else 120)
    except HTTPError as error:
        status = error.code
        error.close()
        if 300 <= status < 400:
            _json(handler, 502, error="redirect")
        else:
            # Neither provider error bodies nor cookies belong in the page origin.
            _json(handler, status)
        return
    except (OSError, HTTPException, ValueError) as error:
        _connection_error(handler, error)
        return
    with upstream:
        content_type = upstream.headers.get_content_type()
        if content_type == "text/event-stream":
            _stream(handler, upstream)
            return
        if content_type == "text/html":
            _json(handler, 502, error="format")
            return
        try:
            data = upstream.read(_MAX_OUTPUT + 1)
        except (OSError, HTTPException) as error:
            _connection_error(handler, error)
            return
        if len(data) > _MAX_OUTPUT:
            _json(handler, 502, error="size")
            return
        _json(handler, upstream.status, data)
