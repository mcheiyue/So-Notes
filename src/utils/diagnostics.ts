interface SlowPath {
  name: string;
  duration: number;
  timestamp: number;
}

interface MetricsData {
  totalNotes: number;
  currentBoardNotes: number;
  selectedNotes: number;
  trashNotes: number;
  lastSaveDuration: number;
  lastRenderDuration: number;
  lastSearchDuration: number;
  lastInitDuration: number;
  fps: number;
  jankCount: number;
  slowPaths: SlowPath[];
}

export class DiagnosticsCollector {
  private metrics: MetricsData = {
    totalNotes: 0,
    currentBoardNotes: 0,
    selectedNotes: 0,
    trashNotes: 0,
    lastSaveDuration: 0,
    lastRenderDuration: 0,
    lastSearchDuration: 0,
    lastInitDuration: 0,
    fps: 60,
    jankCount: 0,
    slowPaths: [],
  };

  private listeners: Set<() => void> = new Set();

  updateMetrics(updates: Partial<Omit<MetricsData, 'slowPaths'>>): void {
    this.metrics = { ...this.metrics, ...updates };
    this.notifyListeners();
  }

  updateFPS(fps: number, jankCount: number): void {
    this.metrics.fps = fps;
    this.metrics.jankCount = jankCount;
    this.notifyListeners();
  }

  getMetrics(): MetricsData {
    return { ...this.metrics };
  }

  recordSlowPath(name: string, duration: number): void {
    this.metrics.slowPaths.push({
      name,
      duration,
      timestamp: Date.now(),
    });
    
    if (this.metrics.slowPaths.length > 10) {
      this.metrics.slowPaths.shift();
    }
    
    this.notifyListeners();
  }

  clearSlowPaths(): void {
    this.metrics.slowPaths = [];
    this.notifyListeners();
  }

  updateNoteStats(
    totalNotes: number,
    currentBoardNotes: number,
    selectedNotes: number,
    trashNotes: number
  ): void {
    this.metrics.totalNotes = totalNotes;
    this.metrics.currentBoardNotes = currentBoardNotes;
    this.metrics.selectedNotes = selectedNotes;
    this.metrics.trashNotes = trashNotes;
    this.notifyListeners();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }
}

export const diagnostics = new DiagnosticsCollector();

// Subscribe to Zustand store changes to sync note stats
// Use dynamic import to avoid circular dependency
if (typeof window !== 'undefined') {
  import('../store/useStore').then(({ useStore }) => {
    useStore.subscribe((state) => {
      const totalNotes = state.notes.length;
      const currentBoardNotes = state.notes.filter(
        (n) => n.boardId === state.currentBoardId && !n.deletedAt
      ).length;
      const selectedNotes = state.selectedIds.length;
      const trashNotes = state.notes.filter((n) => n.deletedAt).length;
      diagnostics.updateNoteStats(totalNotes, currentBoardNotes, selectedNotes, trashNotes);
    });
  });
}
