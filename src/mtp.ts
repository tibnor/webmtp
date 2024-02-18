function getIsBrowser(): boolean {
  if (typeof navigator !== "undefined") {
    const userAgent = navigator.userAgent.toLowerCase();
    return (
      userAgent.indexOf(" electron/") === -1 && typeof window !== "undefined"
    );
  } else {
    // Node.js process
    return false;
  }
}

const isBrowser = getIsBrowser();
let usb: USB | null;

interface MtpDevice extends USBDevice {
  usbconfig: {
    interface: USBInterface;
    outEPnum: number;
    inEPnum: number;
    outPacketSize: number;
    inPacketSize: number;
  };
}

interface Container {
  type: number;
  code: number;
  payload: number[];
}

interface DataContainer {
  type: number;
  code: number;
  data: ArrayBuffer;
  payload: number[];
  transactionID: number;
}

const TYPE = [
  "undefined",
  "Command Block",
  "Data Block",
  "Response Block",
  "Event Block",
];

function parseString(
  data: DataView,
  offset: number,
): { text: string | null; newOffset: number } {
  const nCharacters = data.getUint8(offset);
  if (nCharacters === 0) {
    return { text: null, newOffset: offset + 1 };
  }
  const length = nCharacters * 2;
  const start = offset + 1;
  const decoder = new TextDecoder("utf-16le");
  const array = new Uint8Array(data.buffer, start, length - 2); // Remove null terminator
  return { text: decoder.decode(array), newOffset: start + length };
}

function stringToUtf16le(str: string): ArrayBuffer {
  // Allocate a buffer for the string's UTF-16LE representation
  const buffer = new ArrayBuffer(str.length * 2); // 2 bytes per character
  const view = new DataView(buffer);

  // Write the string character by character
  for (let i = 0; i < str.length; i++) {
    // UTF-16LE encoding: little-endian
    view.setUint16(i * 2, str.charCodeAt(i), true); // true for little-endian
  }

  return buffer;
}

const DATE_LENGTH = 15;
const DATE_BYTE_LENGTH = 1 + DATE_LENGTH * 2 + 2;

function encodeDate(date: Date, offset: number, data: DataView): number {
  const str = date
    .toISOString()
    .replace(/-/g, "")
    .replace(/:/g, "")
    .substring(0, DATE_LENGTH);
  return encodeString(str, offset, data);
}

/**
 * Add the string to the data view,
 * Start at offset and return the new offset
 *
 * First added byte is the length of the string
 * Then the string is added as utf-16le (2 bytes per character)
 * A null terminator is added
 */
function encodeString(str: string, offset: number, data: DataView): number {
  if (str.length > 255) {
    throw new Error("String too long");
  }

  if (str.length === 0) {
    data.setUint8(offset, 0);
    return offset + 1;
  }

  const array = stringToUtf16le(str + "\0");
  if (array.byteLength !== (str.length + 1) * 2) {
    throw new Error("String length mismatch");
  }
  data.setUint8(offset, array.byteLength / 2); // Length in characters
  offset += 1;
  // Copy the string to the data view
  const view = new Uint8Array(array);
  const dataView = new Uint8Array(data.buffer);
  dataView.set(view, offset);
  offset += array.byteLength;
  return offset;
}

