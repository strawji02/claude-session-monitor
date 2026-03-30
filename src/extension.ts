import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

const STATE_DIR = path.join(os.homedir(), ".claude", "session-monitor");

type SessionState = "working" | "done" | "waiting" | "blocked";

interface SessionInfo {
  pid: string;
  termPid?: string;
  state: SessionState;
  cwd: string;
  worktree: string;
  branch?: string;
  label?: string;
  message?: string;
  timestamp: number;
}

interface TrackedSession {
  info: SessionInfo;
  terminal?: vscode.Terminal;
  acknowledged?: boolean;
}

const STATE_ICONS: Record<SessionState, string> = {
  working: "sync~spin",
  done: "check",
  waiting: "bell",
  blocked: "shield",
};

const STATE_THEME_ICONS: Record<SessionState, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon(
    "sync~spin",
    new vscode.ThemeColor("charts.blue"),
  ),
  done: new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.yellow")),
  waiting: new vscode.ThemeIcon("bell", new vscode.ThemeColor("charts.yellow")),
  blocked: new vscode.ThemeIcon("shield", new vscode.ThemeColor("charts.red")),
};

const STATE_LABELS: Record<SessionState, string> = {
  working: "작업 중",
  done: "완료",
  waiting: "입력 대기",
  blocked: "권한 대기",
};

// --- Session Store ---

const sessions = new Map<string, TrackedSession>();
const terminalPidCache = new Map<vscode.Terminal, number>();
const localTerminalPids = new Set<number>();

// --- TreeItem Cache (reveal needs same instances) ---

const cachedSessionItems = new Map<string, SessionItem>();
const cachedWorktreeGroups = new Map<string, WorktreeGroup>();
let activeTerminalSessionPid: string | undefined;

// --- TreeView ---

type TreeItemType = WorktreeGroup | SessionItem;

class WorktreeGroup extends vscode.TreeItem {
  constructor(
    public readonly worktree: string,
    public readonly sessionPids: string[],
  ) {
    super(worktree, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "worktreeGroup";
    this.iconPath = new vscode.ThemeIcon("folder");

    const hasAttention = sessionPids.some((pid) => {
      const s = sessions.get(pid);
      return (
        s &&
        !s.acknowledged &&
        (s.info.state === "waiting" ||
          s.info.state === "blocked" ||
          s.info.state === "done")
      );
    });
    if (hasAttention) {
      this.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor("charts.yellow"),
      );
    }
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: TrackedSession,
    public readonly isActive: boolean,
  ) {
    const info = session.info;
    const label = info.label || info.branch || info.worktree;
    super(label, vscode.TreeItemCollapsibleState.None);

    if (session.acknowledged) {
      this.iconPath = new vscode.ThemeIcon(
        STATE_ICONS[info.state].replace("~spin", ""),
        new vscode.ThemeColor("disabledForeground"),
      );
    } else {
      this.iconPath = STATE_THEME_ICONS[info.state];
    }

    // Description: active indicator + message
    const activePrefix = isActive ? "► " : "";
    this.description = `${activePrefix}${info.message || STATE_LABELS[info.state]}`;

    this.tooltip = new vscode.MarkdownString(
      `**${STATE_LABELS[info.state]}**${isActive ? " (active)" : ""}\n\n` +
        `- Branch: \`${info.branch || "N/A"}\`\n` +
        `- Path: \`${info.cwd}\`\n` +
        `- PID: ${info.pid}`,
    );
    this.contextValue = "session";

    this.command = {
      command: "claude-session-monitor.showSession",
      title: "Show Terminal",
      arguments: [info.pid],
    };
  }
}

class SessionTreeProvider implements vscode.TreeDataProvider<TreeItemType> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeItemType | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    // Clear caches so getChildren rebuilds
    cachedSessionItems.clear();
    cachedWorktreeGroups.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItemType): vscode.TreeItem {
    return element;
  }

  getParent(element: TreeItemType): TreeItemType | undefined {
    if (element instanceof SessionItem) {
      const wt = element.session.info.worktree;
      return cachedWorktreeGroups.get(wt);
    }
    return undefined;
  }

  getChildren(element?: TreeItemType): TreeItemType[] {
    if (!element) {
      const groups = new Map<string, string[]>();
      for (const [pid] of sessions) {
        const wt = sessions.get(pid)!.info.worktree;
        if (!groups.has(wt)) groups.set(wt, []);
        groups.get(wt)!.push(pid);
      }

      const sortedWorktrees = [...groups.keys()].sort();

      // Single worktree: no grouping
      if (sortedWorktrees.length <= 1 && sortedWorktrees.length > 0) {
        const pids = groups.get(sortedWorktrees[0])!;
        return pids.sort().map((pid) => {
          const item = new SessionItem(
            sessions.get(pid)!,
            pid === activeTerminalSessionPid,
          );
          cachedSessionItems.set(pid, item);
          return item;
        });
      }

      return sortedWorktrees.map((wt) => {
        const group = new WorktreeGroup(wt, groups.get(wt)!);
        cachedWorktreeGroups.set(wt, group);
        return group;
      });
    }

    if (element instanceof WorktreeGroup) {
      return element.sessionPids.sort().map((pid) => {
        const item = new SessionItem(
          sessions.get(pid)!,
          pid === activeTerminalSessionPid,
        );
        cachedSessionItems.set(pid, item);
        return item;
      });
    }

    return [];
  }
}

