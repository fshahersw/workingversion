import { MutationOwnership } from '@/lib/office/mutation-ownership'
import { OfficeTaskControls } from '@/office/shared/OfficeTaskControls'
import {AssistantHeader,AssistantActivity,AssistantWorking,AssistantReasoning,AssistantContext,AssistantStarters,AssistantOptions,AssistantIcon,AssistantReplyActions,JumpToLatest,groupMessages,settleRunMessages,scopeLabel} from '@genoffice/ui'
// sw-assistant-upgrade-v1: UI-only integration; original engines and service boundaries retained.
/* Modified for the Seeger Weiss Writer desktop preview from GenOffice commit 69b4ce0. See the retained LICENSE, NOTICE, and source-change list. */
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Block } from '@genoffice/docx-engine'
import { AgentLoop, composeSkills, type AgentImage, type ToolDisplay } from '@genoffice/agent-core'
import type { AiSettings, AttachmentAddResult, AttachmentMeta } from '../../shared/ipc'
import { ATTACHMENT_IMAGE_EXTS } from '../../shared/ipc'
import type { PmNode } from '../editor/convert'
import { countWords, findNumId, type NumIds } from './protocol'
import { DOC_NAV_SCHEME, navigateToBlock, parseDocNavHref } from './doc-nav'
import {
  markDocSeen,
  type AiCommentsAccess,
  type AiDocumentAccess,
  type AiHeaderFooterAccess,
  type WriterSnapshot,
} from './tools'
import { createDocsSkill } from './docs-skill'
import { EditQueueCard } from './EditQueueCard'
import {
  buildQueueInstruction,
  buildQueueSummary,
  liveItems,
  resolveQueue,
  type DocsEditQueueItem,
} from './edit-queue'
import { applyRevisionsBy } from '../editor/revisions'
import { DOCS_CONTINUE_INSTRUCTION } from './continuation'
import { waitForFullContent } from '../phased-content'
import { currentDocGeneration } from '../file-actions'
import { createFilesSkill } from './files-skill'
import { createElectronTransport } from './transport'
import { useDictation } from './useDictation'
import { writerSkill } from './sw-skill'
import { modeName, profileName, publicQuery, type WriterMode, type WriterProfile } from '../../shared/sw-policy'
import { useI18n, t as tModule, aiLangDirective, type StringKey } from '../i18n/locale'
import { AssistantMessage } from '@genoffice/ui'
import { AiComposer, AiTypingIndicator } from '@genoffice/ui'
import { WriterMark } from '../components/WriterHeader'
import sendEnterOn from '../assets/send-enter-on.png'
import sendEnterOff from '../assets/send-enter-off.png'
import sendStop from '../assets/send-stop.png'
import attachIcon from '../assets/attach-icon.png'
import filePdfIcon from '../assets/file-pdf.png'
import fileWordIcon from '../assets/file-word.png'
import fileExcelIcon from '../assets/file-excel.png'
import filePptIcon from '../assets/file-ppt.png'
import fileImageIcon from '../assets/file-image.png'
import fileVideoIcon from '../assets/file-video.png'
import fileVoiceIcon from '../assets/file-voice.png'
import fileDocumentIcon from '../assets/file-document.png'
import fileGeneralIcon from '../assets/file-general.png'
import { IconNewChat, IconSidebarCollapse } from '../components/icons'

interface ToolActivity {
  display?: ToolDisplay
  id?: string; startedAt?: number; finishedAt?: number; interrupted?: boolean; mutated?: boolean; running?: boolean
  name: string
  summary: string
  /** still executing: rendered as a spinner chip, replaced in place when the tool finishes */
  isError?: boolean
  skipped?: boolean
  /** Tool output (truncated on the UI side); when set, the row can be expanded for details */
  output?: string
}

/** Max characters of tool output in the UI expansion panel */
const TOOL_OUTPUT_MAX_CHARS = 6000

/** Cap on tool args/output persisted in the transcript (the store layer has another 16k truncation fallback) */
const PERSIST_TOOL_FIELD_MAX = 16_000

/** Tool args → JSON string (truncated; returns undefined on serialization failure, doesn't block persistence) */
function safeJsonInput(input: unknown): string | undefined {
  try {
    const s = JSON.stringify(input)
    return s && s !== '{}' ? s.slice(0, PERSIST_TOOL_FIELD_MAX) : undefined
  } catch {
    return undefined
  }
}

interface ChatEntry {
  role: 'user' | 'assistant'
  text: string
  error?: string
  streaming?: boolean
  turnLimit?: boolean
  /** the run failed because Genspark is signed out — render an inline sign-in button */
  loginRequired?: boolean
  /** tool executions performed during this assistant turn */
  tools?: ToolActivity[]
  /** streamed model reasoning for this segment (UI only, never persisted) */
  reasoning?: string
  /** model tier status line for this segment (UI only) */
  status?: string
  /** document state before this turn's first edit — rendered as an inline roll-back action */
  snapshot?: WriterSnapshot
  /** attachments consumed from the composer by this user message (read-only echo chips) */
  attachments?: AttachmentMeta[]
}

/** clickable starter prompts for the empty state (fill the input, do not send) —
 * blank documents get generation starters, documents with content get edit starters */
const DRAFT_STARTER_PROMPTS: StringKey[] = [
  'aiStarterWeeklyReport',
  'aiStarterLaunchPost',
  'aiStarterEventOutline',
]
const EDIT_STARTER_PROMPTS: StringKey[] = [
  'aiStarterSummarize',
  'aiStarterPolishAll',
  'aiStarterContinue',
  'aiStarterFillTemplate',
]

/** resizable panel width: persisted, clamped so neither pane collapses */
const PANEL_WIDTH_KEY = 'docs-ai-panel-width'
const PANEL_WIDTH_DEFAULT = 360
const PANEL_WIDTH_MIN = 280

function maxPanelWidth(): number {
  // The viewport can be transiently tiny (a WebContentsView is 0×0 until the
  // shell lays it out), so never let the ceiling drop below the minimum
  return Math.max(PANEL_WIDTH_MIN, Math.min(720, Math.round(window.innerWidth * 0.6)))
}

function clampPanelWidth(w: number): number {
  return Math.min(Math.max(w, PANEL_WIDTH_MIN), maxPanelWidth())
}

function loadPanelWidth(): number {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  // static bounds only — clamping against the window here would bake a
  // transiently small viewport into the restored preference
  return Number.isFinite(saved) && saved > 0
    ? Math.min(Math.max(saved, PANEL_WIDTH_MIN), 720)
    : PANEL_WIDTH_DEFAULT
}

/** persisted UI preference: highlight AI edits in yellow and ask for confirmation */
const TRACK_CHANGES_KEY = 'ai-docs-track-changes'

/** Clipboard bitmap MIME → attachment extension (corresponds to ATTACHMENT_IMAGE_EXTS) */
const PASTE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** File-type icons for attachment cards (Genspark attachment icon set); exts the
 *  attachment allowlist doesn't accept yet are mapped ahead so they light up when added */
