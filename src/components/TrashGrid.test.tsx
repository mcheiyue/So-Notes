import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async () => null),
}));

vi.mock('../store/db', () => ({
    db: {
        saveWAL: vi.fn(async () => undefined),
        loadWAL: vi.fn(async () => undefined),
        clearWAL: vi.fn(async () => undefined),
    },
}));

vi.mock('../utils/fileSystem', () => ({
    saveFile: vi.fn(async () => true),
    openFile: vi.fn(async () => null),
}));

vi.mock('./NoteCard', () => ({
    NoteCard: ({ id }: { id: string }) => <div data-testid={`note-card-${id}`} />,
}));

import { TrashGrid } from './TrashGrid';
import { useStore } from '../store/useStore';
import { normalizeNotes } from '../store/normalization';
import { Note } from '../store/types';

const setInputValue = (input: HTMLInputElement, value: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

const createDeletedNote = (overrides: Partial<Note> = {}): Note => ({
    id: 'note-1',
    boardId: 'default',
    x: 100,
    y: 100,
    title: '会议纪要',
    content: '讨论了项目进度和分工',
    color: '#FFFFFF',
    z: 1,
    collapsed: false,
    createdAt: 1,
    updatedAt: 2,
    deletedAt: 1000,
    ...overrides,
});

describe('TrashGrid 废纸篓搜索', () => {
    let container: HTMLDivElement;
    let root: Root;

    const renderTrashGrid = async () => {
        await act(async () => {
            root.render(<TrashGrid />);
        });
    };

    beforeEach(() => {
        useStore.setState(useStore.getInitialState(), true);

        const notes = [
            createDeletedNote({ id: 'note-1', title: '会议纪要', content: '讨论了项目进度和分工', deletedAt: 3000 }),
            createDeletedNote({ id: 'note-2', title: '购物清单', content: '牛奶、面包、鸡蛋', deletedAt: 2000 }),
            createDeletedNote({ id: 'note-3', title: '读书笔记', content: '红楼梦第三回读后感', deletedAt: 1000 }),
        ];
        useStore.setState({
            ...normalizeNotes(notes),
            boards: [{ id: 'default', name: '主看板', icon: '📌', createdAt: 1 }],
        });

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

    it('空输入显示全部已删除便签', async () => {
        await renderTrashGrid();

        expect(container.querySelector('[data-testid="note-card-note-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-2"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-3"]')).not.toBeNull();
    });

    it('标题命中时过滤显示匹配便签', async () => {
        await renderTrashGrid();

        const input = container.querySelector('input[aria-label="在废纸篓中搜索"]') as HTMLInputElement;
        expect(input).not.toBeNull();

        await act(async () => {
            setInputValue(input, '会议');
        });

        expect(container.querySelector('[data-testid="note-card-note-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-2"]')).toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-3"]')).toBeNull();
    });

    it('正文命中时过滤显示匹配便签', async () => {
        await renderTrashGrid();

        const input = container.querySelector('input[aria-label="在废纸篓中搜索"]') as HTMLInputElement;

        await act(async () => {
            setInputValue(input, '牛奶');
        });

        expect(container.querySelector('[data-testid="note-card-note-1"]')).toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-2"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-3"]')).toBeNull();
    });

    it('大小写不敏感匹配', async () => {
        await renderTrashGrid();

        const input = container.querySelector('input[aria-label="在废纸篓中搜索"]') as HTMLInputElement;

        await act(async () => {
            setInputValue(input, '红楼梦');
        });

        expect(container.querySelector('[data-testid="note-card-note-1"]')).toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-2"]')).toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-3"]')).not.toBeNull();
    });

    it('清空搜索后恢复显示全部便签', async () => {
        await renderTrashGrid();

        const input = container.querySelector('input[aria-label="在废纸篓中搜索"]') as HTMLInputElement;

        await act(async () => {
            setInputValue(input, '会议');
        });

        expect(container.querySelector('[data-testid="note-card-note-2"]')).toBeNull();

        const clearButton = container.querySelector('button[aria-label="清除搜索"]') as HTMLButtonElement;
        expect(clearButton).not.toBeNull();

        await act(async () => {
            clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });

        expect(container.querySelector('[data-testid="note-card-note-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-2"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="note-card-note-3"]')).not.toBeNull();
    });
});
