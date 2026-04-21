import React, { useRef, useImperativeHandle, forwardRef } from 'react';

export interface DiagnosticsMetricHandle {
  setText: (text: string) => void;
}

const DiagnosticsMetric = forwardRef<DiagnosticsMetricHandle>((_, ref) => {
  const spanRef = useRef<HTMLSpanElement>(null);
  
  useImperativeHandle(ref, () => ({
    setText: (text: string) => {
      if (spanRef.current) {
        spanRef.current.textContent = text;
      }
    }
  }));
  
  return <span ref={spanRef} className="diagnostics-value tabular-nums" />;
});

export default React.memo(DiagnosticsMetric, () => true);
