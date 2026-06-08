#!/bin/bash

# Store PIDs of background processes so we can terminate them on shutdown
declare -a BG_PIDS

# Signal handler for graceful shutdown
shutdown_handler() {
  echo "Received SIGTERM, shutting down gracefully..."
  
  # Terminate all background processes
  for pid in "${BG_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Terminating background process $pid"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  
  # Wait for background processes to finish (with a timeout)
  local timeout=10
  local count=0
  while [[ ${#BG_PIDS[@]} -gt 0 ]] && [[ $count -lt $timeout ]]; do
    for i in "${!BG_PIDS[@]}"; do
      if ! kill -0 "${BG_PIDS[$i]}" 2>/dev/null; then
        unset 'BG_PIDS[$i]'
      fi
    done
    if [[ ${#BG_PIDS[@]} -gt 0 ]]; then
      sleep 0.5
      ((count++))
    fi
  done
  
  # Kill any remaining processes
  for pid in "${BG_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force killing background process $pid"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  
  echo "Shutdown complete"
  exit 0
}

# Set up signal handler
trap shutdown_handler SIGTERM SIGINT

# Set up the system time zone
if [ -z "$TZ" ]; then
    TZ="Etc/UTC"
fi

echo "$TZ" > /etc/timezone
ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime

# Run avahi-daemon in the background
/usr/sbin/avahi-daemon -s -D
BG_PIDS+=($(pgrep -f avahi-daemon))

# If legacy .mozilla-iot directory exists, then move it to .webthings
if [[ "$WEBTHINGS_HOME" == "$HOME/.webthings" &&
      -d "$HOME/.mozilla-iot" &&
      ! -e "$HOME/.webthings" ]]; then
  mv "$HOME/.mozilla-iot" "$HOME/.webthings"
fi

# If .webthings directory doesn't exist then create it
if [[ ! -e /root/.webthings ]]; then
    mkdir -p /root/.webthings
fi

# Make sure the root user owns the .webthings data directory
chown -R root:root /root/.webthings

# Store data in root's home directory
export WEBTHINGS_HOME=/root/.webthings

# Start the USB device monitor in the background so that USB serial
# devices (e.g. Zigbee dongles) are dynamically created/removed in /dev
/usr/local/bin/usb-monitor.sh &
USB_MONITOR_PID=$!
BG_PIDS+=("$USB_MONITOR_PID")

# Run the gateway as root with production configuration
cd /root/webthings/gateway
NODE_ENV=production exec ./run-app.sh
