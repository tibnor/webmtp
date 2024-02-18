import { buffer } from 'stream/consumers';
import Mtp from './mtp';
import * as fs from 'fs';
import * as usb from 'usb';

let devices = usb.getDeviceList();

const mtp = new Mtp(0x091e, devices[0].deviceDescriptor.idProduct);

mtp.addEventListener('error', err => console.log('Error', err));

async function getNameFilesInFolder(storageId: number, parent: number, mtp: Mtp) {
  const handles = await mtp.getObjectHandles(storageId, 0, parent); 
  const result: {filename: string, handle: number}[] = []
  for (const handle of handles) {
    const filename = await mtp.getFileName(handle);
    result.push({ filename, handle });
  }
  return result
}

mtp.addEventListener('ready', async () => {
  try {
    
  console.log('Opened');
  await mtp.openSession();
  console.log('Session opened');
  const storageIds = await mtp.getStorageIDs();
  console.log('Storage IDs:', storageIds);
  const storageInfo = await mtp.getStorageInfo(storageIds[0]);
  console.log('freeSpace:', storageInfo.freeSpaceInBytes, 'maxCapacity:',storageInfo.maxCapacity);
  console.log('Storage info:', storageInfo);
  console.log('Storage IDs:', storageIds);
  const files = await getNameFilesInFolder(storageIds[0], -1, mtp);
  console.log('Files:', files);
  const garminFolder = files.find(file => file.filename.toLowerCase() === 'garmin');
  if (!garminFolder) {
    throw new Error('Garmin folder not found');
  }
  const garminfiles = await getNameFilesInFolder(storageIds[0], garminFolder.handle, mtp);
  console.log('Garmin files:', garminfiles);
  console.log(await mtp.read());

  //onst filePath = 'test.md';
  //const readmeFile = garminfiles.find(file => file.filename.toLowerCase().endsWith(filePath.toLowerCase()));
  //if (readmeFile) {
  //  await mtp.deleteObject(readmeFile.handle);
  //}

	// 500 + 512 triggers the null read case on both sides.
	const testSize = 500 + 512
  const randomId = Math.floor(Math.random() * 1000000);
	const filename = `mtp-doodle-test${randomId}.txt`
  //const fileSize = fs.statSync(filePath).size;

  console.log('Sending file:', filename, 'size:', testSize, "transaction Id", mtp.transactionID);
  const res = await mtp.sendObjectInfo({
    filename: filename,
    objectSize: testSize,
    parentObjectHandle: garminFolder.handle,
    storageId: storageIds[0],
    associationType: 0,
    associationDesc: 0,
    objectFormat: 0x3000,
    keywords: "test"
  });
  console.log('Send object info result:', res);

  // make a buffer of the file
  const fileBuffer = Buffer.alloc(testSize);
  for (let i = 0; i < testSize; i++) {
    fileBuffer.writeUInt8(i % 256, i);
  }

  //const fileBuffer = fs.readFileSync(filePath);
  console.log('File buffer:', fileBuffer.length);
  // send the file
  const res2=  await mtp.sendObject(fileBuffer);
  console.log('Send object result:', res2, res.transactionID);
  console.log(await mtp.read());

  /*const garminfiles2 = await getNameFilesInFolder(storageIds[0], garminFolder.handle, mtp);
  console.log('Garmin files:', garminfiles2);
  */
  
}catch(err){
  console.log(err);
} finally {
  await mtp.close();
  console.log('Closed');
}
});
