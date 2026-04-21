import React, { useEffect, useRef, useState } from 'react';
import { diagnostics } from '../utils/diagnostics';
import DiagnosticsMetric, { DiagnosticsMetricHandle } from './DiagnosticsMetric';
import { cn } from '../utils/cn';

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
    </div>
  );
};
