export type SmartPasteKind = 'empty' | 'single' | 'url' | 'lines' | 'paragraphs';

export type SmartPasteOptionId = 'keep' | 'split-lines' | 'split-paragraphs';

export interface SmartPasteOption {
  id: SmartPasteOptionId;
  label: string;
  contents: string[];
}

export interface SmartPasteResult {
  kind: SmartPasteKind;
  source: string;
  options: SmartPasteOption[];
}

export interface SmartPasteNoteInput {
  x: number;
  y: number;
  content: string;
}

const NOTE_OFFSET_X = 32;
const NOTE_OFFSET_Y = 28;

const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n').trim();

const isPlainUrl = (text: string) => {
  if (/\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const splitParagraphs = (text: string) => text
  .split(/\n\s*\n+/)
  .map((part) => part.trim())
  .filter(Boolean);

const splitLines = (text: string) => text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

export const parseSmartPaste = (text: string): SmartPasteResult => {
  const source = normalizeText(text);

  if (!source) {
    return { kind: 'empty', source, options: [] };
  }

  const keepOption: SmartPasteOption = {
    id: 'keep',
    label: '保留为一张',
    contents: [source],
  };

  if (isPlainUrl(source)) {
    return { kind: 'url', source, options: [keepOption] };
  }

  const paragraphs = splitParagraphs(source);
  if (paragraphs.length > 1) {
    return {
      kind: 'paragraphs',
      source,
      options: [
        keepOption,
        { id: 'split-paragraphs', label: '按段拆分', contents: paragraphs },
      ],
    };
  }

  const lines = splitLines(source);
  if (lines.length > 1) {
    return {
      kind: 'lines',
      source,
      options: [
        keepOption,
        { id: 'split-lines', label: '按行拆分', contents: lines },
      ],
    };
  }

  return { kind: 'single', source, options: [keepOption] };
};

export const getDefaultSmartPasteOption = (result: SmartPasteResult): SmartPasteOption | null => {
  if (result.kind === 'paragraphs') {
    return result.options.find((option) => option.id === 'split-paragraphs') ?? result.options[0] ?? null;
  }

  if (result.kind === 'lines') {
    return result.options.find((option) => option.id === 'split-lines') ?? result.options[0] ?? null;
  }

  return result.options[0] ?? null;
};

export const buildSmartPasteNoteInputs = (
  contents: string[],
  originX: number,
  originY: number,
): SmartPasteNoteInput[] => contents.map((content, index) => ({
  content,
  x: originX + index * NOTE_OFFSET_X,
  y: originY + index * NOTE_OFFSET_Y,
}));

export const createSmartPasteNoteInputs = (text: string, originX: number, originY: number): SmartPasteNoteInput[] => {
  const result = parseSmartPaste(text);
  const option = getDefaultSmartPasteOption(result);
  return option ? buildSmartPasteNoteInputs(option.contents, originX, originY) : [];
};