const CODE = {
  GET_DEVICE_INFO: { value: 0x1001, name: "GetDeviceInfo" },
  OPEN_SESSION: { value: 0x1002, name: "OpenSession" },
  CLOSE_SESSION: { value: 0x1003, name: "CloseSession" },
  GET_STORAGE_IDS: { value: 0x1004, name: "GetStorageIDs" },
  GET_STORAGE_INFO: { value: 0x1005, name: "GetStorageInfo" },
  GET_OBJECT_HANDLES: { value: 0x1007, name: "GetObjectHandles" },
  GET_OBJECT: { value: 0x1009, name: "GetObject" },
  OK: { value: 0x2001, name: "OK" },
  GENERAL_ERROR: { value: 0x2002, name: "General Error" },
  SESSION_NOT_OPEN: { value: 0x2003, name: "Session Not Open" },
  INVALID_TRANSACTION_ID: { value: 0x2004, name: "Invalid TransactionID" },
  OPERATION_NOT_SUPPORTED: { value: 0x2005, name: "Operation Not Supported" },
  PARAMETER_NOT_SUPPORTED: { value: 0x2006, name: "Parameter Not Supported" },
  INCOMPLETE_TRANSFER: { value: 0x2007, name: "Incomplete Transfer" },
  INVALID_STORAGE_ID: { value: 0x2008, name: "Invalid StorageID" },
  INVALID_OBJECT_HANDLE: { value: 0x2009, name: "Invalid ObjectHandle" },
  DEVICE_PROP_NOT_SUPPORTED: {
    value: 0x200a,
    name: "DeviceProp Not Supported",
  },
  INVALID_OBJECT_FORMAT_CODE: {
    value: 0x200b,
    name: "Invalid ObjectFormatCode",
  },
  STORE_FULL: { value: 0x200c, name: "Store Full" },
  OBJECT_WRITE_PROTECTED: { value: 0x200d, name: "Object Write-Protected" },
  STORE_READ_ONLY: { value: 0x200e, name: "Store Read-Only" },
  ACCESS_DENIED: { value: 0x200f, name: "Access Denied" },
  NO_THUMBNAIL_PRESENT: { value: 0x2010, name: "No Thumbnail Present" },
  SELF_TEST_FAILED: { value: 0x2011, name: "Self Test Failed" },
  PARTIAL_DELETION: { value: 0x2012, name: "Partial Deletion" },
  STORE_NOT_AVAILABLE: { value: 0x2013, name: "Store Not Available" },
  SPECIFICATION_BY_FORMAT_UNSUPPORTED: {
    value: 0x2014,
    name: "Specification By Format Unsupported",
  },
  INVALID_PARAMETER: { value: 0x201d, name: "Invalid parameter" },
  INVALID_OBJECTPROP_FORMAT: {
    value: 0xa802,
    name: "Invalid_ObjectProp_Format",
  },
  OBJECT_FILE_NAME: { value: 0xdc07, name: "Object file name" },
  GET_OBJECT_PROP_VALUE: { value: 0x9803, name: "GetObjectPropValue" },
};

interface MtpContainer {
  type: string;
  code: string;
  transactionID: number;
  payload: ArrayBuffer;
  parameters: number[];
}

