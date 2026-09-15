#!/usr/bin/env python3
# Serve a directory with a Content-Security-Policy that allows inline script
# but NOT blob: — the closest local stand-in for SharePoint's framed HTML
# viewer (which Teams uses to open .bento.html attachments). A shell whose
# loader boots the runtime from a blob: URL is refused there; one that injects
# an inline module is not.
#
#   python3 scripts/loader-csp-server.py <dir> [port]
#
# Two ports would be clearer but one is enough: every response carries the
# header, including harness.html, so the sandboxed iframes it hosts inherit
# nothing from it and get the header on their own documents.
import http.server, sys, os

CSP = "script-src 'unsafe-inline' 'self'; default-src 'self' data: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src 'unsafe-inline' 'self'"

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

os.chdir(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 else 5179
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
