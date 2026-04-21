import { useCallback, useRef } from 'react';
import { diagnostics } from './diagnostics';

interface FPSData {
  fps: number;
  frameTime: number;
  jankCount: number;
}

export class FPSMonitor {
  private rafId: number = 0;
  private lastTime = performance.now();
  private frameCount = 0;
  private jankCount = 0;
  private samples: number[] = [];
  private maxSamples = 60;
  private jankThreshold = 33.33;
  private onUpdate: ((data: FPSData) => void) | null = null;

  start(onUpdate: (data: FPSData) => void) {
    if (this.rafId) return;

    this.onUpdate = onUpdate;
    this.lastTime = performance.now();
    this.frameCount = 0;
    this.jankCount = 0;
    this.samples = [];

    let insideLoop = false;

    const loop = (now: number) => {
      if (insideLoop) return;
      insideLoop = true;

      this.frameCount++;

      const delta = now - this.lastTime;

      if (delta >= 1000) {
        const fps = Math.round((this.frameCount * 1000) / delta);
        const frameTime = delta / this.frameCount;

        this.samples.push(frameTime);
        if (this.samples.length > this.maxSamples) {
          this.samples.shift();
        }

        if (frameTime > this.jankThreshold) {
          this.jankCount++;
        }

        this.onUpdate?.({
          fps,
          frameTime,
          jankCount: this.jankCount,
        });

        this.lastTime = now;
        this.frameCount = 0;
      }

      insideLoop = false;
      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  reset() {
    this.jankCount = 0;
    this.samples = [];
  }
}

export function useFPSMonitor() {
  const monitorRef = useRef(new FPSMonitor());

  const start = useCallback((onUpdate: (data: FPSData) => void) => {
    monitorRef.current.start(onUpdate);
  }, []);

  const stop = useCallback(() => {
    monitorRef.current.stop();
  }, []);

  return { start, stop };
}

if (typeof window !== 'undefined') {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'measure' && entry.duration > 50) {
          diagnostics.recordSlowPath(entry.name, entry.duration);
        }
      }
    });

    observer.observe({ entryTypes: ['measure'] });
  } catch {}

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        diagnostics.recordSlowPath('Long Task', entry.duration);
      }
    });

    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {}
}
