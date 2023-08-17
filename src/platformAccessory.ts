import { Service, PlatformAccessory } from "homebridge";
import { HomeBridgeLoqedPlatform } from "./platform";
import * as CryptoJS from "crypto-js";
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios").default;

export class LoqedPlatformAccessory {
  private service: Service;
  private batteryService: Service;
  private app;

  private lockStatus = 0; //0 is unlocked, 1 is locked
  private batteryLevel = 100;

  constructor(
    private readonly platform: HomeBridgeLoqedPlatform,
    private readonly accessory: PlatformAccessory
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Loqed")
      .setCharacteristic(this.platform.Characteristic.Model, "Touch")
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.platform.config.lockID
      );

    this.service =
      this.accessory.getService(this.platform.Service.LockMechanism) ||
      this.accessory.addService(this.platform.Service.LockMechanism);

    this.service
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.handleStatusLowBatteryGet.bind(this));

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name
    );

    // Handlers for the required characteristics
    this.service
      .getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.handleLockCurrentStateGet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(this.handleLockTargetStateGet.bind(this))
      .onSet(this.handleLockTargetStateSet.bind(this));

    this.batteryService =
      this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery);

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.handleStatusLowBatteryGet.bind(this));

    // Set initial battery to 0 by default
    this.batteryService
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .updateValue(0);

    // Setup webhooks for listening to updates from the lock
    this.app = express();

    this.app.use(bodyParser.json());
    this.app.set("trust-proxy", true);
    this.app.post("/webhook", (req, res) => {
      const bridgeIP = this.platform.config.bridgeIP;
      const reqIP = req.ip.replace("::ffff:", "");

      if (bridgeIP === reqIP) {
        // The request came from our bridge so we can continue
        const eventType = req.body.event_type;
        const batteryUpdate = req.body.battery_percentage;

        // If we have an event
        if (eventType) {
          switch (eventType) {
            case "STATE_CHANGED_NIGHT_LOCK":
            case "STATE_CHANGED_NIGHT_LOCK_REMOTE":
            case "GO_TO_STATE_MANUAL_LOCK_REMOTE_NIGHT_LOCK":
              // Door is Locked
              this.lockStatus = 1;
              this.handleLockTargetStateGet;
              break;
            case "STATE_CHANGED_LATCH":
            case "STATE_CHANGED_LATCH_REMOTE":
            case "STATE_CHANGED_OPEN":
            case "GO_TO_STATE_MANUAL_UNLOCK_REMOTE_OPEN":
              // Door is Unlocked
              this.lockStatus = 0;
              this.handleLockTargetStateGet;
              break;
          }
        }

        if (batteryUpdate) {
          this.batteryLevel = batteryUpdate;
          this.batteryService
            .getCharacteristic(this.platform.Characteristic.BatteryLevel)
            .updateValue(batteryUpdate);

          if (batteryUpdate <= 21) {
            this.handleStatusLowBatteryGet;
          }
        }
      }
      res.status(200).send("OK");
    });

    this.app.listen(4567, () => {
      console.log("Lock webhook receiver listening");
    });

    // Function to run on first homebridge load to update the device info
    this.updateLockInfo();
  }

  /**
   * REQUIRED - This must return an array of the services you want to expose.
   * This method must be named "getServices".
   */
  getServices() {
    return [this.platform.Service.LockMechanism, this.platform.Service.Battery];
  }

  /**
   * Handle requests to get the current value of the "Lock Current State" characteristic
   */
  // This can be UNSECURED, SECURED, JAMMED OR UNKNOWN
  handleLockCurrentStateGet() {
    this.platform.log.info("Triggered GET LockCurrentState");

    let currentValue = 0;

    switch (this.lockStatus) {
      case 0:
        // unlocked
        currentValue = this.platform.Characteristic.LockTargetState.UNSECURED;
        break;
      case 1:
        // locked
        currentValue = this.platform.Characteristic.LockTargetState.SECURED;
        break;
    }

    return currentValue;
  }

  /**
   * Handle requests to get the current value of the "Lock Target State" characteristic
   */
  handleLockTargetStateGet() {
    this.platform.log.info("Triggered GET LockTargetState");

    let currentValue = 0;

    switch (this.lockStatus) {
      case 0:
        // unlocked
        currentValue = this.platform.Characteristic.LockTargetState.UNSECURED;
        break;
      case 1:
        // locked
        currentValue = this.platform.Characteristic.LockTargetState.SECURED;
        break;
    }

    return currentValue;
  }

  /**
   * Handle requests to set the "Lock Target State" characteristic
   */
  handleLockTargetStateSet(value) {
    const secret = this.platform.config.key; //Secret
    const token = this.platform.config.token;
    const lockID = this.platform.config.lockID;
    const keyID = this.platform.config.localKeyID;
    const baseURL = "https://app.loqed.com/API/lock_command.php?api_token=";
    let base64command;
    this.lockStatus = value;

    if (value === 1) {
      // Lock
      this.platform.log.info("Trying to lock Loqed with ID", lockID);
      base64command = this.makeLoqedCommand(keyID, 7, 3, secret);
    } else {
      // Unlock
      this.platform.log.info("Trying to unlock Loqed with ID", lockID);
      base64command = this.makeLoqedCommand(keyID, 7, 1, secret);
    }

    if (base64command) {
      const finalURL =
        baseURL +
        encodeURIComponent(token) +
        "&lock_id=" +
        encodeURIComponent(lockID) +
        "&command_signed_base64=" +
        encodeURIComponent(base64command);

      axios
        .get(finalURL)
        .then(() => {
          this.platform.log.info("Triggered SET LockTargetState:", value);

          let currentValue = this.lockStatus;

          switch (this.lockStatus) {
            case 0:
              // unlocked
              currentValue =
                this.platform.Characteristic.LockTargetState.UNSECURED;
              break;
            case 1:
              // locked
              currentValue =
                this.platform.Characteristic.LockTargetState.SECURED;
              break;
          }

          this.service.setCharacteristic(
            this.platform.Characteristic.LockCurrentState,
            currentValue
          );
        })
        .catch((error) => {
          // handle error
          console.log(error);
        });
    }
  }

  /**
   * Make a request to get the lock info. This will only run on Homebridge launch so we dont get blocked
   */
  async updateLockInfo() {
    const token = this.platform.config.token;
    const lockID = this.platform.config.lockID;
    const finalURL =
      "https://app.loqed.com/API/lock_status.php?api_token=" +
      encodeURIComponent(token) +
      "&lock_id=" +
      encodeURIComponent(lockID);

    axios
      .get(finalURL)
      .then((response) => {
        this.batteryService
          .getCharacteristic(this.platform.Characteristic.BatteryLevel)
          .updateValue(response.data.battery_percentage);

        const resLockStatus = response.data.bolt_state_numeric;

        if (resLockStatus === 3) {
          // Locked
          this.platform.log.debug("Initial lock status is locked");
          this.lockStatus = 1;
          this.handleLockTargetStateGet;
        } else if (resLockStatus === 2 || resLockStatus === 1) {
          // Unlocked
          this.platform.log.debug("Initial lock status is unlocked");
          this.lockStatus = 0;
          this.handleLockTargetStateGet;
        }
      })
      .catch((error) => {
        // handle error
        console.log(error);
      });
  }

  /**
   * Handle requests to get the current value of the "Status Low Battery" characteristic
   */
  handleStatusLowBatteryGet() {
    this.platform.log.debug("Triggered GET StatusLowBattery");

    // set this to a valid value for StatusLowBattery
    let currentValue = 0;

    if (this.batteryLevel > 20) {
      currentValue =
        this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    } else {
      currentValue =
        this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    }

    return currentValue;
  }

  makeLoqedCommand(key_id, command_type, action, secret) {
    const getBin = (value) =>
      CryptoJS.enc.Utf8.parse(String.fromCharCode(value));

    const protocol = 2;
    const device_id = 1;

    const time = Math.floor(Date.now() / 1000);
    const secret_bin = CryptoJS.lib.WordArray.create(
      CryptoJS.enc.Base64.parse(secret).words.slice(0, 8)
    );
    const timenow_bin = CryptoJS.lib.WordArray.create([0, time]);
    const local_generated_binary_hash = getBin(protocol)
      .concat(getBin(command_type))
      .concat(timenow_bin)
      .concat(getBin(key_id))
      .concat(getBin(device_id))
      .concat(getBin(action));

    const encrypted_binary_hash = CryptoJS.HmacSHA256(
      local_generated_binary_hash,
      secret_bin
    );

    let command = null;
    switch (command_type) {
      case 7:
        command = getBin(protocol)
          .concat(getBin(command_type))
          .concat(timenow_bin)
          .concat(encrypted_binary_hash)
          .concat(getBin(key_id))
          .concat(getBin(device_id))
          .concat(getBin(action));
        break;
      case 89:
        command = getBin(protocol)
          .concat(getBin(command_type))
          .concat(getBin(action));
        break;
      default:
        console.error("Unknown command type");
    }

    if (!command) {
      // command == null or something else falsy
      return false;
    }

    return CryptoJS.enc.Base64.stringify(command);
  }
}