// --- StatusBar (summary) ---

let summaryStatusBar: vscode.StatusBarItem;

function updateSummaryStatusBar() {
  let working = 0;
  let attention = 0;

  for (const [, session] of sessions) {
    if (session.info.state === "working") working++;
    if (
      !session.acknowledged &&
      (session.info.state === "waiting" ||
        session.info.state === "blocked" ||
        session.info.state === "done")
    )
      attention++;
  }

  if (sessions.size === 0) {
    summaryStatusBar.hide();
    return;
  }

  const parts: string[] = [];
  if (working > 0) parts.push(`$(sync~spin) ${working}`);
  if (attention > 0) parts.push(`$(bell) ${attention}`);

  summaryStatusBar.text = `$(hubot) ${parts.length > 0 ? parts.join(" ") : sessions.size}`;
  summaryStatusBar.tooltip = `Claude Sessions: ${sessions.size}개\n작업 중: ${working} | 알림: ${attention}\n클릭하여 패널 열기`;
  summaryStatusBar.backgroundColor =
    attention > 0
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  summaryStatusBar.show();
}

// --- Core Logic ---

let watcher: fs.FSWatcher | undefined;
let treeProvider: SessionTreeProvider;
let treeView: vscode.TreeView<TreeItemType>;

function findSessionByTerminal(terminal: vscode.Terminal): string | undefined {
  for (const [pid, session] of sessions) {
    if (session.terminal === terminal) return pid;
  }
  return undefined;
}

async function revealSessionInTree(pid: string) {
  const item = cachedSessionItems.get(pid);
  if (item && treeView.visible) {
    try {
      await treeView.reveal(item, { select: true, focus: false, expand: true });
    } catch {
      // TreeItem might be stale, refresh and retry
    }
  }
}

async function focusWorktreeSCM(cwd: string) {
  // Find workspace folder matching this worktree
  const folder = vscode.workspace.workspaceFolders?.find((f) =>
    cwd.startsWith(f.uri.fsPath),
  );
  if (!folder) return;

  // Open a file from that folder to trigger SCM context switch
  try {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "package.json"),
      null,
      1,
    );
    if (files.length > 0) {
      await vscode.window.showTextDocument(files[0], {
        preview: true,
        preserveFocus: true,
      });
    }
  } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // TreeView
  treeProvider = new SessionTreeProvider();
  treeView = vscode.window.createTreeView("claudeSessionMonitor", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Summary StatusBar
  summaryStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  summaryStatusBar.command = "claudeSessionMonitor.focus";
  context.subscriptions.push(summaryStatusBar);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claude-session-monitor.showSession",
      async (pid: string) => {
        const session = sessions.get(pid);
        if (!session) return;

        session.acknowledged = true;
        refreshAll();

        if (session.terminal) {
          session.terminal.show();
        } else {
          const terminal = await findTerminalForSession(session.info);
          if (terminal) {
            session.terminal = terminal;
            terminal.show();
          } else {
            vscode.window.showWarningMessage(
              `터미널을 찾을 수 없습니다: ${session.info.worktree}`,
            );
            return;
          }
        }

        // Focus SCM to matching worktree
        focusWorktreeSCM(session.info.cwd);
      },
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.focus", () => {
      vscode.commands.executeCommand("claudeSessionMonitor.focus");
    }),
  );

  // Terminal tracking
  vscode.window.onDidOpenTerminal(
    (t) => cacheTerminalPid(t),
    null,
    context.subscriptions,
  );
  vscode.window.onDidCloseTerminal(
    (terminal) => {
      const pid = terminalPidCache.get(terminal);
      if (pid) localTerminalPids.delete(pid);
      terminalPidCache.delete(terminal);

      for (const [sessionPid, session] of sessions) {
        if (session.terminal === terminal) {
          sessions.delete(sessionPid);
          try {
            fs.unlinkSync(path.join(STATE_DIR, `${sessionPid}.json`));
          } catch {}
          refreshAll();
          break;
        }
      }
    },
    null,
    context.subscriptions,
  );

  // Terminal focus → TreeView sync
  vscode.window.onDidChangeActiveTerminal(
    (terminal) => {
      if (!terminal) {
        activeTerminalSessionPid = undefined;
        refreshAll();
        return;
      }

      const pid = findSessionByTerminal(terminal);
      if (pid && pid !== activeTerminalSessionPid) {
        activeTerminalSessionPid = pid;
        refreshAll();

        // Wait for tree to rebuild, then reveal
        setTimeout(() => revealSessionInTree(pid), 150);
      }
    },
    null,
    context.subscriptions,
  );

  // Init
  cleanStaleFiles();
  const initPromises = vscode.window.terminals.map((t) => cacheTerminalPid(t));
  Promise.all(initPromises).then(() => {
    loadAllStates();
    refreshAll();

    // Set initial active terminal
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
      const pid = findSessionByTerminal(activeTerminal);
      if (pid) {
        activeTerminalSessionPid = pid;
        refreshAll();
      }
    }
  });

  // File watcher
  watcher = fs.watch(STATE_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith(".json")) return;
    const filePath = path.join(STATE_DIR, filename);

    setTimeout(() => {
      if (eventType === "rename") {
        if (fs.existsSync(filePath)) {
          loadStateFile(filePath);
        } else {
          const pid = filename.replace(".json", "");
          sessions.delete(pid);
        }
      } else if (eventType === "change") {
        loadStateFile(filePath);
      }
      refreshAll();
    }, 100);
  });

  // Periodic cleanup
  const cleanup = setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (const [pid, session] of sessions) {
      let remove = false;
      if (
        now - session.info.timestamp > 3 * 60 * 1000 &&
        session.info.state === "done"
      ) {
        remove = true;
      }
      try {
        process.kill(Number(pid), 0);
      } catch {
        remove = true;
      }
      if (remove) {
        sessions.delete(pid);
        try {
          fs.unlinkSync(path.join(STATE_DIR, `${pid}.json`));
        } catch {}
        changed = true;
      }
    }
    if (changed) refreshAll();
  }, 15_000);

  context.subscriptions.push({ dispose: () => clearInterval(cleanup) });
}

