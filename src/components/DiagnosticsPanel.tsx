import React, { useEffect, useRef, useState } from 'react';
import { diagnostics } from '../utils/diagnostics';
import DiagnosticsMetric, { DiagnosticsMetricHandle } from './DiagnosticsMetric';
import { cn } from '../utils/cn';
import { SAMPLE_PRESETS, generatePresetSample } from '../test/fixtures/sampleData';
import { useStore } from '../store/useStore';

const UPDATE_INTERVAL = 1000;

export const DiagnosticsPanel: React.FC = () => {
  const totalNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const currentBoardNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const selectedNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const trashNotesRef = useRef<DiagnosticsMetricHandle>(null);
  const lastSaveRef = useRef<DiagnosticsMetricHandle>(null);
  const lastSearchRef = useRef<DiagnosticsMetricHandle>(null);
  const fpsRef = useRef<DiagnosticsMetricHandle>(null);
  const jankRef = useRef<DiagnosticsMetricHandle>(null);

  const [slowPaths, setSlowPaths] = useState<Array<{ name: string; duration: number; timestamp: number }>>([]);

  // Inject test data handler
  const injectTestData = (presetName: keyof typeof SAMPLE_PRESETS) => {
    const sampleData = generatePresetSample(presetName);
    const store = useStore.getState();
    const existingBoardNames = store.boards.map((b) => b.name);

    // Rename boards to avoid conflicts
    const renamedBoards = sampleData.boards.map((b, i) => ({
      ...b,
      name: existingBoardNames.includes(b.name) ? `${b.name} (测试${i})` : b.name,
    }));

    // Merge data into store via setState
    useStore.setState((state) => {
      // Add boards
      state.boards.push(...renamedBoards);
      // Add notes with new board IDs mapping
      const boardIdMap = new Map<string, string>();
      sampleData.boards.forEach((oldBoard, i) => {
        boardIdMap.set(oldBoard.id, renamedBoards[i].id);
      });
      const newNotes = sampleData.notes.map((n) => ({
        ...n,
        boardId: boardIdMap.get(n.boardId) || state.currentBoardId,
      }));
      state.notes.push(...newNotes);
      // Update maxZ
      state.config.maxZ = Math.max(state.config.maxZ, state.notes.length + 1);
    });

    // Trigger save
    store.saveToDisk();
  };

  useEffect(() => {
    const updateMetrics = () => {
      const metrics = diagnostics.getMetrics();

      totalNotesRef.current?.setText(`${metrics.totalNotes} 条`);
      currentBoardNotesRef.current?.setText(`${metrics.currentBoardNotes} 条`);
      selectedNotesRef.current?.setText(`${metrics.selectedNotes} 条`);
      trashNotesRef.current?.setText(`${metrics.trashNotes} 条`);
      lastSaveRef.current?.setText(`${metrics.lastSaveDuration}ms`);
      lastSearchRef.current?.setText(`${metrics.lastSearchDuration}ms`);
      fpsRef.current?.setText(`${metrics.fps.toFixed(1)}`);
      jankRef.current?.setText(`${metrics.jankCount}`);
      setSlowPaths([...metrics.slowPaths]);
    };

    const interval = setInterval(updateMetrics, UPDATE_INTERVAL);
    updateMetrics();

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="diagnostics-panel p-4 border-t border-border-subtle">
      <div className="mb-4">
        <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
          便签统计
        </h4>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-text-tertiary">总计:</span>
            <DiagnosticsMetric ref={totalNotesRef} />
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">当前看板:</span>
            <DiagnosticsMetric ref={currentBoardNotesRef} />
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">已选中:</span>
            <DiagnosticsMetric ref={selectedNotesRef} />
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">废纸篓:</span>
            <DiagnosticsMetric ref={trashNotesRef} />
          </div>
        </div>
      </div>

      <div className="mb-4">
        <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
          性能指标
        </h4>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-text-tertiary">最近保存:</span>
            <DiagnosticsMetric ref={lastSaveRef} />
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">最近搜索:</span>
            <DiagnosticsMetric ref={lastSearchRef} />
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">FPS:</span>
            <DiagnosticsMetric ref={fpsRef} />
          </div>
          <div className={cn(
            "flex justify-between",
            slowPaths.length > 0 && "text-warning-text"
          )}>
            <span className="text-text-tertiary">掉帧次数:</span>
            <DiagnosticsMetric ref={jankRef} />
          </div>
        </div>
      </div>

      {slowPaths.length > 0 && (
        <div className="border-t border-border-subtle pt-3">
          <h4 className="text-xs font-medium text-warning-text uppercase tracking-wider mb-2">
            慢路径
          </h4>
          <div className="space-y-1 text-xs">
            {slowPaths.slice(-5).map((path, i) => (
              <div key={i} className="flex justify-between text-text-secondary">
                <span>{path.name}</span>
                <span className="tabular-nums">{path.duration}ms</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => diagnostics.clearSlowPaths()}
            className="mt-2 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            清除
          </button>
        </div>
      )}

      {/* Test Data Injection */}
      <div className="border-t border-border-subtle pt-3">
        <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">
          压测样本注入
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => injectTestData('NOTES_100')}
            className="px-2 py-1.5 text-[10px] bg-secondary-bg/70 hover:bg-primary-bg/20 text-text-secondary hover:text-primary border border-border-subtle rounded transition-colors"
          >
            注入 100 条
          </button>
          <button
            onClick={() => injectTestData('NOTES_500')}
            className="px-2 py-1.5 text-[10px] bg-secondary-bg/70 hover:bg-primary-bg/20 text-text-secondary hover:text-primary border border-border-subtle rounded transition-colors"
          >
            注入 500 条
          </button>
          <button
            onClick={() => injectTestData('NOTES_1000')}
            className="px-2 py-1.5 text-[10px] bg-secondary-bg/70 hover:bg-warning-bg/20 text-text-secondary hover:text-warning-text border border-border-subtle rounded transition-colors"
          >
            注入 1000 条
          </button>
          <button
            onClick={() => injectTestData('NOTES_3000')}
            className="px-2 py-1.5 text-[10px] bg-red-50/10 hover:bg-red-100/20 text-red-500 hover:text-red-600 border border-red-200/30 rounded transition-colors"
          >
            注入 3000 条
          </button>
        </div>
        <p className="mt-2 text-[10px] text-text-tertiary opacity-70">
          测试数据将复制当前看板并注入，便于测试视口裁剪性能
        </p>
      </div>
    </div>
  );
};