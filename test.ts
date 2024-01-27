import Mtp from './mtp';

const mtp = new Mtp(0x091e, 0x4E9A);

mtp.addEventListener('error', err => console.log('Error', err));

mtp.addEventListener('ready', async () => {
  console.log('Ready');
  try {
  await mtp.openSession();
  //await mtp.getObjectHandles(0xFFFFFFFF);
  console.log('Opened');
  const handles = await mtp.getObjectHandles(0xFFFFFFFF); 

  console.log('Handles:', handles);
  const searchFor = "Garmin".toLowerCase();

  for (let i = 0; i < handles.length; i++) {
    const objectHandle = handles[i];
    const fileName = await mtp.getFileName(objectHandle);
    console.log(`Filename: "${fileName}" Handle: ${objectHandle} Handle hex: 0x${objectHandle.toString(16)}`);
    if (fileName.toLowerCase() === searchFor) {
      break;
    }
  }
} finally {

  //const array = await mtp.getFile(objectHandle, fileName);
  //fs.writeFileSync(fileName, array);
  console.log('Closing');
  await mtp.close();
  console.log('Closed');
}
});
