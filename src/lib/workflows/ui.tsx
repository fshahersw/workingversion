import * as Dialog from "@radix-ui/react-dialog";
import {
  Globe,
  ClipboardCheck,
  Calculator,
  FileSearch,
  Mic,
  Volume2,
  ExternalLink,
  Monitor,
  ArrowUp,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  Ellipsis,
  FileCheck2,
  FilePenLine,
  FilePlus2,
  Files,
  FileText,
  FileUp,
  FolderOpen,
  GitBranch,
  GripVertical,
  History,
  Info,
  LayoutGrid,
  ListFilter,
  Loader2,
  LockKeyhole,
  Mail,
  Maximize2,
  Merge,
  MessageSquareText,
  MessagesSquare,
  Minus,
  MoreHorizontal,
  NotebookText,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plug2,
  Plus,
  Redo2,
  Repeat2,
  Save,
  ScanText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Table2,
  TextCursorInput,
  Trash2,
  Undo2,
  Upload,
  UserRoundCheck,
  Users,
  WandSparkles,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const icons = {
  Globe,
  ClipboardCheck,
  Calculator,
  FileSearch,
  Mic,
  Volume2,
  ExternalLink,
  Monitor,
  ArrowUp,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  Ellipsis,
  FileCheck2,
  FilePenLine,
  FilePlus2,
  Files,
  FileText,
  FileUp,
  FolderOpen,
  GitBranch,
  GripVertical,
  History,
  Info,
  LayoutGrid,
  ListFilter,
  Loader2,
  LockKeyhole,
  Mail,
  Maximize2,
  Merge,
  MessageSquareText,
  MessagesSquare,
  Minus,
  MoreHorizontal,
  NotebookText,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plug2,
  Plus,
  Redo2,
  Repeat2,
  Save,
  ScanText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Table2,
  TextCursorInput,
  Trash2,
  Undo2,
  Upload,
  UserRoundCheck,
  Users,
  WandSparkles,
  WorkflowIcon,
  X,
  Zap,
};
export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Component = icons[name as keyof typeof icons] || WorkflowIcon;
  return <Component size={size} strokeWidth={1.7} aria-hidden="true" className={className} />;
}
export function Tile({
  icon,
  tone = "slate",
  small = false,
}: {
  icon: string;
  tone?: string;
  small?: boolean;
}) {
  return (
    <span className={`swf-tile swf-tone-${tone} ${small ? "swf-tile-small" : ""}`}>
      <Icon name={icon} size={small ? 15 : 19} />
    </span>
  );
}
export function Button({
  icon,
  variant = "secondary",
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button type="button" {...props} className={`swf-btn swf-btn-${variant} ${className}`}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      title={label}
      className={`swf-icon-button ${props.className || ""}`}
    >
      <Icon name={icon} />
    </button>
  );
}
export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: string }) {
  return <span className={`swf-badge swf-tone-${tone}`}>{children}</span>;
}
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <div className="swf-root swf-portal">
          <Dialog.Overlay className="swf-overlay" />
          <Dialog.Content
            className={`swf-modal ${wide ? "swf-modal-wide" : ""}`}
            aria-describedby={description ? undefined : undefined}
          >
            <div className="swf-modal-heading">
              <div>
                <Dialog.Title>{title}</Dialog.Title>
                {description && <Dialog.Description>{description}</Dialog.Description>}
              </div>
              <Dialog.Close asChild>
                <IconButton icon="X" label="Close dialog" />
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "error";
}) {
  return (
    <div className={`swf-notice swf-notice-${tone}`}>
      <Icon name={tone === "info" ? "Info" : "CircleAlert"} />
      <div>{children}</div>
    </div>
  );
}
export const timeLabel = (date: string) =>
  new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
export const statusTone = (status: string) =>
  status === "completed" || status === "Published"
    ? "green"
    : status === "waiting"
      ? "amber"
      : status === "failed" || status === "rejected"
        ? "rose"
        : status === "running"
          ? "blue"
          : "slate";
