# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
#
# RIG ONLY: a stand-in for logind on a private "system" bus (rig/fakebus.sh), with
# the shape of the real one measured against systemd: signals come from the
# session's REAL path, session/auto is only an alias for reads. The rig drives it
# through com.bento.Rig.Do, from the probe in the page under test.
import os, signal, sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

LOGIND = "org.freedesktop.login1"
ROOT = "/org/freedesktop/login1"
REAL = ROOT + "/session/_31"
AUTO = ROOT + "/session/auto"
MGR = LOGIND + ".Manager"
SES = LOGIND + ".Session"

XML = f"""<node>
<interface name="{MGR}">
  <method name="GetSession"><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
  <signal name="PrepareForSleep"><arg type="b"/></signal>
  <signal name="SessionRemoved"><arg type="s"/><arg type="o"/></signal>
</interface>
<interface name="{SES}">
  <property name="Id" type="s" access="read"/>
  <property name="LockedHint" type="b" access="read"/>
  <signal name="Lock"/>
  <signal name="Unlock"/>
</interface>
<interface name="com.bento.Rig">
  <method name="Do"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
</interface>
</node>"""

info = Gio.DBusNodeInfo.new_for_xml(XML)
iface = {i.name: i for i in info.interfaces}
state = {"hint": "--locked" in sys.argv, "gone": False}
addr = os.environ["DBUS_SYSTEM_BUS_ADDRESS"]
conn = Gio.DBusConnection.new_for_address_sync(addr, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
conn.set_exit_on_close(False)


def bus(method, *args):
    sig = "(" + "su"[: len(args)] + ")"
    return conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method, GLib.Variant(sig, args), None, Gio.DBusCallFlags.NONE, 3000, None)


def emit(path, iface_name, name, sig=None, *args):
    conn.emit_signal(None, path, iface_name, name, GLib.Variant(sig, args) if sig else None)
    conn.flush_sync(None)


def changed(changed_props, invalidated):
    emit(REAL, "org.freedesktop.DBus.Properties", "PropertiesChanged", "(sa{sv}as)", SES, changed_props, invalidated)


def act(a):
    if a == "lock": emit(REAL, SES, "Lock")
    elif a == "unlock": emit(REAL, SES, "Unlock")
    elif a == "sleep": emit(ROOT, MGR, "PrepareForSleep", "(b)", True)
    elif a == "wake": emit(ROOT, MGR, "PrepareForSleep", "(b)", False)
    elif a == "hint-on":
        state["hint"] = True
        changed({"LockedHint": GLib.Variant("b", True)}, [])
    elif a == "hint-off":
        state["hint"] = False
        changed({"LockedHint": GLib.Variant("b", False)}, [])
    elif a == "hint-on-invalidated":
        state["hint"] = True
        changed({}, ["LockedHint"])
    elif a == "hint-lie":  # says unlocked in the signal; logind's own answer stays locked
        changed({"LockedHint": GLib.Variant("b", False)}, [])
    elif a == "session-gone":
        state["gone"] = True
        emit(ROOT, MGR, "SessionRemoved", "(so)", "1", REAL)
    elif a == "session-back": state["gone"] = False
    elif a == "name-drop": bus("ReleaseName", LOGIND)
    elif a == "name-back": bus("RequestName", LOGIND, 4)
    elif a == "bus-down": os.kill(int(os.environ["FAKE_BUS_PID"]), signal.SIGKILL)  # a TERM lets it say goodbye: logind's NameOwnerChanged would close the gate instead
    else: return "unknown"
    return "done"


def method(_c, _s, _p, _i, name, params, inv):
    if name == "GetSession":
        if state["gone"]: inv.return_dbus_error(LOGIND + ".NoSuchSession", "gone")
        else: inv.return_value(GLib.Variant("(o)", (REAL,)))
    elif name == "Do":
        action = params.unpack()[0]
        # reply first: bus-down takes the reply's path away
        inv.return_value(GLib.Variant("(s)", ("done",)))
        conn.flush_sync(None)
        GLib.idle_add(lambda: act(action) and False)


def prop(_c, _s, _p, _i, name):
    if state["gone"]: return None
    return GLib.Variant("s", "1") if name == "Id" else GLib.Variant("b", state["hint"])


conn.register_object(ROOT, iface[MGR], method, None, None)
conn.register_object(REAL, iface[SES], None, prop, None)
conn.register_object(AUTO, iface[SES], None, prop, None)
conn.register_object("/com/bento/Rig", iface["com.bento.Rig"], method, None, None)
bus("RequestName", LOGIND, 4)
bus("RequestName", "com.bento.Rig", 4)
open(sys.argv[1], "w").write("ready\n")
conn.connect("closed", lambda *_: loop.quit())
loop = GLib.MainLoop()
loop.run()
