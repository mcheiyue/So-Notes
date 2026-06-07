import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';

const JSON_FILTER = { name: 'JSON', extensions: ['json'] };
const ZIP_FILTER = { name: 'ZIP', extensions: ['zip'] };

export const saveFile = async (content: string, defaultName: string) => {
  try {
    const filePath = await save({
      defaultPath: defaultName,
      filters: [JSON_FILTER]
    });

    if (filePath) {
      await writeTextFile(filePath, content);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to save file:', err);
    return false;
  }
};

export const openFile = async (): Promise<string | null> => {
  try {
    const filePath = await open({
      multiple: false,
      filters: [JSON_FILTER]
    });

    if (filePath && typeof filePath === 'string') {
      return await readTextFile(filePath);
    }
    return null;
  } catch (err) {
    console.error('Failed to open file:', err);
    return null;
  }
};

export const saveZipDialog = async (defaultName: string): Promise<string | null> => {
  try {
    const filePath = await save({
      defaultPath: defaultName,
      filters: [ZIP_FILTER],
    });
    return filePath ?? null;
  } catch (err) {
    console.error('Failed to open save zip dialog:', err);
    return null;
  }
};

export const openZipDialog = async (): Promise<string | null> => {
  try {
    const filePath = await open({
      multiple: false,
      filters: [ZIP_FILTER],
    });
    if (filePath && typeof filePath === 'string') {
      return filePath;
    }
    return null;
  } catch (err) {
    console.error('Failed to open zip dialog:', err);
    return null;
  }
};
