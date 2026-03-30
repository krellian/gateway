#!/bin/sh
#
# USB cgroup helper — privileged sidecar
#
# Whitelists USB serial device classes (ttyACM major 166, ttyUSB major 188)
# in the gateway container's cgroup so that device nodes created by
# usb-monitor.sh are actually accessible. This sidecar runs privileged so
# the gateway container itself does not need to be.
#
# Environment:
#   GATEWAY_SERVICE  — balena service name of the gateway (default: webthings-gateway)
#   POLL_INTERVAL    — seconds between cgroup-check loops (default: 5)
#
# Requires:
#   io.balena.features.balena-socket  (access to balenaEngine API)
#   io.balena.features.sysfs          (host /sys for cgroup writes)
#   io.balena.features.procfs         (host /proc for cgroup path discovery)
#   privileged: true

GATEWAY_SERVICE="${GATEWAY_SERVICE:-webthings-gateway}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
BALENA_SOCKET="/var/run/balena-engine.sock"

# Device class rules to whitelist (character devices)
CGROUP_RULES="c 166:* rwm
c 188:* rwm"

log() {
    echo "cgroup-helper: $*"
}

# Resolve the gateway container's ID via the balenaEngine API.
get_gateway_container_id() {
    # List containers filtered by label matching our service name.
    # The balena supervisor sets io.balena.service-name on each container.
    local id
    id=$(curl -sf --unix-socket "$BALENA_SOCKET" \
        "http://localhost/containers/json?filters=%7B%22label%22%3A%5B%22io.balena.service-name%3D${GATEWAY_SERVICE}%22%5D%7D" \
        | jq -r '.[0].Id // empty' 2>/dev/null)
    echo "$id"
}

# Find the cgroup devices.allow path for a container by inspecting its
# actual cgroup membership via /proc/<pid>/cgroup (requires host procfs
# and host sysfs mounted via balena feature labels).
find_devices_allow() {
    local container_id="$1"

    # Get the host PID of the gateway container via the inspect API
    local host_pid
    host_pid=$(curl -sf --unix-socket "$BALENA_SOCKET" \
        "http://localhost/containers/${container_id}/json" \
        | jq -r '.State.Pid // empty' 2>/dev/null)

    if [ -n "$host_pid" ] && [ "$host_pid" != "0" ]; then
        # Read the actual cgroup path from the container's procfs entry
        local cgroup_rel
        cgroup_rel=$(grep ':devices:' "/proc/${host_pid}/cgroup" 2>/dev/null | cut -d: -f3)

        if [ -n "$cgroup_rel" ]; then
            local path="/sys/fs/cgroup/devices${cgroup_rel}/devices.allow"
            if [ -f "$path" ]; then
                echo "$path"
                return 0
            fi
            log "procfs-derived path not found: ${path}"
        fi
    fi

    # Fallback: try well-known cgroup paths
    for base in \
        "/sys/fs/cgroup/devices/docker/${container_id}" \
        "/sys/fs/cgroup/devices/balena/${container_id}" \
        "/sys/fs/cgroup/devices/system.slice/balena-engine.service/docker/${container_id}" \
        "/sys/fs/cgroup/devices/system.slice/balena-engine.service/balena/${container_id}" ; do
        if [ -f "${base}/devices.allow" ]; then
            echo "${base}/devices.allow"
            return 0
        fi
    done

    # Last resort: search the cgroup hierarchy
    local match
    match=$(find /sys/fs/cgroup/devices -maxdepth 8 -path "*${container_id}*/devices.allow" 2>/dev/null | head -1)
    if [ -n "$match" ]; then
        echo "$match"
        return 0
    fi

    return 1
}

apply_rules() {
    local allow_path="$1"

    echo "$CGROUP_RULES" | while IFS= read -r rule; do
        [ -z "$rule" ] && continue
        echo "$rule" > "$allow_path" 2>/dev/null && \
            log "wrote '${rule}' -> ${allow_path}"
    done
}

# ── main loop ────────────────────────────────────────────────────────

log "starting (gateway service: ${GATEWAY_SERVICE})"

LAST_CONTAINER_ID=""
APPLIED=false

while true; do
    CONTAINER_ID=$(get_gateway_container_id)

    if [ -z "$CONTAINER_ID" ]; then
        log "gateway container not found yet, waiting..."
        APPLIED=false
        sleep "$POLL_INTERVAL"
        continue
    fi

    # Re-apply if the container was recreated (new ID)
    if [ "$CONTAINER_ID" != "$LAST_CONTAINER_ID" ]; then
        APPLIED=false
        LAST_CONTAINER_ID="$CONTAINER_ID"
    fi

    if [ "$APPLIED" = false ]; then
        ALLOW_PATH=$(find_devices_allow "$CONTAINER_ID") || true

        if [ -z "$ALLOW_PATH" ]; then
            log "cgroup devices.allow not found for ${CONTAINER_ID:0:12}, retrying..."
            sleep "$POLL_INTERVAL"
            continue
        fi

        log "found cgroup path for gateway (${CONTAINER_ID:0:12})"
        apply_rules "$ALLOW_PATH"
        APPLIED=true
        log "cgroup rules applied — gateway can now access USB serial devices"
    fi

    sleep "$POLL_INTERVAL"
done
