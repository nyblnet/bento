#!/usr/bin/env python3
# Serve a directory with a Content-Security-Policy that allows inline script
# but NOT blob: — the closest local stand-in for SharePoint's framed HTML
# viewer (which Teams uses to open .bento.html attachments). A shell whose
# loader boots the runtime from a blob: URL is refused there; one that injects
# an inline module is not.
#
#   python3 scripts/loader-csp-server.py <dir> [port] [--tt bento|other]
#
# --tt adds `require-trusted-types-for 'script'` (a string assigned to a
# script sink throws; parser-inserted scripts are exempt) and allowlists ONE
# policy name — `bento` is what the inline-tt loader creates, `other` is the
# wrong-allowlist case that must make the loader print a policy refusal.
#
# Two ports would be clearer but one is enough: every response carries the
# header, including harness.html, so the sandboxed iframes it hosts inherit
# nothing from it and get the header on their own documents.
import http.server, sys, os

CSP = "script-src 'unsafe-inline' 'self'; default-src 'self' data: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src 'unsafe-inline' 'self'"
if '--tt' in sys.argv:
    name = sys.argv[sys.argv.index('--tt') + 1]
    # `any` = require Trusted Types but allowlist no names (every policy
    # name allowed); a name = allowlist exactly that name (space-separated
    # names allowed, e.g. "bento default")
    CSP += "; require-trusted-types-for 'script'" + ('' if name == 'any' else f"; trusted-types {name}")

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

os.chdir(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else 5179
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
