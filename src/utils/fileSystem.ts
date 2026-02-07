import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';

export const saveFile = async (content: string, defaultName: string) => {
  try {
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{
        name: 'JSON',
        extensions: ['json']
      }]
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
      filters: [{
        name: 'JSON',
        extensions: ['json']
      }]
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
