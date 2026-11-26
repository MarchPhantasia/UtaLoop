"""本地服务 —— 分析 API (+ 可选的静态站点).

站点本身是零构建的静态文件, 总得有人端出去, 所以默认同一个进程既挂 ``/api/*``
也当静态服务器; 只要 ``--no-static`` 就退化成纯 API, 可以单独部署在别的机器上
(前端在「设置 → 分析后端」里填地址即可)。

比 ``python -m http.server`` 多做三件事:

* **支持 Range 请求** —— 静态放出去的音频才能拖进度条 (浏览器导入的音频走 blob URL,
  本来就支持 seek, 用不到这条);
* **开发期禁用缓存** —— 改了 CSS/JS 刷新就生效;
* **挂上 /api/** —— 见 :mod:`pipeline.api`。
"""

from __future__ import annotations

import io
import json
import mimetypes
import os
import re
from functools import partial
from http import HTTPStatus
from http.client import HTTPConnection, HTTPException
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from pathlib import Path
from threading import BoundedSemaphore
from time import monotonic
from urllib.parse import urlsplit

from .api import Api
from .frontend_cache import MANIFEST_NAME, frontend_manifest
from .llm_relay import MODEL_ROUTES, forward_model_request

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
_MUSIC_MEDIA_RE = re.compile(r"/music/media/[a-f0-9]{36}")
_MUSIC_CACHE_ACTIONS = {"cache-info", "cache-limit", "cache-clear"}

for _ext, _mime in {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".webmanifest": "application/manifest+json",
}.items():
    mimetypes.add_type(_mime, _ext)


class BoundedHTTPServer(ThreadingHTTPServer):
    max_connections = 32

    def __init__(self, server_address, handler):
        self._connections = BoundedSemaphore(self.max_connections)
        super().__init__(server_address, handler)

    def process_request(self, request, client_address):
        if not self._connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connections.release()


class _RequestReader(io.RawIOBase):
    def __init__(self, connection, timeout):
        self.connection = connection
        self.timeout = timeout
        self.deadline = 0.0

    def readable(self):
        return True

    def readinto(self, buffer):
        remaining = self.deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("HTTP request read deadline exceeded")
        self.connection.settimeout(min(self.timeout, remaining))
        try:
            return self.connection.recv_into(buffer)
        finally:
            self.connection.settimeout(self.timeout)