const ATTACHMENT_CARD_ICON_GROUPS: [icon: string, exts: string[]][] = [
  [fileWordIcon, ['doc', 'docx']],
  [fileExcelIcon, ['xls', 'xlsx', 'xlsm', 'csv', 'tsv']],
  [filePptIcon, ['ppt', 'pptx']],
  [filePdfIcon, ['pdf']],
  [fileImageIcon, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'heic']],
  [fileVideoIcon, ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']],
  [fileVoiceIcon, ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']],
  [
    fileDocumentIcon,
    [
      'txt',
      'md',
      'markdown',
      'rtf',
      'log',
      'json',
      'yaml',
      'yml',
      'xml',
      'html',
      'htm',
      'js',
      'ts',
      'tsx',
      'jsx',
      'py',
      'java',
      'c',
      'h',
      'cpp',
      'go',
      'rs',
      'rb',
      'sh',
      'sql',
      'css',
    ],
  ],
]

const ATTACHMENT_CARD_ICONS: Record<string, string> = Object.fromEntries(
  ATTACHMENT_CARD_ICON_GROUPS.flatMap(([icon, exts]) => exts.map((ext) => [ext, icon])),
)

function AttachmentCardIcon({ ext }: { ext: string }) {
  return <img src={ATTACHMENT_CARD_ICONS[ext] ?? fileGeneralIcon} alt="" aria-hidden />
}

/** Card name slot width: 190 card - 2 border - 8/14 padding - 40 icon - 10 gap */
const CARD_NAME_MAX_WIDTH = 116
let cardNameCtx: CanvasRenderingContext2D | null = null

/** Ellipsize like the design: cut at the limit, strip trailing -_./spaces so
 *  punctuation never sits against the …; CSS text-overflow stays as fallback */
function truncateCardName(name: string): string {
  cardNameCtx ??= document.createElement('canvas').getContext('2d')
  if (!cardNameCtx) return name
  // must match the stack the card name actually renders with (body font in styles.css)
  cardNameCtx.font =
    "500 13px 'Segoe UI', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif"
  if (cardNameCtx.measureText(name).width <= CARD_NAME_MAX_WIDTH) return name
  let lo = 1
  let hi = name.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cardNameCtx.measureText(`${name.slice(0, mid)}…`).width <= CARD_NAME_MAX_WIDTH) lo = mid
    else hi = mid - 1
  }
  return `${name.slice(0, lo).replace(/[-_.\s]+$/, '')}…`
}

function formatAttachmentSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(2)} KB`
}

/** Read-only echo of the attachments a user message consumed from the composer
 *  (image previews when the file is still readable; otherwise the placeholder icon) */
function SentAttachments({
  atts,
  previews,
}: {
  atts: AttachmentMeta[]
  previews: Record<string, string>
}) {
  return (
    <div className="ai-msg-attachments">
      {atts.map((a) =>
        ATTACHMENT_IMAGE_EXTS.has(a.ext) ? (
          <span key={a.path} className="ai-attachment-thumb" title={a.name}>
            {previews[a.path] ? (
              <img src={previews[a.path]} alt={a.name} />
            ) : (
              <span className="ai-attachment-thumb-pending" aria-hidden>
                <img src={fileImageIcon} alt="" />
              </span>
            )}
          </span>
        ) : (
          <span key={a.path} className="ai-attachment-card" title={a.name}>
            <span className="ai-attachment-card-icon">
              <AttachmentCardIcon ext={a.ext} />
            </span>
            <span className="ai-attachment-card-meta">
              <span className="ai-attachment-card-name">{truncateCardName(a.name)}</span>
              <span className="ai-attachment-card-size">{formatAttachmentSize(a.sizeBytes)}</span>
            </span>
          </span>
        ),
      )}
    </div>
  )
}

/** author name on AI-generated tracked revisions (accept/reject via Review) */
export const AI_REVISION_AUTHOR = 'AI Assistant'

interface AiPanelProps {
  editor: Editor
  blocks: Block[]
  settings: AiSettings
  /** the document has no text yet — the empty-state copy offers drafting instead of editing */
  docEmpty?: boolean
  /** fallback numbering ids for documents created from the blank template */
  numIdFallback?: NumIds | null
  /** preset instruction pushed from the ribbon or start screen; autoRun sends it immediately */
  preset?: { text: string; nonce: number; autoRun?: boolean } | null
  /** false shows only the collapsed rail; the component stays mounted so panel state survives */
  open?: boolean
  /** expand from the collapsed rail */
  onExpand?: () => void
  /** collapse the panel to the sidebar rail */
  onCollapse?: () => void
  /** Absolute path of the currently open file (used for chat-history persistence) */
  filePath?: string | null
  /** queued selection-scoped edits (owned by App, which also owns the anchors) */
  editQueue?: DocsEditQueueItem[]
  onQueueEditInstruction?: (qid: string, instruction: string) => void
  onQueueRemove?: (qid: string) => void
  onQueueClear?: () => void
  /** scroll to and select the anchored passage */
  onQueueFocus?: (qid: string) => void
  /** submission consumed these items: drop them and their anchors */
  onQueueConsume?: (qids: string[]) => void
  /** comments store for the AI comment tools (read/reply/resolve) */
  commentsAccess?: AiCommentsAccess
  /** header/footer state for the set_header_footer tool and per-turn context */
  hfAccess?: AiHeaderFooterAccess
  /** page setup + footnotes for set_page_setup / apply_court_style / insert_footnote */
  docAccess?: AiDocumentAccess
}

const WRITER_MODE_NOTE: Record<WriterMode, string> = {
  write: 'Writes directly into the document. A restoration point is kept for each response.',
  ask: 'Ask about the document or selected passage. No edits are made.',
  review: 'Check the draft against available sources. No edits are made.',
  research: 'Only the public question you enter is searched. No document or attachments are included.',
}

export function AiPanel({
  editor,
  blocks,
  settings,
  docEmpty,
  numIdFallback,
  preset,
  open = true,
  onExpand,
  onCollapse,
  filePath,
  editQueue = [],
  onQueueEditInstruction,
  onQueueRemove,
  onQueueClear,
  onQueueFocus,
  onQueueConsume,
  commentsAccess,
  hfAccess,
  docAccess,
}: AiPanelProps) {
  const { t, lang } = useI18n()
  // Panel chrome follows the UI language; message text follows its own content (dir=auto below)
  const isRtl = lang === 'ar' || lang === 'he'
  const [input, setInput] = useState('')
  // Dictation: append the transcript to whatever is already typed, so the user
  // can dictate then edit before sending (never auto-sends).
  const dictation = useDictation((text) =>
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
  )
  const [busy, setBusy] = useState(false)
  const [writerMode, setWriterMode] = useState<WriterMode>('write')
  const [writerProfile, setWriterProfile] = useState<WriterProfile>('standard')
  const writerModeRef = useRef<WriterMode>('write')
  const writerProfileRef = useRef<WriterProfile>('standard')
  const researchApprovalRef = useRef('')
  // Research tab appears only when the server (or desktop connection) reports an approved gateway
  const [researchConfigured, setResearchConfigured] = useState(false)
  useEffect(() => {
    let alive = true
    window.desktop.writerStatus().then(s => { if (alive) setResearchConfigured(!!s?.researchConfigured) }).catch(() => {})
    return () => { alive = false }
  }, [])
  writerModeRef.current = writerMode
  writerProfileRef.current = writerProfile
  useEffect(() => {
    const prefs = settings as unknown as {swMode?: unknown; swProfile?: unknown}
    setWriterMode(modeName(prefs.swMode)); setWriterProfile(profileName(prefs.swProfile))
  }, [settings])
  const openConnection = () => window.dispatchEvent(new Event('sw-open-connection'))
  const changeWriterMode = (next: WriterMode) => {
    if (busy) return
    loopRef.current?.reset()
    writerModeRef.current = next; setWriterMode(next)
    researchApprovalRef.current = ''
    setScopePreviewOpen(false)
    void window.desktop.setAiSettings({...settingsRef.current, swMode: next, swProfile: writerProfileRef.current} as AiSettings).catch(() => {})
  }
  const changeWriterProfile = (next: WriterProfile) => {
    if (busy) return
    // Profiles can use different wire protocols; never replay incompatible signed context.
    loopRef.current?.reset()
    writerProfileRef.current=next;setWriterProfile(next)
    void window.desktop.setAiSettings({...settingsRef.current, swMode: writerModeRef.current, swProfile: next} as AiSettings).catch(() => {})
  }

  /** Wall-clock start of the current run, drives the elapsed badge */
  const runStartedAtRef = useRef(0)
  /** a send waiting on a phased open's tail; Stop / New chat abort it before it runs */
  const pendingSendRef = useRef<{ aborted: boolean } | null>(null)
  const [chat, setChat] = useState<ChatEntry[]>([])
  /** Past conversation restored from JSONL (read-only transcript, not fed to the model) */
  const [historicChat, setHistoricChat] = useState<ChatEntry[]>([])
  const [trackChanges, setTrackChanges] = useState(
    () => localStorage.getItem(TRACK_CHANGES_KEY) === '1',
  )
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  /** data-URL previews for image attachments, keyed by path (Genspark composer thumbnails) */
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({})
  /** image paths with a read already issued — one readAttachmentImage per attach, even while pending */
  const previewRequestedRef = useRef(new Set<string>())
  /** Attachments consumed by earlier sends this session: sending clears the composer, but the
      files skill must keep reading them mid-run and in follow-up turns. Deduped by path
      against the live composer list. */
  const sentAttachmentsRef = useRef<AttachmentMeta[]>([])
  useEffect(() => {
    // previews cover the composer plus every image echoed on a sent/history message
    // (history chips re-read the file by its stored path; a deleted file keeps the placeholder)
    const wanted = [
      ...attachments,
      ...chat.flatMap((e) => e.attachments ?? []),
      ...historicChat.flatMap((e) => e.attachments ?? []),
    ]
    const alive = new Set(wanted.map((a) => a.path))
    // drop previews (and request markers) of removed attachments, so memory is reclaimed and a re-attach re-reads
    setAttachmentPreviews((prev) => {
      const stale = Object.keys(prev).filter((p) => !alive.has(p))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const p of stale) delete next[p]
      return next
    })
    for (const p of previewRequestedRef.current) {
      if (!alive.has(p)) previewRequestedRef.current.delete(p)
    }
    for (const a of wanted) {
      if (!ATTACHMENT_IMAGE_EXTS.has(a.ext) || previewRequestedRef.current.has(a.path)) continue
      previewRequestedRef.current.add(a.path)
      void window.desktop
        .readAttachmentImage(a.path)
        .then((r) => {
          if (!previewRequestedRef.current.has(a.path)) return // removed while the read was in flight
          if (r.ok && r.base64 && r.mime) {
            setAttachmentPreviews((prev) => ({
              ...prev,
              [a.path]: `data:${r.mime};base64,${r.base64}`,
            }))
          }
        })
        .catch(() => {
          // A rejected read (bridge error, teardown race) must not leave the
          // path marked requested forever — that would permanently skip the
          // thumbnail with no retry. Clear it so the next effect run retries.
          previewRequestedRef.current.delete(a.path)
        })
    }
  }, [attachments, chat, historicChat])
  /** paints the strip's scrollbar thumb while the user scrolls it (cleared 800ms after the last event) */
  const attachScrollFadeRef = useRef(0)
  const onAttachmentsScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    el.classList.add('is-scrolling')
    window.clearTimeout(attachScrollFadeRef.current)
    attachScrollFadeRef.current = window.setTimeout(() => el.classList.remove('is-scrolling'), 800)
  }
  const [dragOver, setDragOver] = useState(false)
  // preferred = the user's chosen width (the only value persisted); panelWidth =
  // what fits the current window. Deriving the display width from the preference
  // means a transiently small window never permanently shrinks the panel.
  const preferredWidthRef = useRef(loadPanelWidth())
  const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(preferredWidthRef.current))
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  // The .ai-dock wrapper owns the animated width (Excel-parity 180ms slide);
  // it tracks the resizable panel width through this variable
  // `open` dep: the aside ref only exists while expanded
  useEffect(() => {
    const dock = asideRef.current?.closest('.ai-dock') as HTMLElement | null
    dock?.style.setProperty('--ai-panel-width', `${panelWidth}px`)
  }, [panelWidth, open])

  // Re-derive the display width on window resize (max is 60% of the window);
  // growing the window back restores the preferred width
  useEffect(() => {
    const onResize = () => setPanelWidth(clampPanelWidth(preferredWidthRef.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // bumped on selection/doc changes so the scope hint & quick actions stay fresh
  const [, setScopeTick] = useState(0)
  /** the scope chip's expandable preview of the selected text */
  const [scopePreviewOpen, setScopePreviewOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** false once the user scrolls up to read; re-arms near the bottom */
  const stickToBottomRef = useRef(true)
  /** projectId/chatId of the current chat */
  const chatRefIds = useRef<{ projectId: string; chatId: string } | null>(null)

  // latest props for the loop's closures (the loop instance outlives renders)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const settingsRef = useRef(settings)
  settingsRef.current = {...settings, swMode: writerMode, swProfile: writerProfile} as AiSettings
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const numIdFallbackRef = useRef(numIdFallback)
  numIdFallbackRef.current = numIdFallback
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  /** attachments consumed by the most recent send — retry resends the same set */
  const lastAttachmentsRef = useRef<AttachmentMeta[]>([])
  /** composer attachments plus everything already sent this session (deduped by path) */
  const availableAttachments = (): AttachmentMeta[] => {
    if(writerModeRef.current==='research') return []
    const seen = new Set<string>()
    return [...sentAttachmentsRef.current, ...attachmentsRef.current].filter((a) =>
      seen.has(a.path) ? false : (seen.add(a.path), true),
    )
  }
  const trackChangesRef = useRef(trackChanges)
  trackChangesRef.current = trackChanges
  const commentsAccessRef = useRef(commentsAccess)
  commentsAccessRef.current = commentsAccess
  const hfAccessRef = useRef(hfAccess)
  hfAccessRef.current = hfAccess
  const docAccessRef = useRef(docAccess)
  docAccessRef.current = docAccess

  /** drop every aiChanged flag; silent = skip undo history (auto-accept path) */
  const clearAiHighlights = (silent = false) => {
    const view = editorRef.current.view
    let tr = view.state.tr
    let touched = false
    view.state.doc.forEach((node, offset) => {
      if (node.attrs.aiChanged) {
        tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, aiChanged: false })
        touched = true
      }
    })
    if (silent) tr = tr.setMeta('addToHistory', false)
    if (touched) {
      view.dispatch(tr)
      // AI-pipeline housekeeping, not a user edit: keep the freshness baseline current
      markDocSeen(editorRef.current)
    }
  }
  /** instruction of the in-flight run */
  const instructionRef = useRef('')
  /** document state before the run's first edit — attached to the turn's final
      segment at run end (mid-turn segments never show the action toolbar) */
  const runSnapshotRef = useRef<WriterSnapshot | null>(null)
  /** last sent instruction, for one-click retry */
  const lastInstructionRef = useRef('')
  /** Tool activity of the whole run (with args/output, accumulated across turns) — for full
      transcript persistence, and so persisting needn't do side effects inside a setState updater */
  const runToolsRef = useRef<
    Array<{ name: string; summary: string; isError?: boolean; skipped?: boolean; input?: string; output?: string }>
  >([])

  // ── Chat-history persistence ────────────────────────────────────────────
  useEffect(() => {
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!api) return
    const tempChatId = `unsaved-${Date.now()}`
    void api
      .resolveChat({ filePath: filePath ?? null, tempChatId })
      .then((ids) => {
        chatRefIds.current = ids
        return api.loadChat({ projectId: ids.projectId, chatId: ids.chatId, limit: 200 })
      })
      .then((msgs) => {
        if (msgs.length === 0) return
        setHistoricChat(
          msgs.map((m) => ({
            role: m.role,
            text: m.text,
            tools: m.tools?.map((t) => ({
              name: t.name,
              summary: t.summary,
              isError: t.isError,
              skipped: !!t.skipped,
              output: t.output ? t.output.slice(0, TOOL_OUTPUT_MAX_CHARS) : undefined,
            })),
            // stored metadata only: no thumbnail read for history, the chips render name/size
            attachments: m.attachments
              ?.filter((a) => a.path)
              .map((a) => ({
                name: a.name,
                path: a.path ?? '',
                ext: a.ext ?? '',
                sizeBytes: a.sizeBytes ?? 0,
              })),
          })),
        )
        // restore model context: follow-ups after reopening a file continue the previous conversation (only when the loop is idle with no history)
        loopRef.current?.restore(msgs.map((m) => ({ role: m.role, text: m.text })))
      })
      .catch(() => {
        /* history load failures are silent */
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** After an unsaved document's first save yields a real path, bind the unsaved-* history to that file (recoverable by path on reopen) */
  useEffect(() => {
    const ids = chatRefIds.current
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!api || !ids || !filePath || !ids.chatId.startsWith('unsaved-')) return
    void api
      .rebindChat({ projectId: ids.projectId, tempChatId: ids.chatId, newFilePath: filePath })
      .then((r) => {
        if (r?.chatId) chatRefIds.current = r
      })
      .catch(() => {
        /* silent */
      })
  }, [filePath])

  const persistMessage = (
    role: 'user' | 'assistant',
    text: string,
    tools?: Array<{
      name: string
      summary: string
      isError?: boolean
  skipped?: boolean
      input?: string
      output?: string
    }>,
    attachments?: AttachmentMeta[],
  ) => {
    const ids = chatRefIds.current
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!ids || !api) return
    void api
      .appendChat({
        projectId: ids.projectId,
        chatId: ids.chatId,
        role,
        text,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                path: a.path,
                ext: a.ext,
                sizeBytes: a.sizeBytes,
              })),
            }
          : {}),
      })
      .catch(() => {
        /* silent */
      })
  }

  const patchLastAssistant = (
    patch: Partial<ChatEntry> | ((last: ChatEntry) => Partial<ChatEntry>),
  ) => {
    setChat((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (!last || last.role !== 'assistant') return prev
      next[next.length - 1] = { ...last, ...(typeof patch === 'function' ? patch(last) : patch) }
      return next
    })
  }

  const ownershipRef = useRef<MutationOwnership<{ doc: unknown; extras: string }> | null>(null)
  if (!ownershipRef.current) {
    ownershipRef.current = new MutationOwnership<{ doc: unknown; extras: string }>(
      () => ({ doc: editorRef.current.state.doc, extras: JSON.stringify(docAccessRef.current?.snapshotExtras?.() ?? null) }),
      (a, b) => a.doc === b.doc && a.extras === b.extras,
    )
  }

  const loopRef = useRef<AgentLoop<WriterSnapshot> | null>(null)
  if (!loopRef.current) {
    const numIds = (): NumIds => ({
      bullet: findNumId(blocksRef.current, 'bullet') ?? numIdFallbackRef.current?.bullet ?? null,
      ordered: findNumId(blocksRef.current, 'ordered') ?? numIdFallbackRef.current?.ordered ?? null,
    })
    const ownedSkill = writerSkill(composeSkills('docs+files', '', [
        createDocsSkill(
          () => editorRef.current,
          numIds,
          () => (trackChangesRef.current ? { author: AI_REVISION_AUTHOR } : undefined),
          () => commentsAccessRef.current,
          () => hfAccessRef.current,
          () => docAccessRef.current,
          () => instructionRef.current,
        ),
        createFilesSkill(availableAttachments),
      ]), () => writerModeRef.current)
    loopRef.current = new AgentLoop<WriterSnapshot>({
      transport: createElectronTransport(() => settingsRef.current),
      systemSuffix: aiLangDirective,
      get maxTurns() { return writerProfileRef.current==='thorough'?200:100 },
      skill: {
        ...ownedSkill,
        executeTool: (...args) => ownershipRef.current!.run(() => ownedSkill.executeTool(...args)),
      },
      // Full rollback point: the ProseMirror document plus the out-of-editor
      // state (notes, page setup, header/footer) the tools can change.
      captureSnapshot: (): WriterSnapshot => ({
        doc: editorRef.current.getJSON() as PmNode,
        extras: docAccessRef.current?.snapshotExtras?.() ?? null,
      }),
      events: {
        onText: (text) => patchLastAssistant({ text }),
        onReasoning: (text) => patchLastAssistant({ reasoning: text }),
        onStatus: (status) => patchLastAssistant({ status: status.text }),
        onToolStart: (call) => {
          // Live "running" chip: replaced in place by onToolExecuted
          patchLastAssistant((last) => ({
            tools: [
              ...(last.tools ?? []),
              { id: call.id, startedAt: Date.now(),  name: call.name, summary: call.name.replace(/[_-]+/g, ' '), running: true },
            ],
          }))
        },
        onToolExecuted: ({ call, execution, snapshotBefore }) => {
          // The run's first pre-edit state wins so one roll-back undoes the whole run
          if (snapshotBefore && !runSnapshotRef.current) runSnapshotRef.current = snapshotBefore
          if (execution.mutated) {
            // tracking off: accept immediately (same tick, so the yellow never paints);
            // tracking on: revisions stay pending, handled in the Review tab
            if (!trackChangesRef.current) ownershipRef.current!.run(() => clearAiHighlights(true))
          }
          runToolsRef.current.push({
            name: call.name,
            summary: execution.summary,
            isError: execution.isError,
            skipped: !!execution.skipped,
            input: safeJsonInput(call.input),
            output: execution.output
              ? execution.output.slice(0, PERSIST_TOOL_FIELD_MAX)
              : undefined,
          })
          patchLastAssistant((last) => {
            // Swap out the running placeholder pushed by onToolStart (parse-fail calls have none)
            const tools = [...(last.tools ?? [])]
            const pending = tools.findIndex(t => t.id === call.id)
            const startedAt = pending >= 0 ? tools[pending]?.startedAt : undefined
            if (pending >= 0) tools.splice(pending, 1)
            return {
              tools: [
                ...tools,
                { id: call.id, startedAt, display: execution.display, mutated: !!execution.mutated, running: false, finishedAt: Date.now(),
                  name: call.name,
                  summary: execution.summary,
                  isError: execution.isError,
                  skipped: !!execution.skipped,
                  output: execution.output
                    ? execution.output.slice(0, TOOL_OUTPUT_MAX_CHARS)
                    : undefined,
                },
              ],
            }
          })
        },
        onTurnEnd: (directions) => {
          if (directions?.length) {
            persistMessage('assistant', 'Received updated directions; earlier task activity remains in this run.')
            persistMessage('user', directions.join('\n\n'))
          }
          patchLastAssistant({ streaming: false })
          setChat((prev) => [...prev, ...(directions?.length ? [{ role: 'user' as const, text: directions.join('\n\n') }] : []), { role: 'assistant', text: '', streaming: true }])
        },
        onDone: ({ text, cancelled, turnLimit, truncated }) => {
          setChat(previous => settleRunMessages(previous))
          // module-level t: the loop instance is created only once; the component's t goes stale with the first-render closure
          const baseText = turnLimit
            ? [text, tModule('aiTurnLimit')].filter(Boolean).join('\n\n')
            : text || (cancelled ? tModule('aiStopped') : '')
          const finalText = truncated
            ? [baseText, tModule('aiTruncatedNote')].filter(Boolean).join('\n\n')
            : baseText
          patchLastAssistant((last) => ({
            streaming: false,
            turnLimit,
            text: finalText || (last.tools?.length ? last.text : tModule('aiNoReply')),
            // A stop mid-tool can leave a running placeholder behind — drop it
            tools: last.tools?.filter((tl) => !tl.running),
            snapshot: runSnapshotRef.current ?? undefined,
          }))
          setBusy(false)
          // App listens: a run that generated content into a never-saved document
          // triggers a silent first save with a content-derived file name
          window.dispatchEvent(new Event('ai-docs-run-done'))
          // persist outside the updater (a double-invoked updater would write history twice); tools stores the whole run's full activity.
          // Edits-only runs (tools ran, no text) persist too, or the whole turn vanishes from the restored transcript
          if (!cancelled && (finalText || runToolsRef.current.length > 0)) {
            persistMessage('assistant', finalText, runToolsRef.current)
          }
        },
        onError: (error) => {
          // A whole-document rewind is safe only while every intervening edit
          // belongs to this run. Preserve concurrent/ambiguous edits for review.
          const failedSnapshot = runSnapshotRef.current
          let reverted = false
          const rollbackSafe = ownershipRef.current!.canRollback()
          if (failedSnapshot && rollbackSafe) {
            try {
              restoreSnapshot(failedSnapshot)
              reverted = true
            } catch {
              /* keep the partial edits rather than fail twice */
            }
          }
          persistMessage('assistant', `${loopRef.current?.failureCheckpoint ?? error}\n\n${reverted
            ? "The run's changes were rolled back."
            : failedSnapshot ? 'Recovery was incomplete. Inspect the current document before continuing.' : 'No document changes were made by this run.'}`, runToolsRef.current)
          setChat(previous => settleRunMessages(previous))
          setChat((prev) => {
            const next = [...prev]
            const last = next.at(-1)
            if (last?.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                streaming: false,
                error: reverted ? `${error} The run's changes were rolled back.` : failedSnapshot && !rollbackSafe
                  ? `${error} Automatic rollback was skipped to preserve edits made during the run. Review the remaining changes before saving.` : error,
                tools: last.tools?.filter((tl) => !tl.running),
                snapshot: reverted ? undefined : (failedSnapshot ?? undefined),
              }
            }
            return next
          })
          setBusy(false)
        },
      },
    })
  }

  useEffect(() => {
    if (!preset) return
    if (preset.autoRun) runWith(preset.text)
    else {
      setInput(preset.text)
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce])

  // keep the scope hint & quick actions in sync with the editor selection
  useEffect(() => {
    const bump = () => {
      if (editor.state.selection.empty) setScopePreviewOpen(false)
      setScopeTick((t) => t + 1)
    }
    editor.on('selectionUpdate', bump)
    editor.on('update', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('update', bump)
    }
  }, [editor])

  // scope chip data, recomputed per render (the scope tick above keeps it fresh)
  const liveSelection = editor.state.selection
  const selectionText = liveSelection.empty
    ? ''
    : editor.state.doc.textBetween(liveSelection.from, liveSelection.to, '\n', ' ').trim()
  const hasScopeSelection = selectionText.length > 0

  /** the × on the scope chip: collapse the selection so the run targets the whole document */
  const clearScopeSelection = () => {
    editor.commands.setTextSelection(editor.state.selection.to)
  }

  /** [label](docnav://block/N) links in replies select and scroll to that block */
  const docNav = {
    scheme: DOC_NAV_SCHEME,
    onNavigate: (href: string) => {
      const index = parseDocNavHref(href)
      if (index !== null) navigateToBlock(editorRef.current, index)
    },
  }

  // follow the stream, but stop yanking once the user scrolls up to read;
  // `open` dep: re-expanding lands on messages streamed while collapsed
  useEffect(() => {
    if (chat.length === 0 && historicChat.length === 0) {
      logRef.current?.scrollTo({top:0})
    } else if (stickToBottomRef.current) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
    }
  }, [chat, open])

  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const run = () => runWith(input.trim())

  /** Image attachments are read as base64 and go multimodal with this user message (≤5MB per image, max 20) */
  const MAX_IMAGES_PER_MESSAGE = 20
  const collectImageAttachments = async (atts: AttachmentMeta[]): Promise<AgentImage[]> => {
    const imageAtts = atts.filter((a) => ATTACHMENT_IMAGE_EXTS.has(a.ext))
    const images: AgentImage[] = []
    const failures: string[] = []
    for (const att of imageAtts.slice(0, MAX_IMAGES_PER_MESSAGE)) {
      const result = await window.desktop.readAttachmentImage(att.path)
      if (result.ok && result.base64 && result.mime) {
        images.push({ base64: result.base64, mime: result.mime })
      } else {
        failures.push(result.error ?? t('aiImageReadFail', { name: att.name }))
      }
    }
    if (imageAtts.length > MAX_IMAGES_PER_MESSAGE) {
      failures.push(t('aiTooManyImages', { max: MAX_IMAGES_PER_MESSAGE }))
    }
    if (failures.length > 0) {
      setAttachNotice(failures.join(';'))
      window.setTimeout(() => setAttachNotice(null), 5000)
    }
    return images
  }

  const runWith = (
    instruction: string,
    displayInstruction = instruction,
    attachmentsOverride?: AttachmentMeta[],
  ) => {
    const loop = loopRef.current
    if (!instruction || !loop || loop.busy || pendingSendRef.current) return
    const researchMode=writerModeRef.current==='research'
    if(researchMode){
      try { instruction=publicQuery(instruction) } catch(e){setAttachNotice((e as Error).message);return}
      // Never share prior document turns or attached records with public research.
      loop.reset(); researchApprovalRef.current=''
    }
    setInput('')
    // The message consumes the composer attachments: they ride along (echoed on the
    // bubble, images multimodal, files via the files skill) and the composer clears.
    const sentAtts = researchMode ? [] : attachmentsOverride ?? attachmentsRef.current
    if (!attachmentsOverride && sentAtts.length > 0) {
      const seen = new Set(sentAttachmentsRef.current.map((a) => a.path))
      sentAttachmentsRef.current = [
        ...sentAttachmentsRef.current,
        ...sentAtts.filter((a) => !seen.has(a.path)),
      ]
      setAttachments([])
    }
    lastAttachmentsRef.current = sentAtts
    instructionRef.current = instruction
    lastInstructionRef.current = instruction
    runToolsRef.current = []
    ownershipRef.current!.begin()
    runSnapshotRef.current = null
    stickToBottomRef.current = true
    setChat((prev) => [
      ...prev,
      {
        role: 'user',
        text: displayInstruction,
        ...(sentAtts.length > 0 ? { attachments: sentAtts } : {}),
      },
      { role: 'assistant', text: '', streaming: true },
    ])
    runStartedAtRef.current = Date.now()
    setBusy(true)
    // claimed before the async image read so Stop / New chat can flag this send at any point
    const generation = currentDocGeneration()
    const pending = { aborted: false }
    pendingSendRef.current = pending
    persistMessage('user', instruction, undefined, sentAtts)
    // a rejected image read must not strand the run (busy would stay true forever): degrade to a no-image send
    void collectImageAttachments(sentAtts)
      .catch((): AgentImage[] => {
        setAttachNotice(t('aiImagesSendFailed'))
        window.setTimeout(() => setAttachNotice(null), 5000)
        return []
      })
      // a phased open still streaming its tail: the context must describe the whole document
      .then(async (images) => {
        if(researchMode) researchApprovalRef.current=await window.desktop.writerApproveResearch(instruction)
        else await waitForFullContent()
        // a newer send (after New chat) owns the panel now: leave its state alone
        if (pendingSendRef.current !== pending) return
        pendingSendRef.current = null
        // the wait ended because another document replaced this one, or the
        // user stopped / reset the chat meanwhile: nothing to run
        if (pending.aborted || currentDocGeneration() !== generation) {
          setChat((prev) =>
            prev.filter(
              (m, i) => !(i === prev.length - 1 && m.role === 'assistant' && m.streaming),
            ),
          )
          setBusy(false)
          return
        }
        return loop.run(instruction, images)
      }).catch((error:unknown)=>{
        if(pendingSendRef.current===pending)pendingSendRef.current=null
        patchLastAssistant({streaming:false,error:error instanceof Error?error.message:'The request could not start.'})
        setBusy(false)
      })
  }

  const cancel = () => {
    if (pendingSendRef.current) pendingSendRef.current.aborted = true
    loopRef.current?.cancel()
  }

  /** submit every still-anchored queued edit as one batch run */
  const sendQueue = () => {
    const loop = loopRef.current
    if (!loop || loop.busy || editQueue.length === 0) return
    const entries = liveItems(resolveQueue(editorRef.current, editQueue))
    if (entries.length === 0) {
      onQueueClear?.()
      return
    }
    const instruction = buildQueueInstruction(entries)
    const display = buildQueueSummary(t('aiQueueSubmitted', { count: entries.length }), entries)
    // consumed at send: the run rewrites the anchored passages, which would
    // orphan the anchors anyway; a failed run is retried via the retry action
    onQueueConsume?.(editQueue.map((item) => item.qid))
    runWith(instruction, display)
  }

  const retry = () =>
    runWith(lastInstructionRef.current, lastInstructionRef.current, lastAttachmentsRef.current)

  const continueRun = () => runWith(DOCS_CONTINUE_INSTRUCTION, t('aiContinue'))

  const newChat = () => {
    if (pendingSendRef.current) {
      pendingSendRef.current.aborted = true
      pendingSendRef.current = null
    }
    loopRef.current?.reset()
    setBusy(false)
    setChat([])
    // Restored history is painted above the live turn: without this the
    // previous conversation survives "New chat" on screen (#195).
    setHistoricChat([])
    // Unsent composer attachments would otherwise ride into the next chat's
    // file context (availableAttachments merges sent + live). The typed
    // draft itself is kept — only staged files are dropped.
    setAttachments([])
    setAttachNotice(null)
    sentAttachmentsRef.current = []
    inputRef.current?.focus()
  }

  const copyMessage = (text: string, idx: number) => {
    void navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    window.setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1200)
  }

  const mergeAttachments = (result: AttachmentAddResult | null) => {
    if (!result) return
    if (result.accepted.length > 0) {
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.path))
        return [...prev, ...result.accepted.filter((a) => !seen.has(a.path))]
      })
    }
    if (result.rejected.length > 0) {
      setAttachNotice(result.rejected.join(';'))
      window.setTimeout(() => setAttachNotice(null), 5000)
    }
  }

  const pickAttachments = async () => mergeAttachments(await window.desktop.pickAttachments())

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.desktop.getPathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) mergeAttachments(await window.desktop.addAttachmentPaths(paths))
  }

  /** Files pasted into the input: ones with a local path go through regular attachments; pure bitmaps like screenshots hit a temp file first */
  const onPasteFiles = async (files: File[]) => {
    const paths: string[] = []
    for (const f of files) {
      const p = window.desktop.getPathForFile(f)
      if (p) {
        paths.push(p)
        continue
      }
      const ext = PASTE_MIME_EXT[f.type] ?? f.name.split('.').pop()?.toLowerCase() ?? 'bin'
      mergeAttachments(await window.desktop.addPastedImage(await f.arrayBuffer(), ext))
    }
    if (paths.length > 0) mergeAttachments(await window.desktop.addAttachmentPaths(paths))
  }

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path))

  const acceptChanges = () => {
    applyRevisionsBy(editorRef.current, AI_REVISION_AUTHOR, 'accept')
    clearAiHighlights()
  }

  const toggleTrackChanges = () => {
    const next = !trackChanges
    setTrackChanges(next)
    localStorage.setItem(TRACK_CHANGES_KEY, next ? '1' : '0')
    // switching off keeps nothing pending: accept whatever is still highlighted
    if (!next) acceptChanges()
  }

  /** Restore a rollback point: the document, then notes / page setup / header-footer. */
  const restoreSnapshot = (snapshot: WriterSnapshot) => {
    editor.commands.setContent(snapshot.doc as never)
    if (snapshot.extras) docAccessRef.current?.restoreExtras?.(snapshot.extras)
  }

  const rollback = (entryIdx: number, snapshot: WriterSnapshot) => {
    if(!window.confirm('Restore the document to before this response? Later manual and assistant changes will also be replaced. Save a copy first to keep them.'))return
    restoreSnapshot(snapshot)
    // The document rewound to before this turn, so this and every later
    // rollback point now describe discarded futures
    setChat((prev) =>
      prev.map((e, i) => (i >= entryIdx && e.snapshot ? { ...e, snapshot: undefined } : e)),
    )
  }

  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanupRef.current?.(), [])

  /** drag the panel's right edge to resize; panel is flush with the window's left edge */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const resizer = e.currentTarget
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      const w = clampPanelWidth(window.innerWidth-ev.clientX)
      preferredWidthRef.current = w
      setPanelWidth(w)
    }
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizer.removeEventListener('lostpointercapture', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(preferredWidthRef.current)))
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    // lostpointercapture also fires if the resizer is unmounted mid-drag (panel collapse)
    resizer.addEventListener('lostpointercapture', cleanup)
    resizer.setPointerCapture(e.pointerId)
  }

  // collapsed: rail only — after all hooks, so the instance and its state survive
  if (!open) {
    return (
      <button
        className="ai-rail"
        data-tip={t('appExpandAiPanel')}
        aria-label={t('appExpandAiPanel')}
        onClick={onExpand}
      >
        <WriterMark size={22} />
      </button>
    )
  }

  return (
    <aside
      ref={asideRef}
      style={{ width: '100%' }}
      dir={isRtl ? 'rtl' : undefined}
      className={`ai-panel sw-assistant${dragOver ? ' ai-panel-dragover' : ''}${resizing ? ' ai-panel-resizing' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div
        className="ai-panel-resizer"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('aiPanelTitle')}
      />
      <AssistantHeader kind="Documents" busy={busy} onNew={newChat} onCollapse={onCollapse} onConnection={openConnection}/>

      <div className="sw-mode-tabs" role="tablist" aria-label="Assistant task">
        {([...(window.__officeWeb?.canWrite===false?['ask','review']:['write','ask','review']),...(researchConfigured?['research']:[])] as WriterMode[]).map(mode=><button type="button" role="tab" key={mode} aria-selected={writerMode===mode} disabled={busy} title={WRITER_MODE_NOTE[mode]} onClick={()=>changeWriterMode(mode)}>{mode==='write'?'Edit':mode[0]!.toUpperCase()+mode.slice(1)}</button>)}
      </div>
      {chat.length === 0 && historicChat.length === 0 && <div className="sw-mode-note">{WRITER_MODE_NOTE[writerMode]}</div>}
      <div ref={logRef} className="ai-chat" onScroll={onLogScroll}>
        {/* past conversation (read-only transcript, not fed to the model), shown continuously with the current turn */}
        {historicChat.length > 0 && (
          <>
            {historicChat.map((entry, i) => (
              <div key={`h${i}`} className={`ai-msg ai-msg-${entry.role} ai-msg-historic`}>
                {entry.role === 'user' && entry.attachments && entry.attachments.length > 0 && (
                  <SentAttachments atts={entry.attachments} previews={attachmentPreviews} />
                )}
                {entry.tools && entry.tools.length > 0 && <AssistantActivity tools={entry.tools} active={!!entry.streaming}/>}
                {entry.text && (
                  <div dir="auto">
                    <AssistantMessage role={entry.role} text={entry.text} nav={docNav} />
                  </div>
                )}
              </div>
            ))}
            <div className="ai-history-sep">{t('aiHistorySep')}</div>
          </>
        )}
        {chat.length === 0 && historicChat.length === 0 && (
          <AssistantStarters app="docs" mode={writerMode} selected={hasScopeSelection} onChoose={(s)=>{setInput(s);inputRef.current?.focus()}}/>
        )}
        {groupMessages(chat).map(({entry, index:i, key:groupKey}) => {
          if (
            entry.role === 'assistant' &&
            !entry.text &&
            !entry.streaming &&
            !entry.error &&
            !entry.tools?.length
          ) {
            return null
          }
          const isLast = i === chat.length - 1
          // Action row appears once per completed reply: on the turn's final segment only
          // (mid-turn segments have a following assistant entry; the live turn ends when !busy)
          const nextEntry = chat[i + 1]
          const turnEnded = nextEntry ? nextEntry.role === 'user' : !busy
          const showToolbar =
            entry.role === 'assistant' &&
            !entry.streaming &&
            turnEnded &&
            // edits-only turns have no text but still carry the rollback point
            !!(entry.text || entry.error || entry.snapshot)
          return (
            <div
              key={groupKey}
              className={`ai-msg ai-msg-${entry.role}${entry.role === 'assistant' && entry.streaming ? ' ai-msg-streaming' : ''}`}
            >
              {entry.role === 'user' && entry.attachments && entry.attachments.length > 0 && (
                <SentAttachments atts={entry.attachments} previews={attachmentPreviews} />
              )}
              {entry.role === 'assistant' && (entry.reasoning || entry.status) && (
                <AssistantReasoning text={entry.reasoning} status={entry.status} active={!!entry.streaming && !entry.text} />
              )}
              {entry.role === 'assistant' && !entry.text && entry.streaming ? (
                <span className="ai-typing-row">
                  <AssistantWorking />
                </span>
              ) : entry.role === 'assistant' ? (
                <div dir="auto">
                  <AssistantMessage role={entry.role} text={entry.text} nav={docNav} />
                </div>
              ) : (
                <span dir="auto">{entry.text}</span>
              )}
              {entry.tools && entry.tools.length > 0 && <AssistantActivity tools={entry.tools} active={!!entry.streaming}/>}
              {entry.error && (
                <div className="ai-msg-error">{t('aiErrorPrefix', { error: entry.error })}</div>
              )}
              {entry.loginRequired && (
                <button className="ai-login-btn" onClick={openConnection}>
                  Connection settings
                </button>
              )}
              {showToolbar && (
                <div className="ai-msg-toolbar">
                  {entry.text && (
                    <button
                      className="ai-msg-tool-btn"
                      onClick={() => copyMessage(entry.text, i)}
                      aria-label={t('aiCopyReplyTitle')}
                      data-tip={t('aiCopyReplyTitle')}
                    >
                      {copiedIdx === i ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                          <path
                            d="M14.6113 5.34253C16.0608 5.3428 17.2363 6.518 17.2363 7.96753V15.5066C17.2361 16.956 16.0607 18.1313 14.6113 18.1316H7.07227C5.62267 18.1316 4.44751 16.9561 4.44727 15.5066V7.96753C4.44732 6.51783 5.62255 5.34253 7.07227 5.34253H14.6113ZM7.07227 6.59253C6.31291 6.59253 5.69732 7.20819 5.69727 7.96753V15.5066C5.69751 16.2658 6.31302 16.8816 7.07227 16.8816H14.6113C15.3703 16.8813 15.9861 16.2656 15.9863 15.5066V7.96753C15.9863 7.20835 15.3705 6.5928 14.6113 6.59253H7.07227ZM10.0176 2.8689C10.3626 2.86905 10.6426 3.14882 10.6426 3.4939C10.6425 3.83888 10.3626 4.11874 10.0176 4.1189H4.59961C3.84022 4.1189 3.22461 4.73451 3.22461 5.4939V11.324C3.22433 11.6689 2.94461 11.949 2.59961 11.949C2.25461 11.949 1.97489 11.6689 1.97461 11.324V5.4939C1.97461 4.04415 3.14987 2.8689 4.59961 2.8689H10.0176Z"
                            fill="currentColor"
                          />
                        </svg>
                      )}
                    </button>
                  )}
                  {isLast && !busy && lastInstructionRef.current && (
                    <button
                      className="ai-msg-tool-btn"
                      onClick={retry}
                      aria-label={t('aiRegenerateTitle')}
                      data-tip={t('aiRegenerateTitle')}
                    >
                      {/* 24-canvas glyph at 18px (near-full-bleed paths, sized for optical
                          parity with the copy icon): stroke 1.5 paints 1.125px (1:16) */}
                      <svg
                        style={{ width: 18, height: 18 }}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M3.68881 9.85339C4.1791 8.0054 5.28205 6.30704 6.9459 5.09101C10.8046 2.27085 16.2188 3.11279 19.0389 6.97147C19.7242 7.90904 20.1932 8.93842 20.4553 10.0001" />
                        <path d="M2.00452 8.46411L2.87229 10.7059C2.96814 10.9535 3.24658 11.0765 3.4942 10.9807L5.73594 10.1129" />
                        <path d="M20.3308 14.4908C19.8405 16.3388 18.7376 18.0372 17.0738 19.2532C13.215 22.0734 7.80083 21.2314 4.98071 17.3728C4.22167 16.3342 3.72792 15.183 3.48686 13.9999" />
                        <path d="M22.0151 15.8801L21.1474 13.6384C21.0515 13.3908 20.7731 13.2677 20.5255 13.3636L18.2837 14.2314" />
                      </svg>
                    </button>
                  )}
                  {entry.snapshot && (
                    <>
                      {/* hairline between reply actions (icons) and the document action (icon+label);
                          CSS shows it only when an icon button actually precedes it */}
                      <span className="ai-rollback-sep" aria-hidden />
                      <RollbackButton
                        disabled={busy}
                        onClick={() => rollback(groupKey, entry.snapshot!)}
                      />
                    </>
                  )}
                </div>
              )}
              {writerMode==='research' && isLast && !busy && entry.role==='assistant' && !!entry.text && !entry.error && <button className="ai-continue-btn" onClick={()=>{const notes=entry.text;changeWriterMode('write');setInput(`Use the following public research notes to draft the requested section. These are research synthesis, not verified quotations; preserve the original source links and flag points needing original-source verification.

[Specify the section and purpose]

${notes}`);inputRef.current?.focus()}}>Use in writing</button>}
              {entry.turnLimit && isLast && !busy && (
                <button className="ai-continue-btn" onClick={continueRun}>
                  {t('aiContinue')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <JumpToLatest targetRef={logRef} followRef={stickToBottomRef}/>
      <div className="ai-composer">
        <OfficeTaskControls
          app="writer" document={filePath ?? 'untitled'} mode={writerMode}
          loop={loopRef.current} busy={busy} onSend={runWith} onStop={cancel}
        />
        {!(hasScopeSelection) && <AssistantContext label={scopeLabel('docs',{})} busy={busy}/>}
        {attachNotice && <div className="ai-attach-notice">{attachNotice}</div>}
        {writerMode==='write' && <EditQueueCard
          items={editQueue}
          editor={editor}
          busy={busy}
          onEditInstruction={(qid, text) => onQueueEditInstruction?.(qid, text)}
          onRemove={(qid) => onQueueRemove?.(qid)}
          onDiscardAll={() => onQueueClear?.()}
          onSend={sendQueue}
          onFocus={(qid) => onQueueFocus?.(qid)}
        />}
        <AiComposer
          header={
            writerMode!=='research' && (hasScopeSelection || attachments.length > 0) && (
              <>
                {hasScopeSelection && (
                  <div className="ai-scope-row">
                    <span className="ai-scope-hint">
                      <button
                        type="button"
                        className="ai-scope-label"
                        onClick={() => setScopePreviewOpen((v) => !v)}
                        aria-expanded={scopePreviewOpen}
                        data-tip={t('aiScopeSelectionTip')}
                      >
                        {t('aiScopeSelection', { words: countWords(selectionText) })}
                      </button>
                      <button
                        type="button"
                        className="ai-scope-clear"
                        onClick={clearScopeSelection}
                        data-tip={t('aiScopeClearTitle')}
                        aria-label={t('aiScopeClearTitle')}
                      >
                        <svg width="12" height="12" viewBox="0 0 32 32" aria-hidden>
                          <path
                            d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    </span>
                    {scopePreviewOpen && (
                      <div className="ai-scope-preview">
                        {selectionText.length > 400
                          ? `${selectionText.slice(0, 400)}…`
                          : selectionText}
                      </div>
                    )}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="ai-attachments" onScroll={onAttachmentsScroll}>
                    {attachments.map((a) =>
                      ATTACHMENT_IMAGE_EXTS.has(a.ext) ? (
                        <span key={a.path} className="ai-attachment-thumb" data-tip={a.path}>
                          {attachmentPreviews[a.path] ? (
                            <img src={attachmentPreviews[a.path]} alt={a.name} />
                          ) : (
                            <span className="ai-attachment-thumb-pending" aria-hidden>
                              <img src={fileImageIcon} alt="" />
                            </span>
                          )}
                          <button
                            className="ai-attachment-thumb-remove"
                            onClick={() => removeAttachment(a.path)}
                            data-tip={t('aiRemoveAttachmentTitle')}
                            aria-label={t('aiRemoveAttachmentTitle')}
                          >
                            <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden>
                              <path
                                d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                                fill="currentColor"
                                stroke="currentColor"
                                strokeWidth="0.25"
                              />
                            </svg>
                          </button>
                        </span>
                      ) : (
                        <span key={a.path} className="ai-attachment-card" data-tip={a.path}>
                          <span className="ai-attachment-card-icon">
                            <AttachmentCardIcon ext={a.ext} />
                          </span>
                          <span className="ai-attachment-card-meta">
                            <span className="ai-attachment-card-name">
                              {truncateCardName(a.name)}
                            </span>
                            <span className="ai-attachment-card-size">
                              {formatAttachmentSize(a.sizeBytes)}
                            </span>
                          </span>
                          <button
                            className="ai-attachment-thumb-remove"
                            onClick={() => removeAttachment(a.path)}
                            data-tip={t('aiRemoveAttachmentTitle')}
                            aria-label={t('aiRemoveAttachmentTitle')}
                          >
                            <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden>
                              <path
                                d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                                fill="currentColor"
                                stroke="currentColor"
                                strokeWidth="0.25"
                              />
                            </svg>
                          </button>
                        </span>
                      ),
                    )}
                  </div>
                )}
              </>
            )
          }
          value={input}
          busy={busy}
          placeholder={writerMode==='research'?'Enter a public research question (up to 200 characters)…':writerMode==='write'?'Describe what to draft or change…':writerMode==='review'?'What should I check in this draft?':'Ask about the document or selection…'}
          hintIdle={t('aiHintIdle')}
          hintBusy={t('aiHintBusy')}
          hintIdleTitle={t('aiHintIdleTitle')}
          sendLabel={t('aiSend')}
          stopLabel={t('aiStop')}
          iconOnly
          sendIconEnabled={<AssistantIcon name="arrow"/>}
          sendIconDisabled={<AssistantIcon name="arrow"/>}
          stopIcon={<AssistantIcon name="stop"/>}
          textareaRef={inputRef}
          onChange={setInput}
          onSend={run}
          onStop={cancel}
          onPasteFiles={(files) => {if(writerMode!=='research')void onPasteFiles(files)}}
          footerStart={
            <>
              <button
                className="ai-attach-btn"
                disabled={writerMode==='research'||busy}
                onClick={pickAttachments}
                data-tip={t('aiAttachTitle')}
                aria-label={t('aiAttachTitle')}
              >
                <img src={attachIcon} alt="" aria-hidden />
              </button>
              {dictation.supported && (
                <button
                  type="button"
                  className={`ai-mic-btn${dictation.state === 'recording' ? ' recording' : ''}${dictation.state === 'transcribing' ? ' busy' : ''}`}
                  disabled={busy || dictation.state === 'transcribing'}
                  onClick={() => { if (dictation.state === 'recording') void dictation.stop(); else void dictation.start() }}
                  data-tip={dictation.error ?? (dictation.state === 'recording' ? 'Stop & transcribe' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Dictate')}
                  aria-label={dictation.state === 'recording' ? 'Stop recording' : 'Dictate'}
                >
                  {dictation.state === 'transcribing' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></svg>
                  ) : dictation.state === 'recording' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z" fill="currentColor"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                  )}
                </button>
              )}
              <button
                className={`ai-track-btn${trackChanges ? ' on' : ''}`}
                onClick={toggleTrackChanges}
                disabled={writerMode!=='write'||busy}
                data-tip={trackChanges ? t('aiTrackOnTitle') : t('aiTrackOffTitle')}
              >
                <span className="ai-track-dot" aria-hidden />
                {t('aiTrackChanges')}
              </button>
            </>
          }
        />
        <AssistantOptions><select aria-label="Work depth" value={writerProfile} disabled={busy} onChange={e=>changeWriterProfile(profileName(e.target.value))}><option value="standard">Standard</option><option value="thorough">Thorough</option></select></AssistantOptions>
      </div>
    </aside>
  )
}

/** Tool row list (unified with slides/sheets): dot + summary; expandable details when there's output; arrow shows on hover */
/** Step-row status icons (timeline glyphs: 14px in a 20px slot, 1.6 stroke) */
function StepIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.5 3.5h11M6.5 20.5h11M8 3.5v3.2c0 2.6 4 4.2 4 5.3 0 1.1 4 2.7 4 5.3v3.2M16 3.5v3.2c0 2.6-4 4.2-4 5.3 0 1.1-4 2.7-4 5.3v3.2" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.4 2.4 2.4 4.6-5" />
    </svg>
  )
}

/** Quiet roll-back action in the message toolbar: restores the document to before the run's edits */
function RollbackButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t: tr } = useI18n()
  return (
    <button type="button" className="ai-rollback-btn" disabled={disabled} onClick={onClick}>
      {/* 24-canvas glyph at 18px (optical parity with the toolbar icons): stroke 1.5 paints 1.125px (1:16) */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5.91026 4L2.5 7.14791L5.91026 10.8205" />
        <path d="M3.96154 7.41028H15.1636C18.5169 7.41028 21.3646 10.1484 21.4953 13.5C21.6334 17.0416 18.707 20.0769 15.1636 20.0769H6.88384" />
      </svg>
      {tr('aiRollback')}
    </button>
  )
}

/** Tool activity group: a single quiet summary row
 *  that auto-opens while tools run, auto-collapses into "Worked · N steps" when they finish,
 *  and a manual toggle that always wins. Rows inside are step rows with 1px connectors. */
function ToolChipList({ tools }: { tools: ToolActivity[] }) {
  const { t: tr } = useI18n()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  const toggle = (j: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(j)) next.delete(j)
      else next.add(j)
      return next
    })
  }

  const anyRunning = tools.some((tool) => tool.running)
  const open = userOpen ?? anyRunning
  const label = anyRunning ? tr('aiGroupWorking') : tr('aiWorkedSteps', { n: tools.length })

  return (
    <div className="ai-work-group">
      <button
        type="button"
        className={`ai-work-group-summary${anyRunning ? ' running' : ''}`}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        {anyRunning && !open && <span className="ai-tool-chip-spinner" aria-hidden />}
        <span className="ai-work-group-label">{label}</span>
        <span className={`ai-tool-chip-caret${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      <div className={`ai-work-group-body${open ? ' open' : ''}`}>
        <div className="ai-work-group-body-inner">
          {tools.map((tool, j) => {
            const hasOutput = !tool.running && !!tool.output
            const isOpen = expanded.has(j)
            const stepStatus = tool.running ? 'running' : tool.isError ? 'error' : 'done'
            return (
              <div key={j} className="ai-step-row">
                <span className={`ai-step-icon ${stepStatus}`} aria-hidden>
                  <StepIcon status={stepStatus} />
                </span>
                <div className="ai-step-content">
                  {hasOutput ? (
                    <button
                      type="button"
                      className="ai-step-title clickable"
                      data-tip={tool.name}
                      aria-expanded={isOpen}
                      onClick={() => toggle(j)}
                    >
                      {tool.summary}
                    </button>
                  ) : (
                    <span className="ai-step-title" data-tip={tool.name}>
                      {tool.summary}
                    </span>
                  )}
                  {hasOutput && isOpen && (
                    <div className="ai-step-detail">
                      <div className="ai-tool-output">
                        <div className="ai-tool-output-pre">{tool.output}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
