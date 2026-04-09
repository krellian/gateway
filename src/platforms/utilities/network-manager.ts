import DBus from 'dbus';
import { WirelessNetwork } from '../types';

export interface ConnectionSettings {
  connection: {
    id: string;
    uuid?: string;
    type: string;
  };
  ipv4?: {
    method: string;
    addresses?: Array<Array<number>>;
    'address-data'?: Array<AddressData>;
    gateway?: string;
  };
  '802-11-wireless'?: {
    ssid: Array<number>;
    mode?: string;
  };
  '802-11-wireless-security'?: {
    'key-mgmt'?: string;
    psk?: string;
  };
}

export interface AddressData {
  address?: string;
  prefix: number;
}

/**
 * Network Manager.
 *
 * Manages networking devices over DBus.
 */
class NetworkManager {
  // Reference to the DBus system bus once connected
  private systemBus: DBus.DBusConnection | null = null;

  /**
   * Connect to the system bus.
   */
  start(): void {
    // There can only be one system bus instance open at a time.
    if (!this.systemBus) {
      this.systemBus = DBus.getBus('system');
    }
  }

  /**
   * Disconnect from the system bus.
   */
  stop(): void {
    if (this.systemBus) {
      this.systemBus.disconnect();
    }
  }

  /**
   * Get a list of network adapters from the system network manager.
   *
   * @returns {Promise<string[]>} An array of DBus object paths.
   */
  getDevices(): Promise<string[]> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        function (error, iface) {
          if (error) {
            console.error(`Error accessing the NetworkManager DBus interface: ${error}`);
            reject();
            return;
          }
          iface.GetAllDevices(function (error: Error, result: string[]) {
            if (error) {
              console.error(`Error calling GetAllDevices on NetworkManager DBus: ${error}`);
              reject();
              return;
            }
            resolve(result);
          });
        }
      );
    });
  }

  /**
   * Get the device type for a given network adapter.
   *
   * @param {string} path Object path for device.
   * @returns {Promise<number>} Resolves with a device type
   *  (1 is Ethernet, 2 is Wi-Fi...).
   */
  getDeviceType(path: string): Promise<number> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.getProperty('DeviceType', function (error, value) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(+value);
          });
        }
      );
    });
  }

  /**
   * Get the current state of a device.
   *
   * @param {string} path Object path for device.
   * @returns {Promise<number>} The current state (100 means activated)
   * Full list of states at:
   * https://networkmanager.dev/docs/api/latest/nm-dbus-types.html#NMDeviceState
   */
  getDeviceState(path: string): Promise<number> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        (error, iface) => {
          if (error) {
            console.error(error);
            reject();
          }
          iface.getProperty('State', (error, state: number) => {
            if (error) {
              console.error(error);
              reject();
            }
            resolve(state);
          });
        }
      );
    });
  }

  /**
   * Get the kernel interface name for a given network device.
   *
   * @param {string} path Object path for device.
   * @returns {Promise<string>} Resolves with the interface name (e.g. 'wlan0', 'wlo1').
   */
  getDeviceInterface(path: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.getProperty('Interface', function (error, value) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(value);
          });
        }
      );
    });
  }

  /**
   * Get a list of Ethernet network adapters from the system network manager.
   *
   * @returns {Promise<string[]>} A promise which resolves with an array
   *  of DBus object paths.
   */
  async getEthernetDevices(): Promise<string[]> {
    // Get a list of all network adapter devices
    const devices = await this.getDevices();
    const ethernetDevices: string[] = [];
    // Filter by type
    for (const device of devices) {
      const type = await this.getDeviceType(device);
      if (type == 1) {
        ethernetDevices.push(device);
      }
    }
    return ethernetDevices;
  }

  /**
   * Get a list of Wi-Fi network adapters from the system network manager.
   *
   * @returns {Promise<string[]} A promise which resolves with an array
   *  of DBus object paths.
   */
  async getWifiDevices(): Promise<string[]> {
    // Get a list of all network adapter devices
    const devices = await this.getDevices();
    const wifiDevices: string[] = [];
    // Filter by type
    for (const device of devices) {
      const type = await this.getDeviceType(device);
      if (type == 2) {
        wifiDevices.push(device);
      }
    }
    return wifiDevices;
  }

  /**
   * Get the active connection associated with a device.
   *
   * @param {string} path Object path for device.
   * @returns {Promise<string>} Resolves with object path of the active
   *  connection object associated with this device, or empty string if no
   *  active connection exists.
   */
  getDeviceConnection(path: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        (error, iface) => {
          if (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Error getting Device interface: ${errorMsg}`);
            reject();
            return;
          }
          iface.getProperty('ActiveConnection', (error, activeConnectionPath) => {
            if (error) {
              // No active connection is a valid state, not necessarily an error
              console.log('Device has no active connection');
              resolve('');
              return;
            }
            // Handle case where activeConnectionPath is invalid or not a real path
            if (!activeConnectionPath || activeConnectionPath === '/') {
              console.log('Device has no active connection (invalid path)');
              resolve('');
              return;
            }
            this.systemBus!.getInterface(
              'org.freedesktop.NetworkManager',
              activeConnectionPath,
              'org.freedesktop.NetworkManager.Connection.Active',
              (error, iface) => {
                if (error) {
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  console.error(`Error getting ActiveConnection interface: ${errorMsg}`);
                  resolve('');
                  return;
                }
                iface.getProperty('Connection', function (error, value) {
                  if (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    console.error(`Error getting Connection property: ${errorMsg}`);
                    resolve('');
                    return;
                  }
                  resolve(value);
                });
              }
            );
          });
        }
      );
    });
  }

  /**
   * Get the settings for a given connection.
   *
   * @param {string} path Object path for a connection settings profile.
   * @returns {Promise<ConnectionSettings>} Resolves with the settings of a connection.
   */
  getConnectionSettings(path: string): Promise<ConnectionSettings> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Settings.Connection',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.GetSettings(function (error: Error, value: ConnectionSettings) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(value);
          });
        }
      );
    });
  }

  /**
   * Update connection settings.
   *
   * Note that this persists the connection object, but a connection needs to be
   * reactivated in order for it to take effect.
   *
   * @param {string} path DBus object path of the Connection Settings object to update.
   * @param {ConnectionSettings} settings A connection settings object.
   * @returns {Promise<boolean>} A Promise that resolves with true on success or
   *  rejects with an Error on failure.
   */
  setConnectionSettings(path: string, settings: ConnectionSettings): Promise<boolean> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Settings.Connection',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.Update(settings, function (error: Error) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(true);
          });
        }
      );
    });
  }

  /**
   * Add and activate a new network connection.
   *
   * @param {ConnectionSettings} settings The connection settings to apply.
   * @param {string} device The DBus object path of the device to apply settings to.
   * @returns {Promise<boolean>} A Promise which resolves with true on success
   *  or rejects on failure.
   */
  addAndActivateConnection(settings: ConnectionSettings, device: string): Promise<boolean> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        (error, iface) => {
          if (error) {
            reject(error);
            return;
          }
          iface.AddAndActivateConnection(settings, device, '/', function (error: Error) {
            if (error) {
              reject(error);
              return;
            }
            resolve(true);
          });
        }
      );
    });
  }

  /**
   * Activate a network connection.
   *
   * @param {string} connection The DBus object path of the connection settings to apply.
   * @param {string} device The DBus object path of the device to apply settings to.
   * @returns {Promise<boolean>} A Promise which resolves with true on success
   *  or rejects on failure.
   */
  activateConnection(connection: string, device: string): Promise<boolean> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.ActivateConnection(connection, device, '/', function (error: Error) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(true);
          });
        }
      );
    });
  }

  /**
   * Get an IPv4 configuration for a given device path.
   *
   * @param {String} path Object path for a device.
   * @returns {Promise<Array<AddressData>>} Promise resolves with IP4Config object.
   */
  getDeviceIp4Config(path: string): Promise<Array<AddressData>> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        (error, iface) => {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.getProperty('Ip4Config', (error, ip4ConfigPath) => {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            this.systemBus!.getInterface(
              'org.freedesktop.NetworkManager',
              ip4ConfigPath,
              'org.freedesktop.NetworkManager.IP4Config',
              (error, iface) => {
                if (error) {
                  console.error(error);
                  reject();
                  return;
                }
                // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/71006
                // eslint-disable-next-line  @typescript-eslint/no-explicit-any
                iface.getProperty('AddressData', function (error, value: any) {
                  if (error) {
                    console.error(error);
                    reject();
                    return;
                  }
                  resolve(value);
                });
              }
            );
          });
        }
      );
    });
  }

  /**
   * Get the SSID of the Wi-Fi access point with a given DBUS object path.
   *
   * @param {string} path DBUS object path of the Wi-Fi access point.
   * @returns {Promise<string>} The SSID of the access point.
   */
  getAccessPointSsid(path: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.AccessPoint',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/71006
          // eslint-disable-next-line  @typescript-eslint/no-explicit-any
          iface.getProperty('Ssid', function (error, value: any) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            // Convert SSID from byte array to string.
            const ssid = String.fromCharCode(...value);
            resolve(ssid);
          });
        }
      );
    });
  }

  /**
   * Get the signal strength of the Wi-Fi access point with a given DBUS object path.
   *
   * @param {string} path DBUS object path of the Wi-Fi access point.
   * @returns {Promise<number>} The strength of the signal as a percentage.
   */
  getAccessPointStrength(path: string): Promise<number> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.AccessPoint',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/71006
          // eslint-disable-next-line  @typescript-eslint/no-explicit-any
          iface.getProperty('Strength', function (error, value: any) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(value);
          });
        }
      );
    });
  }

  /**
   * Gets the encryption status of the Wi-Fi access point with a given DBUS object path.
   *
   * @param {string} path DBUS object path of the Wi-Fi access point.
   * @returns {Promise<boolean>} true if encrypted, false if not.
   */
  async getAccessPointSecurity(path: string): Promise<boolean> {
    this.start();
    const wpaFlagRequest = new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.AccessPoint',
        (error, iface) => {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/71006
          // eslint-disable-next-line  @typescript-eslint/no-explicit-any
          iface.getProperty('WpaFlags', function (error, value: any) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(value);
          });
        }
      );
    });
    const wpa2FlagRequest = new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.AccessPoint',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/71006
          // eslint-disable-next-line  @typescript-eslint/no-explicit-any
          iface.getProperty('RsnFlags', function (error, value: any) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(value);
          });
        }
      );
    });
    // Request WPA and WPA2 flags for access point.
    const requests = [];
    requests.push(wpaFlagRequest);
    requests.push(wpa2FlagRequest);
    const responses = await Promise.all(requests);
    if (responses[0] == 0 && responses[1] == 0) {
      return false;
    } else {
      return true;
    }
  }

  /**
   * Get details about an access point reachable from a wireless device.
   *
   * @param {string} path The DBUS path of an access point.
   * @param {string|null} activeAccessPoint: The DBUS path of the active access point, if any.
   * @returns {Promise<WirelessNetwork>} A Promise which resolves with a wireless network
   *   object of the form:
   * {
   *   ssid: '...',
   *   quality: <number>,
   *   encryption: true|false,
   *   configured: true|false,
   *   connected: true| false
   * }
   * @throws {Error} Error if not able to get all access point details.
   */
  async getAccessPointDetails(
    path: string,
    activeAccessPoint: string | null
  ): Promise<WirelessNetwork> {
    let ssid: string;
    let strength: number;
    let security: boolean;
    let connected: boolean;
    if (path === activeAccessPoint) {
      connected = true;
    } else {
      connected = false;
    }
    try {
      ssid = await this.getAccessPointSsid(path);
      strength = await this.getAccessPointStrength(path);
      security = await this.getAccessPointSecurity(path);
    } catch (error) {
      console.error(error);
      throw new Error('Failed to get access point details');
    }
    const response = {
      ssid: ssid,
      quality: strength,
      encryption: security,
      configured: connected, // Currently assumes only configured if connected
      connected: connected,
    };
    // Resolve with access point details
    return response;
  }

  /**
   * Get the active Access Point a given Wi-Fi adapter is connected to.
   *
   * @param {String} path DBUS Object path for a Wi-Fi device.
   * @returns {Promise<string>} Promise resolves with the DBUS object path of an access point.
   */
  getActiveAccessPoint(path: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device.Wireless',
        (error, iface) => {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.getProperty('ActiveAccessPoint', (error, accessPointPath) => {
            if (error) {
              console.log('Unable to detect a connected Wi-Fi access point');
              reject();
              return;
            }
            resolve(accessPointPath);
          });
        }
      );
    });
  }

  /**
   * Get the active connection object path for a device.
   *
   * Unlike getDeviceConnection which returns the connection settings path,
   * this returns the active connection path needed for DeactivateConnection.
   *
   * @param {string} path Object path for the device.
   * @returns {Promise<string>} The active connection object path, or empty string if none.
   */
  getDeviceActiveConnectionPath(path: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        (error, iface) => {
          if (error) {
            reject(error);
            return;
          }
          iface.getProperty('ActiveConnection', (error, activeConnectionPath) => {
            if (error || !activeConnectionPath || activeConnectionPath === '/') {
              resolve('');
              return;
            }
            resolve(activeConnectionPath);
          });
        }
      );
    });
  }

  /**
   * Deactivate an active connection.
   *
   * This tears down the specified connection without disabling the device,
   * leaving it free to establish a new connection.
   *
   * @param {string} activeConnectionPath The DBus object path of the active connection.
   * @returns {Promise<void>} Resolves on success.
   */
  deactivateConnection(activeConnectionPath: string): Promise<void> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        (error, iface) => {
          if (error) {
            reject(error);
            return;
          }
          iface.DeactivateConnection(activeConnectionPath, function (error: Error) {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }
      );
    });
  }

  /**
   * Request the wireless device to scan for access points.
   *
   * @param {string} path The DBUS object path of a wireless device.
   * @returns {Promise<void>} Resolves when the scan request has been submitted.
   */
  requestScan(path: string): Promise<void> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device.Wireless',
        function (error, iface) {
          if (error) {
            console.error(`Error getting wireless device interface for scan: ${error}`);
            reject(error);
            return;
          }
          iface.RequestScan({}, function (error: Error) {
            if (error) {
              console.error(`Error requesting Wi-Fi scan: ${error}`);
              reject(error);
              return;
            }
            resolve();
          });
        }
      );
    });
  }

  /**
   * Request a Wi-Fi scan and wait for it to complete.
   *
   * Listens for the PropertiesChanged signal on the
   * org.freedesktop.DBus.Properties interface to detect when the LastScan
   * property on org.freedesktop.NetworkManager.Device.Wireless changes,
   * with a fallback timeout.
   *
   * @param {string} path The DBUS object path of a wireless device.
   * @param {number} timeoutMs Maximum time to wait in milliseconds (default 10000).
   * @returns {Promise<void>} Resolves when the scan completes or the timeout is reached.
   */
  waitForScanComplete(path: string, timeoutMs = 10000): Promise<void> {
    this.start();
    return new Promise((resolve) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.DBus.Properties',
        (error, propsIface) => {
          if (error) {
            // Can't listen for signals; fall back to fixed timeout after scan
            console.log('Could not get Properties interface, using fallback timeout on Wi-Fi scan');
            this.requestScan(path)
              .then(() => new Promise<void>((r) => setTimeout(r, timeoutMs)))
              .then(resolve, resolve);
            return;
          }

          let settled = false;
          const done = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            propsIface.removeListener('PropertiesChanged', onPropertiesChanged);
            resolve();
          };

          const onPropertiesChanged = (
            interfaceName: string,
            changedProperties: Record<string, unknown>
          ): void => {
            if (
              interfaceName === 'org.freedesktop.NetworkManager.Device.Wireless' &&
              changedProperties &&
              'LastScan' in changedProperties
            ) {
              console.log('Wi-Fi scan completed.');
              done();
            }
          };

          propsIface.on('PropertiesChanged', onPropertiesChanged);

          // Fallback timeout in case the signal is never emitted
          const timer = setTimeout(() => {
            console.log('Timed out waiting for Wi-Fi scan to complete, using available results');
            done();
          }, timeoutMs);

          // Request the scan after registering the listener
          this.requestScan(path).catch(() => {
            // RequestScan may fail (e.g. in AP mode); let the timeout or
            // a previously cached signal resolve.
            done();
          });
        }
      );
    });
  }

  /**
   * Get a list of access points for the wireless device at the given path.
   *
   * @param {String} path The DBUS object path of a wireless device.
   * @returns {Promise<string[]>} An array of DBus object paths of Access Points.
   */
  getWifiAccessPoints(path: string): Promise<string[]> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device.Wireless',
        function (error, iface) {
          if (error) {
            console.error(`Error getting a wireless device via NetworkManager: ${error}`);
            reject();
            return;
          }
          // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/71006
          // eslint-disable-next-line  @typescript-eslint/no-explicit-any
          iface.getProperty('AccessPoints', function (error: Error | null, result: any) {
            if (error) {
              console.error(`Error getting AccessPoints from a wireless device: ${error}`);
              reject();
              return;
            }
            resolve(result);
          });
        }
      );
    });
  }

  /**
   * Get an access point DBUS object bath for a given SSID.
   *
   * @param {string} ssid The SSID of the network to search for.
   * @returns {Promise<string|null> } A Promise which resolves with the DBUS object
   *   path of the access point, or null if not found;
   */
  async getAccessPointbySsid(ssid: string): Promise<string | null> {
    const wifiDevices = await this.getWifiDevices();
    const wifiAccessPoints = await this.getWifiAccessPoints(wifiDevices[0]);
    // Return the first access point that has a matching SSID
    // TODO: Deal with duplicates
    for (const accessPoint of wifiAccessPoints) {
      const accessPointSsid = await this.getAccessPointSsid(accessPoint);
      if (accessPointSsid == ssid) {
        return accessPoint;
      }
    }
    return null;
  }

  /**
   * Connect to Wi-Fi access point.
   *
   * @param {string} wifiDevice DBUS object path of wireless device to use.
   * @param {string} accessPoint DBUS object path of access point to connec to (e.g. 1)
   * @param {string} ssid SSID of access point to connect to.
   * @param {boolean} secure Whether or not authentication is provided.
   * @param {string} password provided by user.
   * @returns {Promise<void>} Resolves on success, rejects with an Error on failure.
   */
  connectToWifiAccessPoint(
    wifiDevice: string,
    accessPoint: string,
    ssid: string,
    secure: boolean,
    password: string
  ): Promise<void> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager',
        'org.freedesktop.NetworkManager',
        (error, iface) => {
          if (error) {
            reject(error);
            return;
          }

          // Convert SSID to an array of bytes
          const ssidBytes = [];
          for (let i = 0; i < ssid.length; ++i) {
            ssidBytes.push(ssid.charCodeAt(i));
          }

          // Assemble connection information
          const connectionInfo: ConnectionSettings = {
            '802-11-wireless': {
              ssid: ssidBytes,
            },
            connection: {
              id: ssid,
              type: '802-11-wireless',
            },
          };

          if (secure) {
            connectionInfo['802-11-wireless-security'] = {
              'key-mgmt': 'wpa-psk',
              psk: password,
            };
          }

          // TODO: Should we re-use an existing connection rather than add a new one
          // if one already exists?
          // TODO: Call addAndActivateConnection method now instead?
          iface.AddAndActivateConnection(
            connectionInfo,
            wifiDevice,
            accessPoint,
            function (error: Error) {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            }
          );
        }
      );
    });
  }

  /**
   * Disconnect a network device.
   *
   * @param {string} path DBUS object path of device.
   * @returns {Promise<void>} A promise which resolves upon successful
   *   deactivation or rejects with an Error on failure.
   */
  disconnectNetworkDevice(path: string): Promise<void> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        (error, iface) => {
          if (error) {
            reject(error);
            return;
          }
          iface.Disconnect(function (error: Error) {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }
      );
    });
  }

  /**
   * Get the the current MAC address of a device by its object path.
   *
   * Note the MAC address may be randomised and may not be the permanent hardware address.
   *
   * @param {String} path DBUS Object path for a device.
   * @returns {Promise<string>} Promise resolves with the current MAC address of the device.
   */
  getDeviceMacAddress(path: string): Promise<string> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        path,
        'org.freedesktop.NetworkManager.Device',
        (error, iface) => {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.getProperty('HwAddress', (error, macAddress) => {
            if (error) {
              console.log('Unable to retrieve MAC address for device');
              reject();
              return;
            }
            resolve(macAddress);
          });
        }
      );
    });
  }

  /**
   * Get the NTP synchronisation status.
   *
   * Checks whether the system clock has been synchronised with an NTP server.
   *
   * Note: This is not directly related to NetworkManager, but it was easier
   * to add it here because there can only be one connection to the system bus
   * open at any one time.
   *
   * @returns {Promise<boolean>} Boolean true if synchronised, otherwise false.
   */
  getNTPSynchronized(): Promise<boolean> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.timedate1',
        '/org/freedesktop/timedate1',
        'org.freedesktop.timedate1',
        function (error, iface) {
          if (error) {
            console.error(error);
            reject();
            return;
          }
          iface.getProperty('NTPSynchronized', function (error, value) {
            if (error) {
              console.error(error);
              reject();
              return;
            }
            resolve(value);
          });
        }
      );
    });
  }

  /**
   * List all saved connection profiles.
   *
   * @returns {Promise<string[]>} An array of DBus object paths for connection profiles.
   */
  listConnections(): Promise<string[]> {
    this.start();
    return new Promise((resolve, reject) => {
      this.systemBus!.getInterface(
        'org.freedesktop.NetworkManager',
        '/org/freedesktop/NetworkManager/Settings',
        'org.freedesktop.NetworkManager.Settings',
        function (error, iface) {
          if (error) {
            console.error(`Error accessing NetworkManager Settings interface: ${error}`);
            reject();
            return;
          }
          iface.ListConnections(function (error: Error, result: string[]) {
            if (error) {
              console.error(`Error listing connections: ${error}`);
              reject();
              return;
            }
            resolve(result);
          });
        }
      );
    });
  }
}

export default new NetworkManager();
