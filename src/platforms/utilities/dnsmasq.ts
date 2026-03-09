/**
 * Dnsmasq Manager.
 *
 * Manages a dnsmasq child process for captive portal DNS/DHCP when
 * the gateway is in Wi-Fi access point mode.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ChildProcess, spawn } from 'child_process';

class DnsmasqManager {
  private process: ChildProcess | null = null;

  /**
   * Start a dnsmasq process for captive portal functionality.
   *
   * Configures dnsmasq to:
   * - Serve DHCP leases on the AP interface's subnet
   * - Redirect all DNS queries to the gateway IP (captive portal)
   *
   * @param {string} gateway - The IP address of the gateway (e.g. '192.168.2.1')
   * @param {string} iface - The network interface to listen on (e.g. 'wlan0')
   * @param {string} dhcpRangeStart - Start of DHCP range (e.g. '192.168.2.2')
   * @param {string} dhcpRangeEnd - End of DHCP range (e.g. '192.168.2.254')
   */
  start(gateway: string, iface: string, dhcpRangeStart: string, dhcpRangeEnd: string): void {
    // Stop any existing process first
    this.stop();

    const args = [
      // Run in foreground (no daemon)
      '--no-daemon',
      // Don't read /etc/resolv.conf
      '--no-resolv',
      // Only listen on the specified interface
      `--interface=${iface}`,
      // Don't bind to wildcard address; only bind to the interface
      '--bind-interfaces',
      // Listen address
      `--listen-address=${gateway}`,
      // Redirect all DNS queries to the gateway IP (captive portal)
      `--address=/#/${gateway}`,
      // DHCP range and lease time
      `--dhcp-range=${dhcpRangeStart},${dhcpRangeEnd},24h`,
      // Set the gateway/router option for DHCP clients
      `--dhcp-option=option:router,${gateway}`,
      // Set the DNS server option for DHCP clients
      `--dhcp-option=option:dns-server,${gateway}`,
      // Store lease database in a temp file (not /dev/null which fails in some containers)
      '--dhcp-leasefile=/tmp/dnsmasq.leases',
      // Suppress "no upstream servers" warnings since we redirect everything
      '--log-dhcp',
    ];

    console.log(`dnsmasq: starting on interface ${iface} with gateway ${gateway}`);

    this.process = spawn('dnsmasq', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`dnsmasq: ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`dnsmasq: ${data.toString().trim()}`);
    });

    this.process.on('error', (err: Error) => {
      console.error(`dnsmasq: failed to start: ${err.message}`);
      this.process = null;
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      if (signal) {
        console.log(`dnsmasq: exited due to signal ${signal}`);
      } else if (code !== null && code !== 0) {
        console.error(`dnsmasq: exited with code ${code}`);
      } else {
        console.log('dnsmasq: exited');
      }
      this.process = null;
    });
  }

  /**
   * Stop the dnsmasq process if running.
   */
  stop(): void {
    if (this.process) {
      console.log('dnsmasq: stopping');
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  /**
   * Check whether dnsmasq is currently running.
   *
   * @returns {boolean} true if running, false otherwise.
   */
  isRunning(): boolean {
    return this.process !== null;
  }
}

export default new DnsmasqManager();
