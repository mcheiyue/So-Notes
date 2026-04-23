import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { generatePresetSample } from "./test/fixtures/sampleData";
import { normalizeNotes } from "./store/normalization";
import { useStore } from "./store/useStore";

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__injectTestData = (preset: string) => {
    const state = generatePresetSample(preset as Parameters<typeof generatePresetSample>[0]);
    const normalizedNotes = normalizeNotes(state.notes);
    useStore.setState({
      ...normalizedNotes,
      boards: state.boards,
      currentBoardId: state.currentBoardId,
      isLoaded: true,
    });
    useStore.getState().saveToDisk();
    console.log(`[TestData] 已注入 ${state.notes.length} 条便签、${state.boards.length} 个看板 (preset: ${preset})`);
  };
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
<React.StrictMode>
  <App />
</React.StrictMode>,
);