export default class Mtp extends EventTarget {
  state: "open" | "closed";
  transactionID: number;
  device: MtpDevice;
  constructor(
    vendorId: number,
    productId: number,
    device: USBDevice | null = null,
  ) {
    super();
    const self = this;
    self.state = "open";
    self.transactionID = 0;
    if (device) self.device = device as MtpDevice;

    (async () => {
      if (!isBrowser) {
        // For Node.js and Electron
        const { webusb } = await import("usb");
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
        }
      }

      if (self.device == null) {
        self.device = (await usb.requestDevice({
          filters: [
            {
              vendorId,
              productId,
            },
          ],
        })) as MtpDevice;
      }

      if (self.device != null) {
        if (self.device.opened) {
          console.log("Already open");
          await self.device.close();
        }
        await self.device.open();
        await self.device.selectConfiguration(1);

        if (self.device.configuration === undefined) {
          throw new Error("No configuration available.");
        }

        const iface = self.device.configuration.interfaces[0];
        await self.device.claimInterface(iface.interfaceNumber);

        const epOut = iface.alternate.endpoints.find(
          (ep) => ep.direction === "out",
        )!;
        const epIn = iface.alternate.endpoints.find(
          (ep) => ep.direction === "in",
        )!;

        this.device.usbconfig = {
          interface: iface,
          outEPnum: epOut.endpointNumber,
          inEPnum: epIn.endpointNumber,
          outPacketSize: epOut.packetSize || 1024,
          inPacketSize: epIn.packetSize || 1024,
        };

        self.dispatchEvent(new Event("ready"));
      } else {
        throw new Error("No device available.");
      }
    })().catch((error) => {
      console.log("Error during MTP setup:", error);
      self.dispatchEvent(new Event("error"));
    });
  }

  getName(list, idx) {
    for (let i in list) {
      if (list[i].value === idx) {
        return list[i].name;
      }
    }
    return "unknown";
  }

  buildContainerPacket(container: Container) {
    // payload parameters are always 4 bytes in length
    let packetLength = 12 + 4 * container.payload.length;

    let buf = new ArrayBuffer(packetLength);
    const bytes = new DataView(buf);
    bytes.setUint32(0, packetLength, true);
    bytes.setUint16(4, container.type, true);
    bytes.setUint16(6, container.code, true);
    bytes.setUint32(8, this.transactionID, true);

    container.payload.forEach((element, index) => {
      bytes.setUint32(12 + index * 4, element, true);
    });

    this.transactionID += 1;
    return buf;
  }

  buildDataContainerPacket(
    container: DataContainer,
    writeData: boolean = false,
  ) {
    // payload parameters are always 4 bytes in length
    let buf = new ArrayBuffer(
      12 +
        4 * container.payload.length +
        (writeData ? container.data.byteLength : 0),
    );
    const bytes = new DataView(buf);
    bytes.setUint32(0, 12 + container.data.byteLength, true);
    bytes.setUint16(4, container.type, true);
    bytes.setUint16(6, container.code, true);
    bytes.setUint32(8, container.transactionID, true);

    container.payload.forEach((element, index) => {
      bytes.setUint32(12 + index * 4, element, true);
    });

    if (writeData) {
      const dataView = new Uint8Array(container.data);
      const data = new Uint8Array(buf);
      data.set(dataView, 12);
    }

    return buf;
  }

  parseContainerPacket(bytes: DataView, length: number): MtpContainer {
    const fields = {
      type: TYPE[bytes.getUint16(4, true)],
      code: this.getName(CODE, bytes.getUint16(6, true)),
      transactionID: bytes.getUint32(8, true),
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
      let result = await this.device.transferIn(
        this.device.usbconfig.inEPnum,
        this.device.usbconfig.inPacketSize,
      );

      if (
        result &&
        result.data &&
        result.data.byteLength &&
        result.data.byteLength > 0
      ) {
        let raw = new Uint8Array(result.data.buffer);
        const bytes = new DataView(result.data.buffer);
        const containerLength = bytes.getUint32(0, true);

        while (raw.byteLength !== containerLength) {
          result = await this.device.transferIn(
            this.device.usbconfig.inEPnum,
            this.device.usbconfig.inPacketSize,
          );

          const uint8array = raw.slice();
          raw = new Uint8Array(uint8array.byteLength + result.data!.byteLength);
          raw.set(uint8array);
          raw.set(new Uint8Array(result.data!.buffer), uint8array.byteLength);
        }

        return this.parseContainerPacket(
          new DataView(raw.buffer),
          containerLength,
        );
      }

      return result;
    } catch (error) {
      if (error.message.indexOf("LIBUSB_TRANSFER_NO_DEVICE")) {
        console.log("Device disconnected");
        throw error;
      } else {
        console.log("Error reading data:", error);
        throw error;
      }
    }
  }

  async readData(): Promise<MtpContainer | null> {
    let type: string | null = null;
    let result: MtpContainer | USBInTransferResult | null = null;

    while (type !== "Data Block") {
      result = await this.read();

      if (result) {
        // @ts-ignore
        if (result.status === "babble") {
          result = await this.read();
          // @ts-ignore
        } else if (result.code === CODE.INVALID_PARAMETER.name) {
          throw new Error("Invalid parameter");
        }
        type = "type" in result ? result.type : null;
      } else {
        throw new Error("No data returned");
      }
    }

    return result as MtpContainer;
  }

  async write(buffer: BufferSource) {
    return await this.device.transferOut(
      this.device.usbconfig.outEPnum,
      buffer,
    );
  }

  async writeLong(buffer: BufferSource) {
    const maxPacketSize = this.device.usbconfig.outPacketSize;
    const length = buffer.byteLength;
    let offset = 0;
    while (offset < length) {
      const end = Math.min(offset + maxPacketSize, length);
      const data = (buffer as Uint8Array).slice(offset, end);
      const res = await this.device.transferOut(
        this.device.usbconfig.outEPnum,
        data,
      );
      if (res.status !== "ok") {
        console.error("Error writing data:", res);
        throw new Error("Error writing data");
      }
      offset += maxPacketSize;
    }
    return;
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
    } catch (err) {
      console.log("Error:", err);
    }
  }

  async openSession() {
    const openSession = {
      type: 1, // command block
      code: CODE.OPEN_SESSION.value,
      payload: [1], // session ID
    };
    let data = this.buildContainerPacket(openSession);
    await this.write(data);
    this.read();
  }

  async getStorageIDs() {
    const getStorageIDs = {
      type: 1, // command block
      code: 0x1004,
      payload: [],
    };
    const res = await this.write(this.buildContainerPacket(getStorageIDs));
    const data = await this.readData();
    if (data === null) {
      throw new Error("No data returned");
    }

    data.parameters.shift(); // Remove length element
    return data.parameters;
  }

  /**
   *
   * @param storageId use 0xFFFFFFFF for all storage
   * @param format use 0 for all formats
   * @param parent Parent object handler use 0xFFFFFFFF object root and 0x00000000 for all objects on device
   * @returns
   */
  async getObjectHandles(
    storageId: number,
    format: number,
    parent: number,
  ): Promise<number[]> {
    const getObjectHandles = {
      type: 1, // command block
      code: CODE.GET_OBJECT_HANDLES.value,
      payload: [storageId, format, parent],
    };
    await this.write(this.buildContainerPacket(getObjectHandles));
    const data = await this.readData();
    if (data === null) {
      throw new Error("No data returned");
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
      throw new Error("No data returned");
    }

    const array = new Uint8Array(data.payload);
    const decoder = new TextDecoder("utf-16le");
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
      throw new Error("File not found");
    }

    return new Uint8Array(data.payload);
  }

  async getStorageInfo(storageId: number) {
    const getStorageInfo = {
      type: 1,
      code: CODE.GET_STORAGE_INFO.value,
      payload: [storageId],
    };

    await this.write(this.buildContainerPacket(getStorageInfo));
    const response = await this.readData();

    if (!response) {
      throw new Error("File not found");
    }

    const data = new DataView(response.payload);
    let offset = 0;
    const storageType = data.getUint16(offset, true);
    offset += 2;
    const filesystemType = data.getUint16(offset, true);
    offset += 2;
    const accessCapability = data.getUint16(offset, true);
    offset += 2;
    const maxCapacity = data.getBigUint64(offset, true);
    offset += 8;
    const freeSpaceInBytes = data.getBigUint64(offset, true);
    offset += 8;
    const freeSpaceInObjects = data.getUint32(offset, true);
    offset += 4;
    let res = parseString(data, offset);
    const storageDescription = res.text;
    offset = res.newOffset;
    const volumeIdentifier = parseString(data, offset).text;
    return {
      storageType,
      filesystemType,
      accessCapability,
      maxCapacity,
      freeSpaceInBytes,
      freeSpaceInObjects,
      storageDescription,
      volumeIdentifier,
    };
  }

  async deleteObject(objectHandle: number) {
    const deleteObject = {
      type: 1,
      code: 0x100b,
      payload: [objectHandle],
    };

    await this.write(this.buildContainerPacket(deleteObject));
    const response = await this.readData();

    if (!response) {
      throw new Error("File not found");
    }
    return response;
  }

  async createFolder(
    parentObjectHandle: number,
    folderName: string,
    storageId: number,
  ) {
    const res = await this.sendObjectInfo({
      parentObjectHandle,
      storageId,
      filename: folderName,
      objectFormat: 0x3001,
      objectSize: 0,
      associationType: 0x0001,
      associationDesc: 0,
      keywords: "test",
    });
    return res;
  }

  async uploadFile({
    parentObjectHandle,
    storageId,
    filename,
    fileBuffer,
  }: {
    parentObjectHandle: number;
    storageId: number;
    filename: string;
    fileBuffer: ArrayBuffer;
  }) {
    const fileSize = fileBuffer.byteLength;
    await this.sendObjectInfo({
      filename: filename,
      objectSize: fileSize,
      parentObjectHandle: parentObjectHandle,
      storageId: storageId,
      associationType: 0,
      associationDesc: 0,
      objectFormat: 0x3000,
      keywords: "",
    });
    // make a buffer of the file

    await this.sendObject(fileBuffer);
    await this.read();
  }

  async sendObjectInfo(info: {
    parentObjectHandle: number;
    storageId: number;
    filename: string;
    objectFormat: number;
    objectSize: number;
    associationType: number;
    associationDesc: number;
    keywords: string;
  }) {
    const staticLength =
      4 + 2 + 2 + 4 + 14 + 12 + 4 + 4 + 2 + 4 + DATE_BYTE_LENGTH * 1 + 1;
    const filenameLength = 1 + info.filename.length * 2 + 2;
    const keywordLength =
      info.keywords.length > 0 ? 1 + info.keywords.length * 2 + 2 : 1;

    const data = new Uint8Array(staticLength + filenameLength + keywordLength);
    const bytes = new DataView(data.buffer);
    let offset = 0;
    bytes.setUint32(offset, info.storageId, true);
    offset += 4;
    bytes.setUint16(offset, info.objectFormat, true);
    offset += 2;
    bytes.setUint16(offset, 0x0000, true);
    offset += 2;
    bytes.setUint32(offset, info.objectSize, true);
    offset += 4;
    // Skip thumb info and picture info
    offset += 14 + 12;
    bytes.setUint32(offset, info.parentObjectHandle, true);
    offset += 4;
    bytes.setUint16(offset, info.associationType, true);
    offset += 2;
    bytes.setUint32(offset, info.associationDesc, true);
    offset += 4;
    offset += 4; // Skip sequence number
    offset = encodeString(info.filename, offset, bytes);
    offset = encodeString("", offset, bytes);
    offset = encodeDate(new Date(2000, 0, 1, 20, 11, 30), offset, bytes);
    offset = encodeString(info.keywords, offset, bytes);

    if (offset !== data.byteLength) {
      throw new Error("Data length mismatch");
    }

    const sendObjectPropList = {
      type: 1,
      code: 0x100c,
      payload: [info.storageId, info.parentObjectHandle],
      transactionID: this.transactionID,
    };

    let status = await this.write(
      this.buildContainerPacket(sendObjectPropList),
    );
    const sendObjectData = {
      type: 2,
      code: sendObjectPropList.code,
      data,
      transactionID: sendObjectPropList.transactionID,
      payload: [],
    };
    status = await this.write(this.buildDataContainerPacket(sendObjectData));
    await this.writeLong(data);

    return { status };
  }

  async sendObject(data: ArrayBuffer) {
    const sendObject = {
      type: 1,
      code: 0x100d,
      payload: [],
    };

    await this.write(this.buildContainerPacket(sendObject));

    const sendObjectData = {
      type: 2,
      code: 0x100d,
      data,
      transactionID: this.transactionID,
      payload: [],
    };
    this.transactionID += 1;

    await this.write(this.buildDataContainerPacket(sendObjectData));

    await this.writeLong(data);
    const response = await this.read();

    if (!response) {
      throw new Error("File not found");
    }
    return response;
  }
}
