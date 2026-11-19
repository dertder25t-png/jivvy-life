export type TabType = 'web' | 'note' | 'jivvy' | 'dashboard';

import type { LayoutMode } from './layout';
export type { LayoutMode, ZenBarPosition } from './layout';

export type ContextTag = 'dashboard' | 'school' | 'work' | 'dev' | 'personal';

export interface WorkspaceTab {
  id: string;
  title: string;
  type: TabType;
  url?: string;
  noteId?: string;
  pinned?: boolean;
  favicon?: string;
  folderId?: string;
  lastActiveAt: string;
}

export interface TabFolder {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface WorkspaceManifest {
  id: string;
  name: string;
  contextTag: ContextTag;
  layout: 'single' | 'split-vertical';
  primaryTabId: string | null;
  secondaryTabId: string | null;
  tabs: WorkspaceTab[];
  folders?: TabFolder[];
  updatedAt: string;
}

export interface NoteDocument {
  id: string;
  title: string;
  content: string;
  tags: string[];
  wikilinks: string[];
  contextId?: string;
  updatedAt: string;
}

export interface ActivityContext {
  id: string;
  label: string;
  tag: ContextTag;
}

export interface TelemetryEvent {
  id: string;
  deviceId: string;
  eventType: 'tab_focused' | 'transition' | 'idle_start' | 'idle_end' | 'verified_outcome';
  activityContextId?: string;
  workspaceId?: string;
  tabId?: string;
  domain?: string;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ImportedWorkspaceGroup {
  folderName: string;
  selected: boolean;
  tabs: Array<{ title: string; url: string }>;
}

export interface ImportResult {
  workspaces: ImportedWorkspaceGroup[];
  notes: NoteDocument[];
  topDomains: Array<{ domain: string; visits: number }>;
}
