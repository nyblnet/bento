# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# The rig's ATTACKER PAGE, served locally over HTTPS on its own loopback port
# (the pinned CSP and the host's navigation policy admit only https frames, so
# plain http cannot reach a genuine document). usage: embedsrv.py DIR CERT KEY PORT
# CERT "-" serves plain http: the d4 row's frame, which must be stopped.
import http.server, ssl, sys
d, cert, key, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
H = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=d, **k)
s = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
if cert != "-":
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(cert, key)
    s.socket = c.wrap_socket(s.socket, server_side=True)
s.serve_forever()
