import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

const { resolveAttachmentPathMock, convertFileSrcMock } = vi.hoisted(() => ({
  resolveAttachmentPathMock: vi.fn(),
  convertFileSrcMock: vi.fn((p: string) => `asset://localhost/${p}`),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: convertFileSrcMock,
  invoke: vi.fn(async () => null),
}));

vi.mock('../../services/storage/attachmentPersistence', () => ({
  resolveAttachmentPath: resolveAttachmentPathMock,
}));

vi.mock('../store/db', () => ({
  db: {
    saveWAL: vi.fn(async () => undefined),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('../../utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
}));

import { NoteAttachments } from './NoteAttachments';
import { useStore } from '../../store/useStore';
import type { AttachmentRef } from '../../store/types';

const createAttachment = (overrides: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'att-1',
  hash: 'abc123',
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 1024,
  relativePath: 'attachments/abc123.png',
  createdAt: Date.now(),
  ...overrides,
});

const createNote = (id: string, attachments?: AttachmentRef[]) => ({
  id,
  boardId: 'default',
  x: 0,
  y: 0,
  title: '测试',
  content: '内容',
  color: '#FFFFFF',
  z: 1,
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  attachments,
});

describe('NoteAttachments', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    resolveAttachmentPathMock.mockReset();
    convertFileSrcMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('成功路径：调用 resolveAttachmentPath + convertFileSrc 并渲染 img', async () => {
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/abc123.png');
    convertFileSrcMock.mockReturnValue('asset://localhost/abs/attachments/abc123.png');

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[createAttachment()]}
        />,
      );
    });

    await vi.waitFor(() => {
      const img = container.querySelector('img') as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('asset://localhost/abs/attachments/abc123.png');
    });

    expect(resolveAttachmentPathMock).toHaveBeenCalledWith('attachments/abc123.png');
    expect(convertFileSrcMock).toHaveBeenCalledWith('/abs/attachments/abc123.png');
  });

  it('预览容器约束溢出，点击图片打开大图预览', async () => {
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/abc123.png');
    convertFileSrcMock.mockReturnValue('asset://localhost/abs/attachments/abc123.png');

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[createAttachment()]}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="attachment-preview-att-1"]')).not.toBeNull();
    });

    const attachmentsRoot = container.querySelector('[data-testid="note-attachments"]') as HTMLDivElement | null;
    expect(attachmentsRoot?.className).toContain('overflow-hidden');
    expect(attachmentsRoot?.className).toContain('max-w-full');

    await act(async () => {
      (container.querySelector('[data-testid="attachment-preview-att-1"]') as HTMLButtonElement).click();
    });

    const overlay = container.querySelector('[data-testid="attachment-preview-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/abs/attachments/abc123.png');
  });

  it('缺失路径：显示占位并提供重试按钮', async () => {
    resolveAttachmentPathMock.mockRejectedValue(new Error('文件不存在'));

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[createAttachment()]}
        />,
      );
    });

    await vi.waitFor(() => {
      const placeholder = container.querySelector('[aria-label="附件缺失"]');
      expect(placeholder).not.toBeNull();
    });

    const retryBtn = container.querySelector('[data-testid="attachment-retry-att-1"]') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
  });

  it('重试：点击重试按钮重新调用 resolveAttachmentPath + convertFileSrc', async () => {
    resolveAttachmentPathMock.mockRejectedValueOnce(new Error('首次失败'));
    resolveAttachmentPathMock.mockResolvedValueOnce('/abs/attachments/abc123.png');
    convertFileSrcMock.mockReturnValue('asset://localhost/abs/attachments/abc123.png');

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[createAttachment()]}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="附件缺失"]')).not.toBeNull();
    });

    const retryBtn = container.querySelector('[data-testid="attachment-retry-att-1"]') as HTMLButtonElement;

    await act(async () => {
      retryBtn.click();
    });

    await vi.waitFor(() => {
      const img = container.querySelector('img') as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('asset://localhost/abs/attachments/abc123.png');
    });

    expect(resolveAttachmentPathMock).toHaveBeenCalledTimes(2);
  });

  it('editable 模式：成功图片显示移除按钮，点击调用 removeAttachmentFromNote', async () => {
    const att = createAttachment();
    useStore.setState({
      notesById: { 'note-1': createNote('note-1', [att]) },
    });
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/abc123.png');
    convertFileSrcMock.mockReturnValue('asset://localhost/abs/attachments/abc123.png');

    const removeSpy = vi.spyOn(useStore.getState(), 'removeAttachmentFromNote');

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[att]}
          readOnly={false}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });

    const removeBtn = container.querySelector('[data-testid="attachment-remove-att-1"]') as HTMLButtonElement | null;
    expect(removeBtn).not.toBeNull();

    await act(async () => {
      removeBtn!.click();
    });

    expect(removeSpy).toHaveBeenCalledWith('note-1', 'att-1');
    removeSpy.mockRestore();
  });

  it('readOnly 模式：不显示移除按钮', async () => {
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/abc123.png');
    convertFileSrcMock.mockReturnValue('asset://localhost/abs/attachments/abc123.png');

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[createAttachment()]}
          readOnly={true}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });

    expect(container.querySelector('[data-testid="attachment-remove-att-1"]')).toBeNull();
  });

  it('readOnly 模式：缺失附件也不显示移除按钮', async () => {
    resolveAttachmentPathMock.mockRejectedValue(new Error('不存在'));

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[createAttachment()]}
          readOnly={true}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="附件缺失"]')).not.toBeNull();
    });

    expect(container.querySelector('[data-testid="attachment-remove-att-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="attachment-retry-att-1"]')).not.toBeNull();
  });

  it('SVG 附件不预览', async () => {
    const svgAtt = createAttachment({
      id: 'att-svg',
      mimeType: 'image/svg+xml',
      filename: 'icon.svg',
      relativePath: 'attachments/abc456.svg',
    });

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[svgAtt]}
        />,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="note-attachments"]')).toBeNull();
    expect(resolveAttachmentPathMock).not.toHaveBeenCalled();
  });

  it('混合类型：只预览可预览的图片，跳过 SVG 和非图片', async () => {
    const pngAtt = createAttachment({ id: 'att-png', mimeType: 'image/png' });
    const svgAtt = createAttachment({ id: 'att-svg', mimeType: 'image/svg+xml', relativePath: 'attachments/svg.svg' });
    const pdfAtt = createAttachment({ id: 'att-pdf', mimeType: 'application/pdf', relativePath: 'attachments/doc.pdf' });

    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/abc123.png');
    convertFileSrcMock.mockReturnValue('asset://localhost/abs/attachments/abc123.png');

    await act(async () => {
      root.render(
        <NoteAttachments
          noteId="note-1"
          attachments={[pngAtt, svgAtt, pdfAtt]}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
    });

    expect(resolveAttachmentPathMock).toHaveBeenCalledTimes(1);
    expect(resolveAttachmentPathMock).toHaveBeenCalledWith('attachments/abc123.png');
  });

  it('无附件时不渲染', async () => {
    await act(async () => {
      root.render(
        <NoteAttachments noteId="note-1" attachments={[]} />,
      );
    });

    expect(container.querySelector('[data-testid="note-attachments"]')).toBeNull();
  });

  it('只有非预览类型附件时不渲染', async () => {
    const pdfAtt = createAttachment({ id: 'att-pdf', mimeType: 'application/pdf' });

    await act(async () => {
      root.render(
        <NoteAttachments noteId="note-1" attachments={[pdfAtt]} />,
      );
    });

    expect(container.querySelector('[data-testid="note-attachments"]')).toBeNull();
  });

  it('多个附件独立渲染，单个失败不影响其他', async () => {
    const att1 = createAttachment({ id: 'att-1', relativePath: 'attachments/a.png' });
    const att2 = createAttachment({ id: 'att-2', relativePath: 'attachments/b.png' });

    resolveAttachmentPathMock.mockImplementation(async (path: string) => {
      if (path === 'attachments/a.png') return '/abs/a.png';
      throw new Error('缺失');
    });
    convertFileSrcMock.mockImplementation((p: string) => `asset://localhost/${p}`);

    await act(async () => {
      root.render(
        <NoteAttachments noteId="note-1" attachments={[att1, att2]} />,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull();
      expect(container.querySelector('[aria-label="附件缺失"]')).not.toBeNull();
    });

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('photo.png');
  });

  it('不含可预览类型附件时 resolveAttachmentPath 不被调用', async () => {
    const docAtt = createAttachment({ id: 'att-doc', mimeType: 'text/plain' });

    await act(async () => {
      root.render(
        <NoteAttachments noteId="note-1" attachments={[docAtt]} />,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(resolveAttachmentPathMock).not.toHaveBeenCalled();
  });
});
