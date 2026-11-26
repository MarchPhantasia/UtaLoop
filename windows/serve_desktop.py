"""Run the installed site's local services for the lifetime of its desktop window."""

import base64
import os
import socket
import sys
from functools import partial
from pathlib import Path
from threading import Thread

from unidic_lite import DICDIR

from pipeline.api import Api
from pipeline.serve import BoundedHTTPServer, RangeHandler


class DesktopHTTPServer(BoundedHTTPServer):
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self) -> None:
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def watch_window() -> None:
    sys.stdin.buffer.read(1)
    os._exit(0)


def main() -> None:
    token = os.environ["UTALOOP_DESKTOP_TOKEN"]
    root = Path(__file__).resolve().parent
    # MeCab on Windows opens narrow paths. Keep the bundled dictionary path relative.
    os.chdir(root)
    dictionary = str(Path(DICDIR).relative_to(root))

    class DesktopHandler(RangeHandler):
        api = Api(dictionary)
        music_port = int(os.environ["UTALOOP_DESKTOP_MUSIC_PORT"])
        music_bridge = token

    handler = partial(DesktopHandler, directory=str(root / "web"))
    with DesktopHTTPServer(("127.0.0.1", int(sys.argv[1])), handler) as server:
        Thread(target=watch_window, daemon=True).start()
        # Only the parent receives the listener descriptor, through the child's stdout pipe.
        listener = base64.b64encode(server.socket.share(os.getppid())).decode("ascii")
        print("UTALOOP_SITE_READY " + listener, flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
