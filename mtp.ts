

function getIsBrowser(): boolean {
  if (typeof navigator !== 'undefined') {
    const userAgent = navigator.userAgent.toLowerCase();
    return userAgent.indexOf(' electron/') === -1 && typeof window !== 'undefined';
  } else {
    // Node.js process
    return false;
  }
}

const isBrowser = getIsBrowser();
let usb: USB | null

interface MtpDevice extends USBDevice {
  usbconfig: {
    interface: USBInterface;
    outEPnum: number;
    inEPnum: number;
    outPacketSize: number;
    inPacketSize: number;
  };
}

const TYPE = [
  'undefined',
  'Command Block',
  'Data Block',
  'Response Block',
  'Event Block'
];

const CODE = {
  OPEN_SESSION: { value: 0x1002, name: 'OpenSession' },
  CLOSE_SESSION: { value: 0x1003, name: 'CloseSession' },
  GET_OBJECT_HANDLES: { value: 0x1007, name: 'GetObjectHandles'},
  GET_OBJECT: { value: 0x1009, name: 'GetObject'},
  OK: { value: 0x2001, name: 'OK'},
  INVALID_PARAMETER: { value: 0x201D, name: 'Invalid parameter'},
  INVALID_OBJECTPROP_FORMAT: { value: 0xA802, name: 'Invalid_ObjectProp_Format'},
  OBJECT_FILE_NAME: { value: 0xDC07, name: 'Object file name'},
  GET_OBJECT_PROP_VALUE: { value: 0x9803, name: 'GetObjectPropValue' },
};

interface MtpContainer {
  type : string,
  code : string,
      transactionID :number,
      payload: ArrayBuffer,
      parameters: number[],
}

export default class Mtp extends EventTarget {
  state: 'open' | 'closed';
  transactionID: number;
  device: MtpDevice;
  constructor(vendorId: number, productId: number, device: USBDevice | null = null) {
    super();
    const self = this;
    self.state = 'open';
    self.transactionID = 0;
    if (device)
      self.device = device as MtpDevice;

    (async () => {
      if (!isBrowser) {
        // For Node.js and Electron
        const { webusb } = await import('usb');
        usb = webusb;
      } else {
        usb = navigator.usb; // Yay, we're using WebUSB!
      }

      if (self.device == null) {
        let devices = await usb.getDevices();
        for (const device of devices) {
          if (device.productId === productId && device.vendorId === vendorId) {
            self.device = device as MtpDevice;
          }
        };
      }

      if (self.device == null) {
        self.device = await usb.requestDevice({
          filters: [
            {
              vendorId,
              productId,
            }
          ]
        }) as MtpDevice;
      }

      if (self.device != null) {
        if (self.device.opened) {
            console.log('Already open');
            await self.device.close();
        }
        await self.device.open();
        await self.device.selectConfiguration(1);

        if (self.device.configuration === undefined) {
          throw new Error('No configuration available.');
        }

        const iface = self.device.configuration.interfaces[0];
        await self.device.claimInterface(iface.interfaceNumber);

        const epOut = iface.alternate.endpoints.find((ep) => ep.direction === "out")!;
        const epIn  = iface.alternate.endpoints.find((ep) => ep.direction === "in")!;

        this.device.usbconfig = {
          interface: iface,
          outEPnum: epOut.endpointNumber,
          inEPnum : epIn.endpointNumber,
          outPacketSize: epOut.packetSize || 1024,
          inPacketSize : epIn.packetSize || 1024
        };

        self.dispatchEvent(new Event('ready'));
      } else {
        throw new Error('No device available.');
      }
    })().catch((error) => {
      console.log('Error during MTP setup:', error);
      self.dispatchEvent(new Event('error'));
    });
  }

  getName(list, idx) {
    for (let i in list) {
      if (list[i].value === idx) {
        return list[i].name;
      }
    }
    return 'unknown';
  };

  buildContainerPacket(container: { type: number, code: number, payload: number[] }) {
    // payload parameters are always 4 bytes in length
    let packetLength = 12 + (container.payload.length * 4);

    const buf = new ArrayBuffer(packetLength);
    const bytes = new DataView(buf);
    bytes.setUint32(0, packetLength, true);
    bytes.setUint16(4, container.type, true);
    bytes.setUint16(6, container.code, true);
    bytes.setUint32(8, this.transactionID, true);

    container.payload.forEach((element, index) => {
      bytes.setUint32(12 + (index * 4), element, true);
    });

    this.transactionID += 1;
    return buf;
  } 

