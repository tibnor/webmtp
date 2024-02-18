interface Container {
  type: number, code: number, payload: number[]
}

interface DataContainer {
  type: number, code: number, data: ArrayBuffer, transactionID: number
}

const TYPE = [
  'undefined',
  'Command Block',
  'Data Block',
  'Response Block',
  'Event Block'
];

const objInfoStr = `0100 0100
0130 0000 0010 0000 0000 0000 0000 0000
0000 0000 0000 0000 0000 0000 0000 0000
0000 0000 0000 0000 0000 0000 0000 0000
064d 0075 0073 0069 0063 0000 0000 1032
0030 0030 0030 0030 0031 0030 0031 0054
0031 0039 0031 0031 0033 0030 0000 0000`;

const objInfo = objInfoStr.split('\n').flatMap(line => line.split(' ').flatMap(v => [v.substring(0,2), v.substring(2,4)]).map(hex => parseInt(hex, 16)));

function parseString(data: DataView, offset: number): { text: string | null, newOffset: number } {
  const nCharacters = data.getUint8(offset);
  if (nCharacters === 0) {
    return { text: null, newOffset: offset + 1 };
  }
  const length = nCharacters * 2;
  const start = offset + 1;
  const decoder = new TextDecoder('utf-16le');
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

  return buffer
}

const DATE_LENGTH = 15;
const DATE_BYTE_LENGTH = 1 + DATE_LENGTH * 2 + 2;

function encodeDate(date: Date, offset: number, data: DataView): number {
  const str = (date.toISOString().replace(/-/g, '').replace(/:/g, '').substring(0, DATE_LENGTH));
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
    throw new Error('String too long');
  }

  if (str.length === 0) {
    data.setUint8(offset, 0);
    return offset + 1;
  }

  const array = stringToUtf16le(str + '\0')
  if (array.byteLength !== (str.length + 1) * 2) {
    throw new Error('String length mismatch');
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

function sendObjectInfo(info: { parentObjectHandle: number, storageId: number, filename: string, objectFormat: number, objectSize: number, associationType: number, associationDesc: number, keywords: string }) {
  const staticLength = 4 + 2 + 2 + 4 + 14 + 12 + 4 + 4 + 2 + 4 + DATE_BYTE_LENGTH * 1 + 1;
  const filenameLength = 1 + info.filename.length * 2 + 2;
  const keywordLength = info.keywords.length > 0 ? 1 + info.keywords.length * 2 + 2 : 1;

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
  offset = encodeDate(new Date(2000,0,1,20,11,30), offset, bytes);
  offset = encodeString(info.keywords, offset, bytes);

  if (offset !== data.byteLength) {
    throw new Error('Data length mismatch');
  }

  const sendObjectPropList = {
    type: 1,
    code: 0x100C,
    payload: [info.storageId, info.parentObjectHandle],
    data,
    transactionID: 10,
  };

  return sendObjectPropList;

}

const info = sendObjectInfo({
  storageId: 0x10001,
  parentObjectHandle: 0,
  filename: 'Music',
  objectFormat: 0x3001,
  objectSize: 0x1000,
  associationType: 0,
  associationDesc: 0,
  keywords: ""
})

console.log(info);
const out = new Uint8Array(info.data)

// compare out and objInfo
for (let i = 0; i < out.length; i++) {
    // print as hex
    const o = out[i];
    const ohex = o.toString(16);
    const ochar = String.fromCharCode(o);
    const e = objInfo[i];
    if (e === undefined) {
      console.log(i, "o:", ohex, ":e", "undefined", ochar);
    }
    else {
      const ehex = e.toString(16);
      // convert to utf-8
      const echar = String.fromCharCode(e);
      console.log(i, "o:", ohex, ehex, ":e", ochar, echar);
    }
}

// compare out and objInfo
for (let i = 0; i < out.length; i++) {
  if (out[i] !== objInfo[i]) {
    // print as hex
    if (objInfo[i] === undefined) {
      console.log(i, "DIFF out:", out[i].toString(16), "expected: undefined");
    }
    else {
      console.log(i, "DIFF out:", out[i].toString(16), "expected:", objInfo[i].toString(16));
    }
  }
}