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
import NetworkManager, { ConnectionSettings } from './utilities/network-manager';
import { LanMode, WirelessMode, NetworkAddresses, WirelessNetwork } from './types';



export class LinuxBalenaOSPlatform extends BasePlatform {

  // HTTP URL and API key for balenaOS supervisor API
  BALENA_SUPERVISOR_ADDRESS = process.env.BALENA_SUPERVISOR_ADDRESS
  BALENA_SUPERVISOR_API_KEY = process.env.BALENA_SUPERVISOR_API_KEY

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
      'ap',
      'sta'
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
   * Get the wireless mode and options.
   *
   * @returns {Promise<WirelessMode>} Promise which resolves with a WirelessMode object
   * {
   *   enabled: true|false,
   *   mode: 'ap'|'sta',
   *   options: {
   *     ssid: <ssid>
   *     networks: [<ssid>]
   *   }
   * }
   */
  async getWirelessModeAsync(): Promise<WirelessMode> {
    const result: WirelessMode = {
      enabled: false,
      mode: '',
      options: {},
    };
    let wifiDevicePath: string = '';
    // Get a list of Wi-Fi devices
    return NetworkManager.getWifiDevices()
      .then((wifiDevices) => {
        // Return the path of the first Wi-Fi device
        return wifiDevices[0];
        // TODO: Deal with case of no wireless devices
      }).then((devicePath) => {
        wifiDevicePath = devicePath;
        return NetworkManager.getDeviceState(wifiDevicePath);
      }).then((state) => {
        console.log(state);
        // Detect if the device is currently in an activated state
        // (either as an active access point or connected to an access point)
        if (state === 100) {
          result.enabled = true;
        }
        // Get object path of active connection associated with device
        return NetworkManager.getDeviceConnection(wifiDevicePath);``
      }).then((connectionPath) => {
        // TODO: Deal with case of no active connection
        return NetworkManager.getConnectionSettings(connectionPath);
      }).then((settings: ConnectionSettings) => {
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
        // wifi-setup.ts expects options.networks to be set to an array of SSIDs if connected to a Wi-Fi network
        // So if the Wi-Fi device is enabled and ssid is set then assume connected to that ssid
        if (result.enabled && result.options.ssid) {
          result.options.networks = [] as string[];
          (result.options.networks as string[]).push(result.options.ssid as string);
        }
        return result;
      }).catch((error) => {
        console.error(`Error getting wireless mode from Network Manager: ${error}`);
        return result;
      });
  }

  /**
   * Get the system's hostname.
   *
   * @returns {string} The hostname.
   */
  async getHostnameAsync(): Promise<string> {
    const url = `${this.BALENA_SUPERVISOR_ADDRESS}/v1/device/host-config?apikey=${this.BALENA_SUPERVISOR_API_KEY}`;
    const options = { method: 'GET' };
    return fetch(url, options).then(async (response) => {
      const hostConfig = await response.json();
      if (hostConfig && hostConfig.network && hostConfig.network.hostname) {
        return hostConfig.network.hostname;
      } else {
        return '';
      }
    }).catch((error) => {
      console.error(`Error retrieving hostname from balenaOS supervisor API: ${error}`);
      return '';
    });
  }

  /**
   * Get the MAC address of a network device.
   *
   * @param {string} device - The network device, e.g. wlan0
   * @returns {string|null} MAC address, or null on error
   * 
   * Note: This instance of the method currently always returns the MAC address
   * of the first Wi-Fi device, and does not use the device argument since these
   * descriptors are not useful when using the NetworkManager DBUS API.
   */
  async getMacAddressAsync(device: string): Promise<string|null> {
    // Get a list of Wi-Fi devices
    return NetworkManager.getWifiDevices()
      .then((wifiDevices) => {
        // Return the path of the first Wi-Fi device
        return wifiDevices[0];
        // TODO: Deal with case of no wireless devices
      }).then((wifiDevicePath) => {
        // Get MAC address of the device
        return NetworkManager.getDeviceMacAddress(wifiDevicePath);
      }).then((macAddress) => {
        return macAddress || null;
      }).catch((error) => {
        console.error(`Error getting MAC address for device ${device}: ${error}`);
        return null;
      });
  }

  /**
   * Set DHCP server status (of Wi-Fi device).
   * 
   * Note: When using NetworkManager this could be combined with 
   * setWirelessModeAsync, but it is kept separate for compatibility with 
   * other platforms like Raspbian where it is separate.
   * 
   * TODO: Consider combining this with setWirelessModeAsync and changing wifi-setup.ts
   *
   * @param {boolean} enabled - Whether or not to enable the DHCP server
   * @returns {boolean} Boolean indicating success of the command.
   */
  setDhcpServerStatusAsync(enabled: boolean): Promise<boolean> {
    let connectionPath: string;
    // Get a list of Wi-Fi devices
    return NetworkManager.getWifiDevices()
      .then((wifiDevices) => {
        // Return the path of the first Wi-Fi device
        return wifiDevices[0];
        // TODO: Deal with case of no wireless devices
      }).then((wifiDevicePath) => {
        return NetworkManager.getDeviceConnection(wifiDevicePath);
      }).then((path) => {
        connectionPath = path;
        // TODO: Deal with case of no active connection
        // Get current settings
        return NetworkManager.getConnectionSettings(connectionPath);
      }).then((settings: ConnectionSettings) => {
        // Keep all settings the same except for the IPv4 method
        if(!settings.ipv4) {
          return false;
        }
        // If enabling DHCP server set mode to 'shared'
        if (enabled == true) {
          settings.ipv4.method = 'shared';
        // If disabling DHCP server set mode to 'auto' to get a dynamic IP.
        } else {
          settings.ipv4.method = 'auto';
        }
        return NetworkManager.setConnectionSettings(connectionPath, settings);
      }).then((success) => {
        return success;
      }).catch((error) => {
        console.error(`Error setting DHCP server status via Network Manager: ${error}`);
        return false;
      });
  }

  /**
   * Get DHCP server status (of Wi-Fi device).
   *
   * @returns {boolean} Boolean indicating whether or not a DHCP server is running.
   * 
   * Note: Using NetworkManager this method could potentially be combined with getWirelessModeAsync,
   * but it is currently kept separate for backwards compatibility with other platforms like Raspbian.
   */
  async getDhcpServerStatusAsync(): Promise<boolean> {
    // Get a list of Wi-Fi devices
    return NetworkManager.getWifiDevices()
      .then((wifiDevices) => {
        // Return the path of the first Wi-Fi device
        return wifiDevices[0];
        // TODO: Deal with case of no wireless devices
      }).then((wifiDevicePath) => {
        return NetworkManager.getDeviceConnection(wifiDevicePath);
      }).then((connectionPath) => {
        // TODO: Deal with case of no active connection
        return NetworkManager.getConnectionSettings(connectionPath);
      }).then((settings: ConnectionSettings) => {
        // shared mode means NetworkManager should have enabled a DHCP server
        if (settings.ipv4 && settings.ipv4.method == 'shared') {
          return true;
        } else {
          return false;
        }
      }).catch((error) => {
        console.error(`Error getting DHCP server status from Network Manager: ${error}`);
        return false;
      });
  }
}

export default new LinuxBalenaOSPlatform();
