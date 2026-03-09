/**
 * Balena OS platform interface.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import ip from 'ip';
import { Netmask } from 'netmask';
import BasePlatform from './base';
import fs from 'fs';
import { execFileSync } from 'child_process';
import NetworkManager, { ConnectionSettings } from './utilities/network-manager';
import DnsmasqManager from './utilities/dnsmasq';
import {
  LanMode,
  NetworkAddresses,
  WirelessMode,
  WirelessNetwork,
  SelfUpdateStatus,
} from './types';

// Balena supervisor address from environment variable (e.g. http://<supervisor-ip>:48484)
const BALENA_SUPERVISOR_ADDRESS: string = process.env.BALENA_SUPERVISOR_ADDRESS || '';
// Balena supervisor API key from environment variable
const BALENA_SUPERVISOR_API_KEY: string = process.env.BALENA_SUPERVISOR_API_KEY || '';

export class LinuxBalenaOSPlatform extends BasePlatform {
  /**
   * Disconnect NetworkManager.
   */
  stop(): void {
    NetworkManager.stop();
  }

  /**
   * Get the current addresses for Wi-Fi and LAN.
   *
   * @returns {Promise<NetworkAddresses>} Promise that resolves with
   *   {
   *     lan: '...',
   *     wlan: {
   *      ip: '...',
   *      ssid: '...',
   *    }
   *  }
   */
  async getNetworkAddressesAsync(): Promise<NetworkAddresses> {
    const result: NetworkAddresses = {
      lan: '',
      wlan: {
        ip: '',
        ssid: '',
      },
    };

    // Try to get an Ethernet IP address
    try {
      const ethernetDevices = await NetworkManager.getEthernetDevices();
      if (ethernetDevices.length > 0) {
        const ethernetIp4Config = await NetworkManager.getDeviceIp4Config(ethernetDevices[0]);
        if (ethernetIp4Config && ethernetIp4Config.length >= 1 && ethernetIp4Config[0].address) {
          result.lan = ethernetIp4Config[0].address;
        } else {
          console.log('No ethernet IP address found');
        }
      } else {
        console.log('No Ethernet devices found');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting Ethernet IP address: ${errorMsg}`);
    }

    // Try to get a Wi-Fi IP address
    try {
      const wifiDevices = await NetworkManager.getWifiDevices();
      if (wifiDevices.length > 0) {
        const wifiIp4Config = await NetworkManager.getDeviceIp4Config(wifiDevices[0]);
        const accessPoint = await NetworkManager.getActiveAccessPoint(wifiDevices[0]);
        const ssid = await NetworkManager.getAccessPointSsid(accessPoint);
        if (wifiIp4Config && wifiIp4Config.length >= 1 && wifiIp4Config[0].address) {
          result.wlan.ip = wifiIp4Config[0].address;
        } else {
          console.log('No Wi-Fi IP address found');
        }
        if (accessPoint && ssid) {
          result.wlan.ssid = ssid;
        } else {
          console.log('No Wi-Fi SSID found');
        }
      } else {
        console.log('No Wi-Fi devices found');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Unable to detect Wi-Fi: ${errorMsg}`);
      console.log('Unable to detect a Wi-Fi IP address and active SSID');
    }

    return result;
  }

  /**
   * Get LAN network settings.
   *
   * @returns {Promise<LanMode>} Promise that resolves with
   *   {mode: 'static|dhcp|...', options: {...}}
   */
  async getLanModeAsync(): Promise<LanMode> {
    const result: LanMode = {
      mode: '',
      options: {},
    };

    // Try to get a list of Ethernet devices
    let devices: Array<string>;
    try {
      devices = await NetworkManager.getEthernetDevices();
      if (devices.length < 1) {
        return result;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting Ethernet device: ${errorMsg}`);
      return result;
    }

    // Try to get connection path for first Ethernet device
    let connection: string;
    try {
      connection = await NetworkManager.getDeviceConnection(devices[0]);
      if (!connection) {
        console.log('No active LAN connection found');
        return result;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting connection for Ethernet device: ${errorMsg}`);
      return result;
    }

    // Try to get settings for Ethernet connection
    let settings: ConnectionSettings;
    try {
      settings = await NetworkManager.getConnectionSettings(connection);
      if (settings && settings.ipv4 && settings.ipv4.method == 'auto') {
        result.mode = 'dhcp';
      } else if (settings && settings.ipv4 && settings.ipv4.method == 'manual') {
        result.mode = 'static';
      }
      if (settings.ipv4 && settings.ipv4['address-data'] && settings.ipv4['address-data'][0]) {
        if (settings.ipv4['address-data'][0].hasOwnProperty('address')) {
          result.options.ipaddr = settings.ipv4['address-data'][0].address;
        }
        if (result.options.ipaddr && settings.ipv4['address-data'][0].hasOwnProperty('prefix')) {
          // Convert cidr style prefix to dot-decimal netmask
          const ip = result.options.ipaddr;
          const cidr = settings.ipv4['address-data'][0].prefix;
          const block = new Netmask(`${ip}/${cidr}`);
          result.options.netmask = block.mask;
        }
      }
      if (settings.ipv4 && settings.ipv4.hasOwnProperty('gateway')) {
        result.options.gateway = settings.ipv4.gateway;
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting connection settings for Ethernet device: ${errorMsg}`);
      return result;
    }
  }

  /**
   * Set LAN network settings.
   *
   * @param {string} mode static|dhcp|....
   * @param {Record<string, unknown>} options Mode-specific options.
   * @returns {Promise<boolean>} Promise that resolves true if successful and false if not.
   */
  async setLanModeAsync(mode: string, options: Record<string, unknown>): Promise<boolean> {
    // Try to get a list of Ethernet devices
    let devices: Array<string>;
    try {
      devices = await NetworkManager.getEthernetDevices();
      if (devices.length < 1) {
        return false;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting a list of Ethernet device: ${errorMsg}`);
      return false;
    }

    // Try to get connection path for first Ethernet device
    const lanDevice = devices[0];
    let lanConnection: string;
    try {
      lanConnection = await NetworkManager.getDeviceConnection(lanDevice);
      if (!lanConnection) {
        // TODO: If there is no active connection then try to create one
        console.error('No active LAN connection to configure');
        return false;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting connection path for Ethernet device: ${errorMsg}`);
      return false;
    }

    // Try to get existing connection settings for Ethernet connection
    let oldSettings: ConnectionSettings;
    try {
      oldSettings = await NetworkManager.getConnectionSettings(lanConnection);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting connection settings for Ethernet device: ${errorMsg}`);
      return false;
    }

    // Carry over some values from the old settings
    const settings: ConnectionSettings = {
      connection: {
        id: oldSettings.connection.id,
        uuid: oldSettings.connection.uuid,
        type: oldSettings.connection.type,
      },
    };

    // Create new settings object
    if (mode == 'dhcp') {
      // Set dynamic IP
      settings.ipv4 = {
        method: 'auto',
      };
    } else if (mode == 'static') {
      if (
        !(
          options.hasOwnProperty('ipaddr') &&
          ip.isV4Format(<string>options.ipaddr) &&
          options.hasOwnProperty('gateway') &&
          ip.isV4Format(<string>options.gateway) &&
          options.hasOwnProperty('netmask') &&
          ip.isV4Format(<string>options.netmask)
        )
      ) {
        console.error(
          'Setting a static IP address requires a valid IP address, gateway and netmask'
        );
        return false;
      }
      // Set static IP address
      // Convert dot-decimal netmask to cidr style prefix for storage
      const netmask = new Netmask(options.ipaddr as string, options.netmask as string);
      const prefix = netmask.bitmask;
      // Convert dot-decimal IP and gateway to little endian integers for storage
      const ipaddrReversed = (options.ipaddr as string).split('.').reverse().join('.');
      const ipaddrInt = ip.toLong(ipaddrReversed);
      const gatewayReversed = (options.gateway as string).split('.').reverse().join('.');
      const gatewayInt = ip.toLong(gatewayReversed);
      settings.ipv4 = {
        method: 'manual',
        addresses: [[ipaddrInt, prefix, gatewayInt]],
        // The NetworkManager docs say that the addresses property is deprecated,
        // but using address-data and gateway doesn't seem to work on Ubuntu or
        // balenaOS yet.
        /*
        'address-data': [{
          'address': options.ipaddr,
          'prefix': prefix
        }],
        'gateway': options.gateway
        */
      };
    } else {
      console.error('LAN mode not recognised');
      return false;
    }

    // Try to set the connection settings and activate the connection
    try {
      await NetworkManager.setConnectionSettings(lanConnection, settings);
      await NetworkManager.activateConnection(lanConnection, lanDevice);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error setting LAN settings: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Scan for visible wireless networks on the first wireless device.
   *
   * @returns {Promise<WirelessNetwork[]>} Promise which resolves with an array
   *   of networks as objects:
   *  [
   *    {
   *      ssid: '...',
   *      quality: <number>,
   *      encryption: true|false,
   *      configured: true|false,
   *      connected: true|false
   *    },
   *    ...
   *  ]
   * @throws {Error} Throws an error on failure.
   */
  async scanWirelessNetworksAsync(): Promise<WirelessNetwork[]> {
    // Try to get a list of Wi-Fi devices
    let wifiDevices: Array<string>;
    try {
      wifiDevices = await NetworkManager.getWifiDevices();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting a list of Wi-Fi devices: ${errorMsg}`);
      throw new Error();
    }
    if (wifiDevices.length < 1) {
      console.error('No Wi-Fi devices found.');
      throw new Error();
    }

    // Request a fresh scan on first Wi-Fi device and wait for it to complete
    // by monitoring the LastScan property, with a fallback timeout.
    try {
      await NetworkManager.waitForScanComplete(wifiDevices[0]);
    } catch (error) {
      // RequestScan may fail if the device is in AP mode, which is expected.
      console.log('Wi-Fi scan request failed, using cached results');
    }

    // Try to get a list of Wi-Fi access points
    let wifiAccessPoints: Array<string>;
    try {
      wifiAccessPoints = await NetworkManager.getWifiAccessPoints(wifiDevices[0]);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting a list of Wi-Fi access points: ${errorMsg}`);
      throw new Error();
    }

    let activeAccessPoint: string | null;
    try {
      activeAccessPoint = await NetworkManager.getActiveAccessPoint(wifiDevices[0]);
    } catch (error) {
      activeAccessPoint = null;
    }

    // Get the SSID of the device's own AP (if in AP mode) so we can filter it out
    let ownSsid: string | null = null;
    if (activeAccessPoint) {
      try {
        const connectionPath = await NetworkManager.getDeviceConnection(wifiDevices[0]);
        if (connectionPath) {
          const settings = await NetworkManager.getConnectionSettings(connectionPath);
          if (
            settings['802-11-wireless'] &&
            settings['802-11-wireless'].mode === 'ap' &&
            settings['802-11-wireless'].ssid
          ) {
            ownSsid = String.fromCharCode(...settings['802-11-wireless'].ssid);
          }
        }
      } catch (error) {
        console.log('Could not determine own SSID for de-duplication');
      }
    }

    // Try to get the details for all available access points
    const apRequests: Array<Promise<WirelessNetwork>> = [];
    wifiAccessPoints.forEach((ap) => {
      apRequests.push(NetworkManager.getAccessPointDetails(ap, activeAccessPoint));
    });
    let responses: Array<WirelessNetwork> = [];
    try {
      responses = await Promise.all(apRequests);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.log(`Error getting details of access point: ${errorMsg}`);
    }

    // Filter out empty SSIDs, the device's own AP, and deduplicate by SSID
    // (keeping the entry with the strongest signal for each SSID)
    const filtered = responses.filter((network) => {
      if (!network.ssid) {
        return false;
      }
      if (ownSsid && network.ssid === ownSsid) {
        return false;
      }
      return true;
    });
    const seen = new Map<string, WirelessNetwork>();
    for (const network of filtered) {
      const existing = seen.get(network.ssid);
      if (!existing || network.quality > existing.quality) {
        seen.set(network.ssid, network);
      }
    }

    // Return the filtereed list
    return Array.from(seen.values());
  }

  /**
   * Get the wireless mode and options.
   *
   * @returns {Promise<WirelessMode>} Promise which resolves with a WirelessMode object
   * {
   *   enabled: true|false,
   *   mode: 'ap'|'sta',    // Access point mode or station mode
   *   options: {
   *     ssid: <ssid>       // If connected, the curent SSID
   *     networks: [<ssid>] // Otherwise, a list of configured Wi-Fi networks
   *   }
   * }
   */
  async getWirelessModeAsync(): Promise<WirelessMode> {
    const result: WirelessMode = {
      enabled: false,
      mode: '',
      options: {},
    };

    // Try to get a list of Wi-Fi devices
    let wifiDevices: Array<string>;
    try {
      wifiDevices = await NetworkManager.getWifiDevices();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting a list of Wi-Fi devices: ${errorMsg}`);
      return result;
    }

    // If no Wi-Fi devices then give up now
    if (wifiDevices.length < 1) {
      return result;
    }

    // Otherwise try to get the state of the first wireless device
    const wifiDevicePath = wifiDevices[0];
    let state: number;
    try {
      state = await NetworkManager.getDeviceState(wifiDevicePath);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting state of Wi-Fi device: ${errorMsg}`);
      return result;
    }

    // If the device is in an activated state
    // (either as an active access point or connected to an access point)
    // then try to get its connection settings
    if (state === 100) {
      result.enabled = true;
      let connectionPath: string;
      try {
        connectionPath = await NetworkManager.getDeviceConnection(wifiDevicePath);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : error;
        console.error(`Error getting details of Wi-Fi device: ${errorMsg}`);
        return result;
      }
      if (connectionPath) {
        let settings: ConnectionSettings;
        try {
          settings = await NetworkManager.getConnectionSettings(connectionPath);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : error;
          console.error(`Error getting connection settings of Wi-Fi device: ${errorMsg}`);
          return result;
        }
        // Check for access point wireless mode
        if (settings['802-11-wireless'] && settings['802-11-wireless'].mode == 'ap') {
          result.mode = 'ap';
          // Otherwise assume standard (infrastructure) mode
        } else {
          result.mode = 'sta';
        }
        // Check for ssid
        if (settings['802-11-wireless'] && settings['802-11-wireless'].ssid) {
          // Convert SSID from byte array to string
          result.options.ssid = String.fromCharCode(...settings['802-11-wireless'].ssid);
        }
      }
      return result;
    } else {
      // Assume Wi-Fi is not configured and populate options.networks
      // with a list of configured Wi-Fi connections that it might be possible to
      // connect to.
      let connectionPaths: Array<string>;
      try {
        connectionPaths = await NetworkManager.listConnections();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : error;
        console.error(`Error getting a list of configured network connections: ${errorMsg}`);
        return result;
      }
      const networks: string[] = [];
      for (const connPath of connectionPaths) {
        try {
          const connSettings = await NetworkManager.getConnectionSettings(connPath);
          if (
            connSettings.connection &&
            connSettings.connection.type === '802-11-wireless' &&
            connSettings['802-11-wireless'] &&
            connSettings['802-11-wireless'].ssid &&
            (!connSettings['802-11-wireless'].mode ||
              connSettings['802-11-wireless'].mode === 'infrastructure')
          ) {
            const ssid = String.fromCharCode(...connSettings['802-11-wireless'].ssid);
            networks.push(ssid);
          }
        } catch (error) {
          // Skip connections whose settings can't be read
          console.debug(`Couldn't read connection settings for path ${connPath}`);
        }
      }
      result.options.networks = networks;
      return result;
    }
  }

  /**
   * Set the wireless mode and options.
   *
   * @param {boolean} enabled - whether or not wireless is enabled
   * @param {string} mode - ap, sta, ...
   * @param {Record<string, unknown>} options - options specific to wireless mode
   * @returns {Promise<boolean>} Boolean indicating success.
   */
  async setWirelessModeAsync(
    enabled: boolean,
    mode = 'ap',
    options: Record<string, unknown> = {}
  ): Promise<boolean> {
    // Check for valid wireless mode
    const valid = ['ap', 'sta'];
    if (enabled && !valid.includes(mode)) {
      console.error(`Wireless mode ${mode} not supported on this platform`);
      return false;
    }

    // Try to get a list of Wi-Fi devices
    let wifiDevices: Array<string>;
    try {
      wifiDevices = await NetworkManager.getWifiDevices();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting a list of wireless devices: ${errorMsg}`);
      return false;
    }
    if (wifiDevices.length < 1) {
      console.error('No Wi-Fi devices found');
      return false;
    }

    // If `enabled` set to false, deactivate the active connection of the first
    // Wi-Fi device (rather than disconnecting it entirely, so the device remains
    // available for new connections).
    if (enabled === false) {
      try {
        const activeConnectionPath: string = await NetworkManager.getDeviceActiveConnectionPath(
          wifiDevices[0]
        );
        if (activeConnectionPath) {
          await NetworkManager.deactivateConnection(activeConnectionPath);
        } else {
          console.error('Unable to find connection path to disable Wi-Fi connection.');
          return false;
        }
      } catch (error) {
        console.error(`Error whilst attempting to deactivate wireless connection: ${error}`);
        return false;
      }
      return true;
    }

    // Check enabled is set to true before continuing
    if (enabled !== true) {
      console.error('Invalid value for enabled when setting wireless mode');
      return false;
    }

    // If AP mode requested, configure as a Wi-Fi access point
    if (mode === 'ap') {
      if (!options.hasOwnProperty('ssid')) {
        console.error('SSID must be provided for AP mode');
        return false;
      }

      // Try to get path for Wi-Fi connection
      const wifiDevice = wifiDevices[0];
      let connectionPath: string;
      try {
        connectionPath = await NetworkManager.getDeviceConnection(wifiDevice);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : error;
        console.error(`Error getting path for Wi-Fi connection: ${errorMsg}`);
        return false;
      }

      // Convert SSID string to byte array
      const ssidStr = options.ssid as string;
      const ssidBytes: number[] = [];
      for (let i = 0; i < ssidStr.length; i++) {
        ssidBytes.push(ssidStr.charCodeAt(i));
      }

      // Create settings for AP mode
      // Use 'manual' method so NetworkManager only assigns the static IP
      // without spawning its own dnsmasq. DHCP and DNS for the captive
      // portal are handled by the dnsmasq process we spawn separately.
      const ipaddr = options.ipaddr ? (options.ipaddr as string) : '192.168.2.1';
      const parts = ipaddr.split('/');
      const address = parts[0];
      const prefix = parts.length > 1 ? parseInt(parts[1]) : 24;

      // Note: address-data has issues with DBus serialization on some systems.
      // Use the deprecated 'addresses' property which is an array:
      // [ipAsLongInt, prefix, gatewayAsLongInt]
      // Convert dot-decimal IP to little endian integer for storage
      const ipReversed = address.split('.').reverse().join('.');
      const ipInt = ip.toLong(ipReversed);
      const gatewayInt = ipInt; // Gateway is the AP's own address

      const settings: ConnectionSettings = {
        connection: {
          id: ssidStr, // Use SSID as the connection ID
          type: '802-11-wireless',
        },
        '802-11-wireless': {
          ssid: ssidBytes,
          mode: 'ap',
        },
        ipv4: {
          method: 'manual',
          addresses: [[ipInt, prefix, gatewayInt]],
        },
      };

      // If there's an existing connection, update it
      // Otherwise, use AddAndActivateConnection to create a new one
      if (connectionPath) {
        try {
          await NetworkManager.setConnectionSettings(connectionPath, settings);
          await NetworkManager.activateConnection(connectionPath, wifiDevice);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : error;
          console.error(`Error trying to set and activate Wi-Fi settings: ${errorMsg}`);
          return false;
        }
      } else {
        // No existing connection, so add and activate a new one
        console.log('No existing Wi-Fi connection found, creating new AP connection');
        try {
          await NetworkManager.addAndActivateConnection(settings, wifiDevice);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : error;
          console.error(`Error trying to add and activate a new Wi-Fi connection: ${errorMsg}`);
          return false;
        }
      }

      return true;
    }

    // Otherwise connect to Wi-Fi access point using provided options (STA mode)
    if (!options.hasOwnProperty('ssid')) {
      console.log('Could not connect to wireless network because no SSID provided');
      return false;
    }
    // Try to find the access point by SSID for a more targeted connection.
    // If not found (e.g. scan results are stale after AP teardown), pass '/'
    // to let NetworkManager find a suitable access point by SSID itself.
    let accessPoint: string | null = null;
    try {
      accessPoint = await NetworkManager.getAccessPointbySsid(options.ssid as string);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error trying to get access point via SSID: ${errorMsg}`);
    }
    if (accessPoint == null) {
      console.log('Access point not found in cached scan results, letting NetworkManager find it');
      accessPoint = '/';
    }

    // If a key was provided then authenticate with the access point
    let secure = false;
    if (options.key) {
      secure = true;
    }

    // Try to connect to the Wi-Fi access point.
    try {
      await NetworkManager.connectToWifiAccessPoint(
        wifiDevices[0],
        accessPoint,
        <string>options.ssid,
        secure,
        <string>options.key
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error connecting to Wi-Fi access point: ${errorMsg}`);
      return false;
    }
    return true;
  }

  /**
   * Get DHCP server status (of Wi-Fi device).
   *
   * @returns {boolean} Boolean indicating whether or not a DHCP server is running.
   */
  async getDhcpServerStatusAsync(): Promise<boolean> {
    return DnsmasqManager.isRunning();
  }

  /**
   * Set DHCP server status (of Wi-Fi device).
   *
   * Starts or stops a dnsmasq process to provide DNS/DHCP for the captive
   * portal when in AP mode. When enabling, waits for the Wi-Fi device to
   * become fully activated before binding dnsmasq to the interface.
   *
   * @param {boolean} enabled - Whether or not to enable the DHCP server
   * @returns {boolean} Boolean indicating success of the command.
   */
  async setDhcpServerStatusAsync(enabled: boolean): Promise<boolean> {
    if (!enabled) {
      DnsmasqManager.stop();
      return true;
    }

    // Get the first Wi-Fi device
    let wifiDevices: Array<string>;
    try {
      wifiDevices = await NetworkManager.getWifiDevices();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting a list of Wi-Fi devices: ${errorMsg}`);
      return false;
    }
    if (wifiDevices.length < 1) {
      console.error('No Wi-Fi devices found');
      return false;
    }
    const wifiDevice = wifiDevices[0];

    // Get the active connection settings to determine the gateway IP
    let connectionPath: string;
    try {
      connectionPath = await NetworkManager.getDeviceConnection(wifiDevice);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting Wi-Fi connection path: ${errorMsg}`);
      return false;
    }
    if (!connectionPath) {
      console.error('No active Wi-Fi connection, cannot start DHCP server');
      return false;
    }

    let settings: ConnectionSettings;
    try {
      settings = await NetworkManager.getConnectionSettings(connectionPath);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : error;
      console.error(`Error getting Wi-Fi connection settings: ${errorMsg}`);
      return false;
    }

    // Extract the gateway IP from the connection's IPv4 addresses
    // addresses is [[ipInt, prefix, gatewayInt]] stored as little-endian integers
    if (!settings.ipv4 || !settings.ipv4.addresses || settings.ipv4.addresses.length < 1) {
      console.error(
        'No IPv4 address configured on Wi-Fi connection, cannot start DHCP setDhcpServerStatusAsyncserver'
      );
      return false;
    }
    const ipInt = settings.ipv4.addresses[0][0];
    // Convert little-endian integer back to dot-decimal
    const ipReversed = ip.fromLong(ipInt);
    const address = ipReversed.split('.').reverse().join('.');

    // Wait for NetworkManager to fully activate the AP and assign the
    // IP address to the interface before starting dnsmasq, otherwise
    // dnsmasq will fail to bind to the address.
    const ifaceName = await NetworkManager.getDeviceInterface(wifiDevice);
    for (let i = 0; i < 30; i++) {
      try {
        const state = await NetworkManager.getDeviceState(wifiDevice);
        if (state === 100) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : error;
        console.error(`Error waiting for Wi-Fi device to activate: ${errorMsg}`);
        // Keep trying
      }
    }

    // Derive the DHCP range from the gateway IP's /24 subnet
    const subnet = address.split('.').slice(0, 3).join('.');
    DnsmasqManager.start(address, ifaceName, `${subnet}.2`, `${subnet}.254`);

    // TODO: Is there a way to determine when dnsmasq has started succesfully
    //  before returning?

    return true;
  }

  /**
   * Get a list of all valid wi-fi countries for the system.
   *
   * @returns {string[]} List of countries.
   */
  getValidWirelessCountries(): string[] {
    const fname = '/usr/share/zoneinfo/iso3166.tab';
    if (!fs.existsSync(fname)) {
      return [];
    }

    try {
      const data = fs.readFileSync(fname, 'utf8');
      const zones = data
        .split('\n')
        .filter((l) => !l.startsWith('#') && l.length > 0)
        .map((l) => l.split('\t')[1])
        .sort();

      return zones;
    } catch (e) {
      console.error('Failed to read zone file:', e);
    }

    return [];
  }

  /**
   * Get the current wireless regulatory domain.
   *
   * @returns {string} The full country name (e.g. 'United States', 'United Kingdom'),
   *   or empty string if unable to determine.
   */
  getWirelessCountry(): string {
    // Get the current country code
    try {
      const stdout = execFileSync('iw', ['reg', 'get'], { encoding: 'utf8' });
      // First try to find per-phy country (e.g. under "phy#0")
      let countryCode: string | null = null;
      const phyMatch = stdout.match(/phy#\d+[\s\S]*?country\s+(\w+):/);
      if (phyMatch && phyMatch[1]) {
        countryCode = phyMatch[1];
      } else {
        // Fall back to global country
        const globalMatch = stdout.match(/country\s+(\w+):/);
        if (globalMatch && globalMatch[1]) {
          countryCode = globalMatch[1];
        }
      }

      if (!countryCode) {
        return '';
      }

      // Look up the country name from iso3166.tab
      const fname = '/usr/share/zoneinfo/iso3166.tab';
      if (!fs.existsSync(fname)) {
        return '';
      }

      const data = fs.readFileSync(fname, 'utf8');
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.startsWith('#') || line.length === 0) {
          continue;
        }
        const parts = line.split('\t');
        if (parts[0] === countryCode && parts[1]) {
          return parts[1];
        }
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
      console.error(`Error getting wireless country: ${errorMsg}`);
    }

    return '';
  }

  /**
   * Get a list of all valid timezones for the system.
   *
   * @returns {string[]} List of timezones.
   */
  getValidTimezones(): string[] {
    const tzdata = '/usr/share/zoneinfo/zone.tab';
    if (!fs.existsSync(tzdata)) {
      return [];
    }

    try {
      const data = fs.readFileSync(tzdata, 'utf8');
      const zones = data
        .split('\n')
        .filter((l) => !l.startsWith('#') && l.length > 0)
        .map((l) => l.split(/\s+/g)[2])
        .sort();

      return zones;
    } catch (e) {
      console.error('Failed to read zone file:', e);
    }

    return [];
  }

  /**
   * Get the current timezone.
   *
   * @returns {string} Name of timezone.
   */
  getTimezone(): string {
    const tzdata = '/etc/timezone';
    if (!fs.existsSync(tzdata)) {
      return '';
    }

    try {
      const data = fs.readFileSync(tzdata, 'utf8');
      return data.trim();
    } catch (e) {
      console.error('Failed to read timezone:', e);
    }

    return '';
  }

  /**
   * Get the system's hostname.
   *
   * @returns {string} The hostname or an empty string if no hostname can be detected.
   */
  async getHostnameAsync(): Promise<string> {
    if (
      !BALENA_SUPERVISOR_ADDRESS ||
      !BALENA_SUPERVISOR_API_KEY ||
      BALENA_SUPERVISOR_ADDRESS === '' ||
      BALENA_SUPERVISOR_API_KEY === ''
    ) {
      console.error('Unable to get system hostname from supervisor API');
      return '';
    }
    try {
      const options = {
        headers: {
          Accept: 'application/json',
        },
      };
      const response = await fetch(
        `${BALENA_SUPERVISOR_ADDRESS}/v1/device/host-config?apikey=${BALENA_SUPERVISOR_API_KEY}`,
        options
      );
      const config = await response.json();
      if (config.network && config.network.hostname) {
        return config.network.hostname;
      } else {
        return '';
      }
    } catch (error) {
      console.error('Error whilst attempting to retrieve system hostname from supervisor API');
      // Fall back to getting the hostname from /etc/hostname
      //return fs.readFileSync('/etc/hostname', 'utf8').trim();
      return '';
    }
  }

  /**
   * Set the system's hostname.
   *
   * @param {string} hostname - The hostname to set
   * @returns {boolean} Boolean indicating success of the command.
   */
  async setHostnameAsync(hostname: string): Promise<boolean> {
    if (
      !BALENA_SUPERVISOR_ADDRESS ||
      !BALENA_SUPERVISOR_API_KEY ||
      BALENA_SUPERVISOR_ADDRESS === '' ||
      BALENA_SUPERVISOR_API_KEY === ''
    ) {
      console.error('Unable to get system hostname from supervisor API');
      return false;
    }
    try {
      const body = {
        network: {
          hostname: hostname,
        },
      };
      const options = {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      };

      const response = await fetch(
        `${BALENA_SUPERVISOR_ADDRESS}/v1/device/host-config?apikey=${BALENA_SUPERVISOR_API_KEY}`,
        options
      );
      if (response.ok) {
        return true;
      } else {
        console.error('HTTP error whilst attempting to set system hostname from supervisor API');
        return false;
      }
    } catch (error) {
      console.error('Error whilst attempting to set system hostname from supervisor API');
      return false;
    }
  }

  /**
   * Get the MAC address of a network device.
   *
   * @param {string} device - The network device, e.g. wlan0
   * @returns {string|null} MAC address, or null on error
   *
   * Note: This instance of the method currently always returns the MAC address
   * of the first Wi-Fi device, and does not use the device argument since these
   * descriptors are not useful when using the NetworkManager DBus API.
   */
  async getMacAddressAsync(_device: string): Promise<string | null> {
    // Try to get a list of Wi-Fi devices
    let wifiDevices: Array<string>;
    try {
      wifiDevices = await NetworkManager.getWifiDevices();
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
      console.error(`Error getting a list of Wi-Fi devices: ${errorMsg}`);
      return null;
    }

    if (wifiDevices.length < 1) {
      console.error('No Wi-Fi devices found');
      return null;
    }
    const wifiDevicePath = wifiDevices[0];

    // Try to get the MAC address of the device
    let macAddress: string;
    try {
      macAddress = await NetworkManager.getDeviceMacAddress(wifiDevicePath);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
      console.error(`Failed to get MAC address of Wi-Fi device: ${errorMsg}`);
      return null;
    }

    return macAddress || null;
  }

  /**
   * Get mDNS server status.
   *
   * @returns {boolean} Boolean indicating whether or not mDNS is enabled.
   *
   * Currently we just always return true on balenaOS because mDNS is enabled by
   * default and there is no easy way to read its state or turn it on and off.
   */
  getMdnsServerStatus(): boolean {
    return true;
  }

  /**
   * Set mDNS server status.
   *
   * @param {boolean} enabled - Whether or not to enable the mDNS server
   * @returns {boolean} Boolean indicating success of the command.
   *
   * On balenaOS mDNS can't currently be disabled.
   */
  setMdnsServerStatus(enabled: boolean): boolean {
    if (enabled) {
      return true;
    }

    // can't disable
    return false;
  }

  /**
   * Get SSH server status.
   *
   * @returns {boolean} Boolean indicating whether or not SSH is enabled.
   */
  getSshServerStatus(): boolean {
    // SSH can not be disabled on balenaOS
    return true;
  }

  /**
   * Determine whether or not the gateway can auto-update itself.
   *
   * @returns {Object} {
   *                      available: <bool>,
   *                      enabled: <bool>,
   *                      configurable: <bool>,
   *                      triggerable: <bool>
   *                   }
   */
  getSelfUpdateStatus(): SelfUpdateStatus {
    // Automatic updates are supported on balenaOS but can not be disabled
    // or manually triggered from the UI
    return {
      available: true,
      enabled: true,
      configurable: false,
      triggerable: false,
    };
  }

  /**
   * Get the NTP synchronization status.
   *
   * @returns {Promise<boolean>} Promise that resolves with a boolean indicating
   *   whether or not the time has been synchronized.
   */
  async getNtpStatusAsync(): Promise<boolean> {
    let synchronized = false;
    try {
      synchronized = await NetworkManager.getNTPSynchronized();
      return synchronized;
    } catch (error) {
      console.error('Error retrieving NTP synchronised status: ' + error);
      return false;
    }
  }
}

export default new LinuxBalenaOSPlatform();
