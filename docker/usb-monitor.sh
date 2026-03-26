#!/bin/bash
#
# USB Serial Device Monitor
#
# Dynamically creates and removes /dev nodes for USB serial devices
# (ttyACM*, ttyUSB*) by polling /sys/class/tty/. This allows USB dongles
# (e.g. Zigbee adapters) to be hot-plugged without running the container
# in privileged mode.
#
# Requires:
#   - The usb-cgroup-helper sidecar to whitelist device majors 166/188
#     in this container's cgroup (see docker/usb-cgroup-helper/)
#   - /sys mounted (default in Docker, or via io.balena.features.sysfs label)
#
# The container's default MKNOD capability is used to create device nodes.

POLL_INTERVAL="${USB_MONITOR_POLL_INTERVAL:-2}"
DEV_PATTERNS="ttyACM ttyUSB"

create_device_node() {
    local name="$1"
    local sys_dev="/sys/class/tty/${name}/dev"

    if [ ! -f "$sys_dev" ]; then
        return
    fi

    local dev_numbers
    dev_numbers=$(cat "$sys_dev")
    local major="${dev_numbers%%:*}"
    local minor="${dev_numbers##*:}"

    if [ ! -e "/dev/${name}" ]; then
        mknod "/dev/${name}" c "$major" "$minor" 2>/dev/null && \
            chmod 660 "/dev/${name}" && \
            echo "usb-monitor: created /dev/${name} (${major}:${minor})"
    fi
}

scan_and_sync() {
    # Create nodes for devices present in sysfs
    for pattern in $DEV_PATTERNS; do
        for sys_entry in /sys/class/tty/${pattern}*; do
            [ -e "$sys_entry" ] || continue
            create_device_node "$(basename "$sys_entry")"
        done
    done

    # Remove nodes for devices no longer in sysfs
    for pattern in $DEV_PATTERNS; do
        for dev_node in /dev/${pattern}*; do
            [ -e "$dev_node" ] || continue
            local name
            name=$(basename "$dev_node")
            if [ ! -e "/sys/class/tty/${name}/dev" ]; then
                rm -f "$dev_node"
                echo "usb-monitor: removed stale /dev/${name}"
            fi
        done
    done
}

# Initial scan before the gateway starts
scan_and_sync

# Continue polling in the background
while true; do
    sleep "$POLL_INTERVAL"
    scan_and_sync
done
