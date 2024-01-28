import Mtp from './mtp';
import * as fs from 'fs';

const mtp = new Mtp(0x091e, 0x4E9A);

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
  console.log('Ready');
  try {
  await mtp.openSession();
  console.log('Opened');
  const storageIds = await mtp.getStorageIDs();
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
  const xmlFile = garminfiles.find(file => file.filename.toLowerCase() === 'garmindevice.xml');
  if (!xmlFile) {
    throw new Error('Garmindevice.xml not found');
  }
  const data = await mtp.getFile(xmlFile.handle);
  fs.writeFileSync('garmindevice.xml', data);
  
} finally {
  await mtp.close();
  console.log('Closed');
}
});