  parseContainerPacket(bytes: DataView, length: number): MtpContainer {
    const fields = {
      type : TYPE[bytes.getUint16(4, true)],
      code : this.getName(CODE, bytes.getUint16(6, true)),
      transactionID : bytes.getUint32(8, true),
      payload: bytes.buffer.slice(12),
      parameters: [] as number[],
    };

    for (let i = 12; i < length; i += 4) {
      if (i <= length - 4) {
        fields.parameters.push(bytes.getUint32(i, true));
      }
    }
    return fields;
  }

  async read(): Promise<MtpContainer | USBInTransferResult> {
    try {
      let result = await this.device.transferIn(this.device.usbconfig.inEPnum, this.device.usbconfig.inPacketSize);

      if (result && result.data && result.data.byteLength && result.data.byteLength > 0) {
        let raw = new Uint8Array(result.data.buffer);
        const bytes = new DataView(result.data.buffer);
        const containerLength = bytes.getUint32(0, true);

        while (raw.byteLength !== containerLength) {
          result = await this.device.transferIn(this.device.usbconfig.inEPnum, this.device.usbconfig.inPacketSize);

          const uint8array = raw.slice();
          raw = new Uint8Array(uint8array.byteLength + result.data!.byteLength);
          raw.set(uint8array);
          raw.set(new Uint8Array(result.data!.buffer), uint8array.byteLength);
        }

        return this.parseContainerPacket(new DataView(raw.buffer), containerLength);
      }

     return result;
    } catch (error) {
      if (error.message.indexOf('LIBUSB_TRANSFER_NO_DEVICE')) {
        console.log('Device disconnected');
        throw error;
      } else {
        console.log('Error reading data:', error);
        throw error;
      }
    };
  }

  async readData(): Promise<MtpContainer | null>{
    let type: string | null = null;
    let result: MtpContainer | USBInTransferResult | null = null;

    while (type !== 'Data Block') {
      result = await this.read();

      if (result) {
        if (result.status === 'babble') {
          result = await this.read();
        } else if (result.code === CODE.INVALID_PARAMETER.name) {
          throw new Error('Invalid parameter');
        }
        type = 'type' in result ? result.type : null;
      } else {
        throw new Error('No data returned');
      }
    }

    return result as MtpContainer;
  }

  async write(buffer: BufferSource) {
    return await this.device.transferOut(this.device.usbconfig.outEPnum, buffer);
  }

  async close() {
    try {
      const closeSession = {
        type: 1, // command block
        code: CODE.CLOSE_SESSION.value,
        payload: [1], // session ID
      };
      await this.write(this.buildContainerPacket(closeSession));

      await this.device.releaseInterface(0);
      await this.device.close();
    } catch(err) {
      console.log('Error:', err);
    }
  }

  async openSession() {
    const openSession = {
      type: 1, // command block
      code: CODE.OPEN_SESSION.value,
      payload: [1], // session ID
    };
    let data = this.buildContainerPacket(openSession);
    let result = await this.write(data);
    console.log('Result:', result);
    console.log(await this.read());
  }

  async getObjectHandles(parent: number = 0xFFFFFFFF): Promise<number[]> {
    const getObjectHandles = {
      type: 1, // command block
      code: CODE.GET_OBJECT_HANDLES.value,
      payload: [0xFFFFFFFF, 0, 0xFFFFFFFF], // get all
    };
    await this.write(this.buildContainerPacket(getObjectHandles));
    const data = await this.readData();
    if (data === null) {
      throw new Error('No data returned');
    }

    data.parameters.shift(); // Remove length element
    return data.parameters;
  }

  async getFileName(objectHandle: number) {
    const getFilename = {
      type: 1,
      code: CODE.GET_OBJECT_PROP_VALUE.value,
      payload: [objectHandle, CODE.OBJECT_FILE_NAME.value], // objectHandle and objectPropCode
    };
    await this.write(this.buildContainerPacket(getFilename));
    const data = await this.readData();
    if (data === null) {
      throw new Error('No data returned');
    }

    const array = new Uint8Array(data.payload);
    const decoder = new TextDecoder('utf-16le');
    const filename = decoder.decode(array.subarray(1, array.byteLength - 2));
    return filename;
  }

  async getFile(objectHandle: number) {
    const getFile = {
      type: 1,
      code: CODE.GET_OBJECT.value,
      payload: [objectHandle],
    };
    await this.write(this.buildContainerPacket(getFile));
    const data = await this.readData();

    if (!data) {
      throw new Error('File not found');
    }

    return new Uint8Array(data.payload);
  }
}
