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

import { ImageNoteBody } from './ImageNoteBody';
import type { AttachmentRef } from '../../store/types';

const createAttachment = (overrides: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'img-1',
  hash: 'a'.repeat(64),
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 1024,
  relativePath: `attachments/${'a'.repeat(64)}.png`,
  createdAt: 1,
  ...overrides,
});

describe('ImageNoteBody', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resolveAttachmentPathMock.mockReset();
    convertFileSrcMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('主图在 isFocused=true 时点击后打开覆盖层，覆盖层通过 portal 挂载在 document.body', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" isFocused={true} />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    expect(trigger.className).toContain('rounded-xl');
    expect(trigger.className).toContain('overflow-hidden');
    expect(trigger.className).toContain('cursor-zoom-in');

    await act(async () => {
      trigger.click();
    });

    const overlayInContainer = container.querySelector('[data-testid="image-note-preview-overlay"]');
    expect(overlayInContainer).toBeNull();

    const overlayOnBody = document.body.querySelector('[data-testid="image-note-preview-overlay"]') as HTMLButtonElement | null;
    expect(overlayOnBody).not.toBeNull();
    expect(overlayOnBody?.className).toContain('fixed');
    expect(overlayOnBody?.className).toContain('inset-2');
    expect(overlayOnBody?.className).toContain('rounded-2xl');

    await act(async () => {
      overlayOnBody?.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });

  it('覆盖层预览图直接带有 border、rounded-xl 与 overflow 裁剪', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" isFocused={true} />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });

    const overlayOnBody = document.body.querySelector('[data-testid="image-note-preview-overlay"]') as HTMLButtonElement | null;
    expect(overlayOnBody).not.toBeNull();
    expect(overlayOnBody?.className).toContain('rounded-2xl');

    const previewImg = overlayOnBody?.querySelector('img') as HTMLImageElement | null;
    expect(previewImg).not.toBeNull();
    expect(previewImg?.className).toContain('rounded-xl');
    expect(previewImg?.className).toContain('border');
    expect(previewImg?.className).toContain('object-contain');

    await act(async () => {
      overlayOnBody?.click();
    });
  });

  it('isFocused=false 时点击主图不打开预览（默认行为）', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" isFocused={false} />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    expect(trigger.className).toContain('cursor-default');
    expect(trigger.className).not.toContain('cursor-zoom-in');

    await act(async () => {
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });

  it('Escape 键关闭已打开的预览', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" isFocused={true} />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });

  it('未传 isFocused 时默认不打开预览（便签未聚焦语义）', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    expect(trigger.className).toContain('cursor-default');

    await act(async () => {
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });

  it('同一次点击从未聚焦变为聚焦时不打开预览，下一次点击才打开', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" isFocused={false} />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    let trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" isFocused={true} />);
    });

    trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).not.toBeNull();
  });
});
