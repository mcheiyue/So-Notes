import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { DetachedNoteWindow } from "./components/DetachedNoteWindow";

const params = new URLSearchParams(window.location.search);
const noteId = params.get("noteId");

const rootEl = document.getElementById("detached-root");

if (!noteId || !rootEl) {
  if (rootEl) {
    rootEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-size:14px;color:#94a3b8;">缺少 noteId 参数</div>';
  }
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <DetachedNoteWindow noteId={noteId} />
    </React.StrictMode>,
  );
}
