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
import { LanMode, NetworkAddresses, WirelessNetwork, SelfUpdateStatus } from './types';

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
    try {
      const ethernetDevices = await NetworkManager.getEthernetDevices();
      const ethernetIp4Config = await NetworkManager.getDeviceIp4Config(ethernetDevices[0]);
      result.lan = ethernetIp4Config[0].address;
    } catch (error) {
      console.error(error);
      console.log('Unable to detect an Ethernet IP address');
    }
    try {
      const wifiDevices = await NetworkManager.getWifiDevices();
      const wifiIp4Config = await NetworkManager.getDeviceIp4Config(wifiDevices[0]);
      const accessPoint = await NetworkManager.getActiveAccessPoint(wifiDevices[0]);
      const ssid = await NetworkManager.getAccessPointSsid(accessPoint);
      result.wlan.ip = wifiIp4Config[0].address;
      result.wlan.ssid = ssid;
    } catch (error) {
      console.error(error);
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
    return NetworkManager.getEthernetDevices()
      .then((devices) => {
        return NetworkManager.getDeviceConnection(devices[0]);
      })
      .then((connection) => {
        return NetworkManager.getConnectionSettings(connection);
      })
      .then((settings: ConnectionSettings) => {
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
      })
      .catch((error) => {
        console.error(`Error getting LAN mode from Network Manager: ${error}`);
        return result;
      });
  }

  /**
   * Set LAN network settings.
   *
   * @param {string} mode static|dhcp|....
   * @param {Record<string, unknown>} options Mode-specific options.
   * @returns {Promise<boolean>} Promise that resolves true if successful and false if not.
   */
  async setLanModeAsync(mode: string, options: Record<string, unknown>): Promise<boolean> {
    let lanDevice: string;
    let lanConnection: string;
    return NetworkManager.getEthernetDevices()
      .then((devices) => {
        lanDevice = devices[0];
        return NetworkManager.getDeviceConnection(lanDevice);
      })
      .then((connection) => {
        lanConnection = connection;
        // First get current settings to carry over some values
        return NetworkManager.getConnectionSettings(lanConnection);
      })
      .then((oldSettings) => {
        // Carry over some values from the old settings
        const settings: ConnectionSettings = {
          connection: {
            id: oldSettings.connection.id,
            uuid: oldSettings.connection.uuid,
            type: oldSettings.connection.type,
          },
        };

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
            console.log(
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
            // but using address-data and gateway doesn't seem to work on Ubuntu yet.
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
        return NetworkManager.setConnectionSettings(lanConnection, settings);
      })
      .then(() => {
        return NetworkManager.activateConnection(lanConnection, lanDevice);
      })
      .catch((error) => {
        console.error(`Error setting LAN settings: ${error}`);
        return false;
      });
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
   */
  async scanWirelessNetworksAsync(): Promise<WirelessNetwork[]> {
    const wifiDevices = await NetworkManager.getWifiDevices();
    const wifiAccessPoints = await NetworkManager.getWifiAccessPoints(wifiDevices[0]);
    let activeAccessPoint: string | null;
    try {
      activeAccessPoint = await NetworkManager.getActiveAccessPoint(wifiDevices[0]);
    } catch (error) {
      activeAccessPoint = null;
    }
    const apRequests: Array<Promise<WirelessNetwork>> = [];
    wifiAccessPoints.forEach((ap) => {
      apRequests.push(NetworkManager.getAccessPointDetails(ap, activeAccessPoint));
    });
    const responses = await Promise.all(apRequests);
    return responses;
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
    const valid = [
      // 'ap', //TODO: Implement ap mode
      'sta',
    ];
    if (enabled && !valid.includes(mode)) {
      console.error(`Wireless mode ${mode} not supported on this platform`);
      return false;
    }
    const wifiDevices = await NetworkManager.getWifiDevices();

    // If `enabled` set to false, disconnect wireless device
    if (enabled === false) {
      // Return false if no wifi device found
      if (!wifiDevices[0]) {
        return false;
      }
      try {
        await NetworkManager.disconnectNetworkDevice(wifiDevices[0]);
      } catch (error) {
        console.error(`Error whilst attempting to disconnect wireless device: ${error}`);
        return false;
      }
      return true;
    }

    // Otherwise connect to Wi-Fi access point using provided options
    if (!options.hasOwnProperty('ssid')) {
      console.log('Could not connect to wireless network because no SSID provided');
      return false;
    }
    const accessPoint = await NetworkManager.getAccessPointbySsid(options.ssid as string);
    if (accessPoint == null) {
      console.log('No network with specified SSID found');
      return false;
    }
    let secure = false;
    if (options.key) {
      secure = true;
    }
    try {
      NetworkManager.connectToWifiAccessPoint(
        wifiDevices[0],
        accessPoint,
        <string>options.ssid,
        secure,
        <string>options.key
      );
    } catch (error) {
      console.error(`Error connecting to Wi-Fi access point: ${error}`);
      return false;
    }
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
      console.error(`Error getting wireless country: ${error}`);
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
