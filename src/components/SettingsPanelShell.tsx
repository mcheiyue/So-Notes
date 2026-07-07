import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface SettingsPanelShellProps {
  readonly title: string;
  /** 提供时渲染返回按钮；MAIN 视图不传，仅显示标题。 */
  readonly onBack?: () => void;
  readonly children: React.ReactNode;
}

/**
 * 设置浮层统一外壳：固定头部 + 单一可滚动内容区。
 * max-height 约束是托盘窗口内浮层不被裁切的关键——内容再高也在壳内滚动，
 * 而不是向上溢出窗口顶部（窗口高约 600px，dvh 即窗口高度）。
 */
export const SettingsPanelShell: React.FC<SettingsPanelShellProps> = ({
  title,
  onBack,
  children,
}) => (
  <div className="flex flex-col max-h-[calc(100dvh-96px)]">
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle flex-shrink-0">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      <span className="min-w-0 truncate text-xs text-text-tertiary font-medium">{title}</span>
    </div>
    <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
  </div>
);
