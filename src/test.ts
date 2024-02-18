import Mtp from "./mtp";
import * as fs from "fs";
import * as usb from "usb";

let devices = usb.getDeviceList();

const mtp = new Mtp(0x091e, devices[0].deviceDescriptor.idProduct);

mtp.addEventListener("error", (err) => console.log("Error", err));

async function getNameFilesInFolder(
  storageId: number,
  parent: number,
  mtp: Mtp,
) {
  const handles = await mtp.getObjectHandles(storageId, 0, parent);
  const result: { filename: string; handle: number }[] = [];
  for (const handle of handles) {
    const filename = await mtp.getFileName(handle);
    result.push({ filename, handle });
  }
  return result;
}

mtp.addEventListener("ready", async () => {
  try {
    console.log("Opened");
    await mtp.openSession();
    console.log("Session opened");
    const storageIds = await mtp.getStorageIDs();
    console.log("Storage IDs:", storageIds);
    const storageInfo = await mtp.getStorageInfo(storageIds[0]);
    console.log(
      "freeSpace:",
      storageInfo.freeSpaceInBytes,
      "maxCapacity:",
      storageInfo.maxCapacity,
    );
    const files = await getNameFilesInFolder(storageIds[0], -1, mtp);
    console.log("Files:", files);
    const garminFolder = files.find(
      (file) => file.filename.toLowerCase() === "garmin",
    );
    if (!garminFolder) {
      throw new Error("Garmin folder not found");
    }
    const garminfiles = await getNameFilesInFolder(
      storageIds[0],
      garminFolder.handle,
      mtp,
    );
    console.log("Garmin files:", garminfiles);
    console.log(await mtp.read());

    const filePath = "README.md";
    const fileBuffer = fs.readFileSync(filePath);

    const filename = `README.md`;
    const parentObjectHandle = garminFolder.handle;
    const storageId = storageIds[0];

    await mtp.uploadFile({
      parentObjectHandle,
      storageId,
      filename,
      fileBuffer,
    });
  } catch (err) {
    console.log(err);
  } finally {
    await mtp.close();
    console.log("Closed");
  }
});
