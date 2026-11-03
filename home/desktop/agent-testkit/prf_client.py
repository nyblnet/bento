# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# TEST-ONLY. The INDEPENDENT WebAuthn client for the PRF interop rig:
# Yubico's python-fido2 (BSD-2, pinned with a hash) applies the WebAuthn PRF ->
# CTAP hmac-secret transform itself, the way a browser does. It sets a PIN on
# the virtual key, creates a discoverable credential for rp bento.page with PRF
# enabled, evaluates PRF on the agent's fixed input, and writes the result for
# the Rust side to compare byte for byte.
import json, os, sys
from fido2.hid import CtapHidDevice
from fido2.client import Fido2Client, UserInteraction
from fido2.ctap2 import Ctap2
from fido2.ctap2.pin import ClientPin
from fido2.utils import websafe_decode

PIN = "4711-rig"
PRF_INPUT = b"bento/id/prf/v1"
out_path = sys.argv[1]

dev = next(CtapHidDevice.list_devices(), None)
if dev is None:
    sys.exit("no FIDO device")
ctap = Ctap2(dev)
if not ctap.info.options.get("clientPin"):
    ClientPin(ctap).set_pin(PIN)

class UI(UserInteraction):
    def request_pin(self, permissions, rp_id):
        return PIN
    def request_uv(self, permissions, rp_id):
        return True

client = Fido2Client(dev, "https://bento.page", user_interaction=UI())
client.make_credential({
    "rp": {"id": "bento.page", "name": "bento"},
    "user": {"id": b"rig-user", "name": "rig@example.com", "displayName": "Rig"},
    "challenge": os.urandom(32),
    "pubKeyCredParams": [{"type": "public-key", "alg": -7}],
    "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
    "extensions": {"prf": {}},
})

def prf(first):
    sel = client.get_assertion({
        "rpId": "bento.page",
        "challenge": os.urandom(32),
        "userVerification": "required",
        "extensions": {"prf": {"eval": {"first": first}}},
    })
    r = sel.get_response(0)
    res = r.extension_results
    first = res["prf"]["results"]["first"]
    # python-fido2 1.2 returns the PRF result base64url-encoded (JSON form)
    raw = websafe_decode(first) if isinstance(first, str) else bytes(first)
    assert len(raw) == 32, len(raw)
    return raw.hex()

json.dump({
    "device": dev.descriptor.path,
    "pin": PIN,
    "prfInput": PRF_INPUT.decode(),
    "prf": prf(PRF_INPUT),
}, open(out_path, "w"))
print("python-fido2 PRF:", json.load(open(out_path))["prf"])
