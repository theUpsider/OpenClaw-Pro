import type { BoardGetParams } from "@openclaw/gateway-protocol";
/** Semantic host components available to native Control UI plugins. */
export type ControlUiComponentHandle<T> = {
  update: (props: T) => void;
  dispose: () => void;
};

export type ControlUiDialogProps = {
  label: string;
  description?: string;
  className?: string;
  style?: string;
  /** The plugin retains rendering ownership of this node. */
  content: HTMLElement;
  returnFocusTarget?: HTMLElement | null;
  /** Returning false keeps the dialog open, for example during a pending save. */
  onCancel: () => boolean | void;
};

export type ControlUiAgentAvatarProps = {
  /** An empty string uses the host's default agent. */
  agentId: string;
  label: string;
};

export type ControlUiAgentPickerProps = {
  options: readonly {
    value: string;
    label: string;
    description?: string;
    badge?: string;
    disabled?: boolean;
    agent?: { id: string };
    icon?: "bot" | "users";
  }[];
  value: string;
  placeholder?: string;
  accessibleLabel: string;
  menuLabel?: string;
  variant?: "default" | "compact";
  disabled?: boolean;
  onSelect: (value: string) => void;
};

export type ControlUiSessionSummaryProps = {
  session: BoardGetParams;
  presented: boolean;
};

export type ControlUiDashboardProps = {
  session: BoardGetParams;
  canMutate: boolean;
  canGrant: boolean;
  presented?: boolean;
};

export type ControlUiSelectPickerProps = {
  options: readonly {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  }[];
  value: string;
  accessibleLabel: string;
  searchable?: boolean;
  disabled?: boolean;
  onSelect: (value: string) => void;
};

export type ControlUiAppearanceGlyphProps = {
  icon: string | null;
  color: string | null;
  fallback: string;
};

export type ControlUiAppearancePickerProps = {
  icon: string | null;
  color: string | null;
  disabled?: boolean;
  /** Disable clearing when the owner's existing storage contract requires a value. */
  clearable?: boolean;
  onChange: (appearance: { icon: string | null; color: string | null }) => void;
};

/**
 * The host's dictation microphone. Recording, transcription, device choice and
 * availability reasons are the composer's; the plugin receives only final text.
 */
export type ControlUiDictationControlProps = {
  /** False renders the microphone disabled with `disabledReason` as its tooltip. */
  enabled: boolean;
  disabledReason?: string;
  accessibleLabel: string;
  /** Runs synchronously when capture begins, before any transcript exists. */
  onStart?: () => void;
  /** Final trimmed transcript; empty dictation never calls it. */
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onStateChange?: (state: { active: boolean }) => void;
};

/**
 * The host composer's model picker and thinking selector for one conversation.
 * Catalog, defaults, access checks and applying a choice to the session are the
 * host's; the plugin names only the target.
 */
export type ControlUiComposerSessionControlsProps = {
  /** Null renders the agent's defaults disabled, for a conversation not created yet. */
  sessionKey: string | null;
  agentId?: string;
  /** Disables changes; the reason becomes the controls' tooltip. */
  disabledReason?: string;
  /** A model or thinking change the Gateway rejected. */
  onError?: (message: string) => void;
};

/**
 * The host composer's primary send action for one conversation: its label,
 * tooltip, disabled rules and send, queue or steer choice. The plugin sends.
 */
export type ControlUiComposerSendActionProps = {
  /** Null sends a first turn into a conversation the plugin creates on send. */
  sessionKey: string | null;
  agentId?: string;
  draft: string;
  sending?: boolean;
  /** Refuses sending; the reason becomes the tooltip and accessible label. */
  disabledReason?: string;
  /** Id of plugin text that describes the action. */
  describedBy?: string;
  /**
   * Runs after pending model and thinking changes for this conversation settle.
   * `followUpMode` is the delivery for a running conversation and is undefined
   * when nothing runs; pass it as `chat.send` `queueMode` only when set.
   */
  onSend: (followUpMode: "steer" | "followup" | "collect" | "interrupt" | undefined) => void;
};

/**
 * The host's Markdown renderer. Parsing, sanitizing and presentation are the
 * host's; the plugin passes only the authored source text.
 */
export type ControlUiMarkdownProps = {
  markdown: string;
  class?: string;
  mode?: "document" | "message";
  codeBlockChrome?: "copy" | "none";
  /** Render one line as phrasing content (no block wrapper), for labels inside controls. */
  inline?: boolean;
};

export type ControlUiComponents = {
  /** Resolve a shared palette or custom hex color; invalid or cleared values return an empty string. */
  resolveAppearanceColor: (value: string | null | undefined) => string;
  mountAgentAvatar: (
    container: HTMLElement,
    props: ControlUiAgentAvatarProps,
  ) => ControlUiComponentHandle<ControlUiAgentAvatarProps>;
  mountAppearancePicker: (
    container: HTMLElement,
    props: ControlUiAppearancePickerProps,
  ) => ControlUiComponentHandle<ControlUiAppearancePickerProps>;
  mountAppearanceGlyph: (
    container: HTMLElement,
    props: ControlUiAppearanceGlyphProps,
  ) => ControlUiComponentHandle<ControlUiAppearanceGlyphProps>;
  mountDialog: (
    container: HTMLElement,
    props: ControlUiDialogProps,
  ) => ControlUiComponentHandle<ControlUiDialogProps>;
  mountAgentPicker: (
    container: HTMLElement,
    props: ControlUiAgentPickerProps,
  ) => ControlUiComponentHandle<ControlUiAgentPickerProps>;
  mountSelectPicker: (
    container: HTMLElement,
    props: ControlUiSelectPickerProps,
  ) => ControlUiComponentHandle<ControlUiSelectPickerProps>;
  mountSessionSummary: (
    container: HTMLElement,
    props: ControlUiSessionSummaryProps,
  ) => ControlUiComponentHandle<ControlUiSessionSummaryProps>;
  mountDashboard: (
    container: HTMLElement,
    props: ControlUiDashboardProps,
  ) => ControlUiComponentHandle<ControlUiDashboardProps>;
  mountDictationControl: (
    container: HTMLElement,
    props: ControlUiDictationControlProps,
  ) => ControlUiComponentHandle<ControlUiDictationControlProps>;
  mountComposerSessionControls: (
    container: HTMLElement,
    props: ControlUiComposerSessionControlsProps,
  ) => ControlUiComponentHandle<ControlUiComposerSessionControlsProps>;
  mountComposerSendAction: (
    container: HTMLElement,
    props: ControlUiComposerSendActionProps,
  ) => ControlUiComponentHandle<ControlUiComposerSendActionProps>;
  mountMarkdown: (
    container: HTMLElement,
    props: ControlUiMarkdownProps,
  ) => ControlUiComponentHandle<ControlUiMarkdownProps>;
};
