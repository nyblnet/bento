#!/usr/bin/env python3
# Serve a directory with a Content-Security-Policy that allows inline script
# but NOT blob: — the closest local stand-in for SharePoint's framed HTML
# viewer (which Teams uses to open .bento.html attachments). A shell whose
# loader boots the runtime from a blob: URL is refused there; one that injects
# an inline module is not.
#
#   python3 scripts/loader-csp-server.py <dir> [port] [--tt bento|other] [--hash]
#
# --hash serves each HTML file under the Teams/SharePoint-shaped policy:
# script-src = the sha256 of every inline <script> in that file + 'unsafe-eval'
# (so 'unsafe-inline' is ignored), default-src 'none', connect-src 'none',
# sandbox allow-scripts.
#
# --tt adds `require-trusted-types-for 'script'` (a string assigned to a
# script sink throws; parser-inserted scripts are exempt) and allowlists ONE
# policy name — `bento` is what the inline-tt loader creates, `other` is the
# wrong-allowlist case that must make the loader print a policy refusal.
#
# Two ports would be clearer but one is enough: every response carries the
# header, including harness.html, so the sandboxed iframes it hosts inherit
# nothing from it and get the header on their own documents.
import http.server, sys, os, re, hashlib, base64

CSP = "script-src 'unsafe-inline' 'self'; default-src 'self' data: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src 'unsafe-inline' 'self'"
if '--no-eval-inline' in sys.argv:
    # inline allowed, eval refused: the eval probe must throw synchronously
    # and the cascade must take the inline path with no wait
    CSP = "script-src 'unsafe-inline' 'self'; default-src 'self' data: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src 'unsafe-inline' 'self'"
if '--preview' in sys.argv:
    # A preview-like pane: inline script allowed, no eval, no blob, a
    # names-only trusted-types allowlist, sandboxed. The local assertion is
    # "zero violation events" — a loader that raises none has nothing for
    # any host to object to.
    CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
           "font-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src 'none'; sandbox allow-scripts; trusted-types somename")
TT_NAMES_ONLY = None
if '--tt-names' in sys.argv:
    # an allowlist WITHOUT require-trusted-types-for: sinks take strings, but
    # createPolicy('x') for a name outside the list throws "Policy disallowed"
    TT_NAMES_ONLY = sys.argv[sys.argv.index('--tt-names') + 1]
    CSP += f"; trusted-types {TT_NAMES_ONLY}"
if '--tt' in sys.argv:
    name = sys.argv[sys.argv.index('--tt') + 1]
    # `any` = require Trusted Types but allowlist no names (every policy
    # name allowed); a name = allowlist exactly that name (space-separated
    # names allowed, e.g. "bento default")
    CSP += "; require-trusted-types-for 'script'" + ('' if name == 'any' else f"; trusted-types {name}")

HASH_MODE = '--hash' in sys.argv

def hashed_policy(path):
    # SharePoint's viewer, as observed from Teams: every inline <script> in the
    # file is allowed by its sha256, nothing else; 'unsafe-inline' is ignored
    # once hashes are present (per spec); eval is allowed; the frame is
    # sandboxed without allow-same-origin; connect-src is none.
    html = open(path, encoding='utf-8').read()
    hashes = []
    for m in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script>', html):
        h = base64.b64encode(hashlib.sha256(m.group(1).encode('utf-8')).digest()).decode()
        hashes.append(f"'sha256-{h}'")
    return ("default-src 'none'; script-src " + ' '.join(hashes) + " 'unsafe-inline' 'unsafe-eval'; "
            "style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; "
            "connect-src 'none'; worker-src 'none'; sandbox allow-scripts"
            + (f"; trusted-types {TT_NAMES_ONLY}" if TT_NAMES_ONLY else ''))

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        csp = CSP
        if HASH_MODE:
            local = self.translate_path(self.path.split('?')[0])
            if os.path.isfile(local) and local.endswith('.html'):
                csp = hashed_policy(local)
        self.send_header('Content-Security-Policy', csp)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass

os.chdir(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else 5179
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
