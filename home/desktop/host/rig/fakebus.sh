# Sourced by the rigs: a private "system" bus with a fake logind on it, reached the
# way a shipped host reaches the real one (GLib reads DBUS_SYSTEM_BUS_ADDRESS, so no
# rig-only code path). Every identity rig needs it: with nothing listening for a
# lock, the agent opens no session.
#   fakebus_start <dir> [--locked]    sets FAKE_BUS_PID, FAKE_LOGIND_PID, exports the address
#   fakebus_stop                      stops exactly those two PIDs
fakebus_start() {
  local d=$1; shift
  rm -f "$d/system_bus_socket" "$d/fakelogind.ready"
  dbus-daemon --session --nofork --address="unix:path=$d/system_bus_socket" 2>"$d/fakebus.log" &
  FAKE_BUS_PID=$!
  for _ in $(seq 1 50); do [ -S "$d/system_bus_socket" ] && break; sleep 0.1; done
  export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$d/system_bus_socket"
  FAKE_BUS_PID=$FAKE_BUS_PID python3 rig/fakelogind.py "$d/fakelogind.ready" "$@" 2>"$d/fakelogind.log" &
  FAKE_LOGIND_PID=$!
  for _ in $(seq 1 50); do [ -f "$d/fakelogind.ready" ] && return 0; sleep 0.1; done
  echo "FAIL: the fake logind did not start: $(cat "$d/fakelogind.log")" >&2; exit 1
}
fakebus_stop() {
  kill "$FAKE_LOGIND_PID" "$FAKE_BUS_PID" 2>/dev/null
  wait "$FAKE_LOGIND_PID" "$FAKE_BUS_PID" 2>/dev/null
  return 0
}
