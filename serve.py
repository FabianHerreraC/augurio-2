import functools
from http.server import HTTPServer, SimpleHTTPRequestHandler

DIRECTORY = "/Users/fabianherrera/Desktop/FabDev/Augurio 2.0"


class SinCacheHandler(SimpleHTTPRequestHandler):
    """Evita que el navegador se quede con CSS/JS viejos durante el desarrollo."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


Handler = functools.partial(SinCacheHandler, directory=DIRECTORY)
HTTPServer(("127.0.0.1", 4173), Handler).serve_forever()
