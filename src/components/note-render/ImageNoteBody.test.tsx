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

  it('主图点击后打开覆盖层并保持圆角裁剪容器', async () => {
    const attachment = createAttachment();
    resolveAttachmentPathMock.mockResolvedValue('/abs/attachments/photo.png');

    await act(async () => {
      root.render(<ImageNoteBody attachment={attachment} alt="图片便签" />);
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    expect(trigger.className).toContain('rounded-xl');
    expect(trigger.className).toContain('overflow-hidden');

    await act(async () => {
      trigger.click();
    });

    const overlay = container.querySelector('[data-testid="image-note-preview-overlay"]') as HTMLButtonElement | null;
    expect(overlay).not.toBeNull();
    const frame = overlay?.querySelector('div');
    expect(frame?.className).toContain('overflow-hidden');
    expect(frame?.className).toContain('rounded-[1.25rem]');

    await act(async () => {
      overlay?.click();
    });

    expect(container.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });
});
