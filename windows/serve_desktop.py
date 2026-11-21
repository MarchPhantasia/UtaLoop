"""Run the installed site's local services for the lifetime of its desktop window."""

import os
import sys
from functools import partial
from hmac import compare_digest
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from unidic_lite import DICDIR

from pipeline.api import Api
from pipeline.serve import RangeHandler


def watch_window() -> None:
    sys.stdin.buffer.read(1)
    os._exit(0)


def main() -> None:
    token = os.environ["UTALOOP_DESKTOP_TOKEN"]
    version = os.environ["UTALOOP_DESKTOP_VERSION"]
    root = Path(__file__).resolve().parent
    # MeCab on Windows opens narrow paths. Keep the bundled dictionary path relative.
    os.chdir(root)
    dictionary = str(Path(DICDIR).relative_to(root))

    class DesktopHandler(RangeHandler):
        api = Api(dictionary)
        music_port = int(os.environ["UTALOOP_DESKTOP_MUSIC_PORT"])
        music_bridge = token

        def do_GET(self) -> None:
            if self.path != "/desktop/ready":
                return super().do_GET()
            if not compare_digest(self.headers.get("X-UtaLoop-Ready", "").encode(), token.encode()):
                self.send_error(404)
                return
            self.send_response(204)
            self.send_header("X-UtaLoop-Desktop-Version", version)
            self.end_headers()

    handler = partial(DesktopHandler, directory=str(root / "web"))
    with ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), handler) as server:
        Thread(target=watch_window, daemon=True).start()
        server.serve_forever()


if __name__ == "__main__":
    main()