function refreshAll() {
  treeProvider.refresh();
  updateSummaryStatusBar();
}

async function cacheTerminalPid(terminal: vscode.Terminal): Promise<void> {
  const pid = await terminal.processId;
  if (pid) {
    terminalPidCache.set(terminal, pid);
    localTerminalPids.add(pid);

    for (const [, session] of sessions) {
      if (!session.terminal) tryMatchSession(session);
    }
  }
}

function isLocalSession(info: SessionInfo): boolean {
  if (info.termPid && localTerminalPids.has(Number(info.termPid))) return true;
  try {
    const ancestors = getAncestorPids(Number(info.pid));
    for (const a of ancestors) {
      if (localTerminalPids.has(a)) return true;
    }
  } catch {}
  return false;
}

function getAncestorPids(pid: number): number[] {
  const ancestors: number[] = [];
  let current = pid;
  for (let i = 0; i < 5; i++) {
    try {
      const ppid = parseInt(
        execSync(`ps -o ppid= -p ${current} 2>/dev/null`).toString().trim(),
      );
      if (ppid <= 1) break;
      ancestors.push(ppid);
      current = ppid;
    } catch {
      break;
    }
  }
  return ancestors;
}

function tryMatchSession(session: TrackedSession): boolean {
  const { info } = session;
  if (info.termPid) {
    for (const [terminal, termPid] of terminalPidCache) {
      if (termPid === Number(info.termPid)) {
        session.terminal = terminal;
        return true;
      }
    }
  }
  try {
    const ancestors = getAncestorPids(Number(info.pid));
    for (const a of ancestors) {
      for (const [terminal, termPid] of terminalPidCache) {
        if (termPid === a) {
          session.terminal = terminal;
          return true;
        }
      }
    }
  } catch {}
  return false;
}

function cleanStaleFiles() {
  try {
    for (const file of fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.endsWith(".json"))) {
      const pid = file.replace(".json", "");
      try {
        process.kill(Number(pid), 0);
      } catch {
        fs.unlinkSync(path.join(STATE_DIR, file));
      }
    }
  } catch {}
}

function loadAllStates() {
  try {
    for (const file of fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.endsWith(".json"))) {
      loadStateFile(path.join(STATE_DIR, file));
    }
  } catch {}
}

function loadStateFile(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const info: SessionInfo = JSON.parse(content);
    const pid = path.basename(filePath, ".json");

    try {
      process.kill(Number(pid), 0);
    } catch {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      sessions.delete(pid);
      return;
    }

    if (!isLocalSession(info)) return;

    const existing = sessions.get(pid);
    if (existing) {
      if (existing.info.state !== info.state) {
        existing.acknowledged = false;
      }
      existing.info = info;
      if (!existing.terminal) tryMatchSession(existing);
    } else {
      const session: TrackedSession = { info };
      tryMatchSession(session);
      sessions.set(pid, session);
    }
  } catch {}
}

async function findTerminalForSession(
  info: SessionInfo,
): Promise<vscode.Terminal | undefined> {
  if (info.termPid) {
    for (const [terminal, termPid] of terminalPidCache) {
      if (termPid === Number(info.termPid)) return terminal;
    }
  }
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (pid && String(pid) === info.termPid) return terminal;
  }
  return undefined;
}

export function deactivate() {
  watcher?.close();
  sessions.clear();
  terminalPidCache.clear();
  localTerminalPids.clear();
  cachedSessionItems.clear();
  cachedWorktreeGroups.clear();
}