class RangeHandler(SimpleHTTPRequestHandler):
    api: Api | None = None          # serve() 会派生一个带 api 的子类
    static: bool = True
    music_port: int = 3012
    music_bridge: str = "1"
    timeout = 15.0
    header_timeout = 10.0
    body_timeout = 120.0

    def setup(self) -> None:
        super().setup()
        self.rfile.close()
        self._request_reader = _RequestReader(self.connection, self.timeout)
        self.rfile = io.BufferedReader(self._request_reader)

    def handle_one_request(self) -> None:
        # The deadline applies across reads, even if the peer keeps sending data.
        self._request_reader.deadline = monotonic() + self.header_timeout
        super().handle_one_request()

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        self._request_reader.deadline = monotonic() + self.body_timeout
        return True

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # 静音常规访问日志
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)

    # ------------------------------------------------------------ 方法分派

    def do_GET(self) -> None:
        if self.static and _MUSIC_MEDIA_RE.fullmatch(self.path):
            self._music_media()
            return
        if self.api and self.api.handle(self, "GET"):
            return
        if not self.static:
            self.send_error(HTTPStatus.NOT_FOUND, "静态服务已关闭 (--no-static)")
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if self.static and _MUSIC_MEDIA_RE.fullmatch(self.path):
            self._music_media()
            return
        if self.api and self.api.handle(self, "HEAD"):
            return
        if not self.static:
            self.send_error(HTTPStatus.NOT_FOUND, "静态服务已关闭 (--no-static)")
            return
        super().do_HEAD()

    def do_OPTIONS(self) -> None:
        self._api_only("OPTIONS")

    def do_POST(self) -> None:
        resource = MODEL_ROUTES.get(self.path)
        if self.static and resource and _is_loopback(self.server.server_address[0]):
            forward_model_request(self, resource)
            return
        if self.static and self.path.startswith("/music/"):
            self._music()
            return
        self._api_only("POST")

    def _music_host(self) -> str:
        listen_host, listen_port = self.server.server_address
        if not (_is_loopback(listen_host) and _is_loopback(self.client_address[0])):
            return ""
        host = self.headers.get("Host", "")
        name, separator, port = host.partition(":")
        if name in ("localhost", "127.0.0.1") and (port if separator else "80") == str(listen_port):
            return host
        return ""

    def _music(self) -> None:
        host = self._music_host()
        origin = self.headers.get("Origin", "")
        if (not host or origin != "http://" + host
                or self.headers.get_content_type() != "application/json"):
            self.send_error(403)
            return
        actions = {"account", "qr", "poll", "logout", "retention", "search", "likes", "folders",
                   "playlist", "lyrics", "source", "artwork"} | _MUSIC_CACHE_ACTIONS
        action = self.path.removeprefix("/music/")
        length = self.headers.get("Content-Length", "")
        if action not in actions or not length.isdigit() or not 0 < int(length) <= 4096:
            self.send_error(400)
            return
        body = self.rfile.read(int(length))
        if len(body) != int(length):
            self.send_error(400)
            return
        service = HTTPConnection("127.0.0.1", self.music_port, timeout=20)
        try:
            service.request("POST", "/" + action, body,
                            {"Content-Type": "application/json", "X-UtaLoop": self.music_bridge,
                             "Cookie": self.headers.get("Cookie", "")})
            upstream = service.getresponse()
            data = upstream.read()
            self.send_response(upstream.status)
            cookie = upstream.getheader("Set-Cookie")
            if cookie:
                self.send_header("Set-Cookie", cookie)
        except (OSError, HTTPException):
            self.send_response(503)
            data = json.dumps({"error": "请启动 UtaLoop 音乐服务后重试"}).encode()
        finally:
            service.close()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _music_media(self) -> None:
        host = self._music_host()
        if (not host
                or self.headers.get("Origin") not in (None, "http://" + host)
                or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")):
            self.send_error(403)
            return
        headers = {"X-UtaLoop": self.music_bridge, "Cookie": self.headers.get("Cookie", "")}
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        service = HTTPConnection("127.0.0.1", self.music_port, timeout=20)
        started = False
        try:
            service.request(self.command, self.path.removeprefix("/music"), headers=headers)
            upstream = service.getresponse()
            self.send_response(upstream.status)
            for name in ("Content-Type", "Content-Length", "Content-Range", "Location"):
                value = upstream.getheader(name)
                if value is not None:
                    self.send_header(name, value)
            self.send_header("X-Content-Type-Options", "nosniff")
            started = True
            self.end_headers()
            if self.command == "GET":
                while chunk := upstream.read1(64 * 1024):
                    self.wfile.write(chunk)
        except (OSError, HTTPException):
            if not started:
                self.send_error(503, "Music service unavailable")
        finally:
            service.close()

    def do_PUT(self) -> None:
        self._api_only("PUT")

    def do_PATCH(self) -> None:
        self._api_only("PATCH")

    def do_DELETE(self) -> None:
        self._api_only("DELETE")

    def _api_only(self, method: str) -> None:
        if self.api and self.api.handle(self, method):
            return
        self.send_error(HTTPStatus.NOT_FOUND, f"No handler for {method} {self.path}")

    def send_head(self):
        # Compute against the actual served source, including newly added lazy modules.
        # This is a static-source inventory: no API credentials or user data are included.
        if self.static and urlsplit(self.path).path.endswith('/' + MANIFEST_NAME):
            root = Path(self.translate_path(self.path)).parent
            if not (root / 'index.html').is_file():
                self.send_error(HTTPStatus.NOT_FOUND, "Frontend not found")
                return None
            body = json.dumps(frontend_manifest(root), ensure_ascii=False).encode('utf-8')
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            fp = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        size = os.fstat(fp.fileno()).st_size
        match = _RANGE_RE.fullmatch(range_header.strip())
        if not match:
            fp.close()
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Range")
            return None

        raw_start, raw_end = match.groups()
        if raw_start:
            start = int(raw_start)
            end = int(raw_end) if raw_end else size - 1
        else:  # bytes=-N -> 末尾 N 字节
            start = max(0, size - int(raw_end or 0))
            end = size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            fp.close()
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        fp.seek(start)
        return _Slice(fp, end - start + 1)


class _Slice:
    """只暴露 ``read``/``close`` 的文件片段, 交给 copyfile 消费."""

    def __init__(self, fp, remaining: int) -> None:
        self._fp = fp
        self._remaining = remaining

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        want = self._remaining if size is None or size < 0 else min(size, self._remaining)
        data = self._fp.read(want)
        self._remaining -= len(data)
        return data

    def close(self) -> None:
        self._fp.close()


def _is_loopback(host: str) -> bool:
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def serve(root: Path, host: str = "127.0.0.1", port: int = 5173,
          open_browser: bool = False, api: bool = True, static: bool = True,
          dicdir: str | None = None, api_token: str | None = None) -> None:
    root = Path(root).resolve()
    if static and not root.is_dir():
        raise FileNotFoundError(f"站点根目录不存在: {root}")
    if not api and not static:
        raise ValueError("--no-api 和 --no-static 不能同时用, 那就什么都不剩了")
    if api and not _is_loopback(host) and not (api_token or "").strip():
        raise ValueError("监听非回环地址前, 请先在 .env 中设置 LINGUA_API_TOKEN")
    cls = type("_Handler", (RangeHandler,),
               {"api": Api(dicdir, api_token=api_token) if api else None, "static": static})
    handler = partial(cls, directory=str(root))
    with BoundedHTTPServer((host, port), handler) as httpd:
        url = f"http://{host}:{port}/"
        bits = []
        if api:
            bits.append("分析 API /api")
        if static:
            bits.append(f"静态站点 {root}")
        print(f"Lingua: {url}  ({' + '.join(bits)})")
        if api:
            print("API 鉴权: " + ("Bearer Token" if (api_token or "").strip()
                                  else "未启用 (仅监听回环地址)"))
        print("Ctrl+C 停止")
        if open_browser and static:
            import webbrowser

            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")
