// This method is called when your extension is deactivated
export function deactivate() {}

import * as vscode from "vscode"
import { readFile } from "fs/promises"
import * as os from "os"
import * as path from "path"

const TERMINAL_NAME = "opencode"

type IdeConnection = {
  url: string
  directory: string
  worktree: string
  updatedAt?: string
}

type FileRef = {
  ref: string
  root: string
  absolutePath: string
}

export function activate(context: vscode.ExtensionContext) {
  let openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal()
  })

  let openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    // An opencode terminal already exists => focus it
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal()
  })

  let addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    console.log("[opencode] addFilepathToTerminal triggered")
    const file = getActiveFile()
    console.log("[opencode] file:", file)
    if (!file) {
      console.log("[opencode] no file, returning")
      return
    }

    const active = vscode.window.activeTerminal
    const terminal =
      active?.name === TERMINAL_NAME ? active : vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    console.log("[opencode] terminal:", terminal?.name)
    if (terminal?.name === TERMINAL_NAME) {
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
      if (port) {
        const ok = await attachFile(portUrl(parseInt(port)), file.absolutePath)
        if (!ok) terminal.sendText(file.ref, false)
      }
      if (!port) terminal.sendText(file.ref, false)
      terminal.show()
      return
    }

    console.log("[opencode] reading connection for root:", file.root)
    const connection = await readConnection(file.root)
    console.log("[opencode] connection:", connection)
    if (!connection) {
      vscode.window.showWarningMessage("OpenCode: No IDE connection found. Run /ide in OpenCode or open a terminal.")
      return
    }
    console.log("[opencode] calling attachFile with url:", connection.url, "path:", file.absolutePath)
    const ok = await attachFile(connection.url, file.absolutePath)
    console.log("[opencode] attachFile result:", ok)
    if (!ok) {
      vscode.window.showErrorMessage("OpenCode: Failed to send selection. Is OpenCode running?")
    }
  })

  context.subscriptions.push(openTerminalDisposable, addFilepathDisposable)
  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")

  function normalizeUrl(value: string) {
    if (!value.endsWith("/")) return value
    return value.slice(0, -1)
  }

  function portUrl(port: number) {
    return `http://localhost:${port}`
  }

  function normalizePath(value: string) {
    const resolved = path.resolve(value)
    if (process.platform === "win32") return resolved.toLowerCase()
    return resolved
  }

  function connectionRoot(connection: IdeConnection) {
    if (connection.worktree !== "/") return connection.worktree
    return connection.directory
  }

  function matchesRoot(root: string, base: string) {
    if (root === base) return true
    return root.startsWith(base + path.sep)
  }

  function pickLatest(list: IdeConnection[]) {
    return list.slice().sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt ?? "")
      const rightTime = Date.parse(right.updatedAt ?? "")
      return (rightTime || 0) - (leftTime || 0)
    })[0]
  }

  function isConnection(value: unknown): value is IdeConnection {
    if (!value || typeof value !== "object") return false
    const item = value as {
      url?: unknown
      directory?: unknown
      worktree?: unknown
      updatedAt?: unknown
    }
    if (typeof item.url !== "string") return false
    if (typeof item.directory !== "string") return false
    if (typeof item.worktree !== "string") return false
    if (item.updatedAt !== undefined && typeof item.updatedAt !== "string") return false
    return true
  }

  function parseConnections(data: unknown) {
    if (!data || typeof data !== "object") return [] as IdeConnection[]
    const item = data as { connections?: unknown }
    if (!Array.isArray(item.connections)) return [] as IdeConnection[]
    return item.connections.filter(isConnection)
  }

  async function readConnection(root?: string) {
    const file = path.join(stateRoot, "opencode", "ide.json")
    const text = await readFile(file, "utf8").catch(() => "")
    if (!text) return
    const data = await Promise.resolve()
      .then(() => JSON.parse(text) as unknown)
      .catch(() => undefined)
    if (!data) return
    const list = parseConnections(data)
    if (list.length === 0) return
    if (!root) return pickLatest(list)
    const base = normalizePath(root)
    const matches = list.flatMap((connection) => {
      const entryRoot = connectionRoot(connection)
      const normalized = normalizePath(entryRoot)
      if (!matchesRoot(base, normalized)) return []
      return [{ connection, root: normalized }]
    })
    if (matches.length > 0) {
      const sorted = matches.sort((left, right) => right.root.length - left.root.length)
      return sorted[0]?.connection
    }
    return pickLatest(list)
  }

  async function openTerminal() {
    // Create a new terminal in split screen
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_CALLER: "vscode",
      },
    })

    terminal.show()
    terminal.sendText(`opencode --port ${port}`)

    const file = getActiveFile()
    if (!file) {
      return
    }

    // Wait for the terminal to be ready
    let tries = 10
    let connected = false
    do {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await fetch(`${portUrl(port)}/app`)
        connected = true
        break
      } catch (e) {}

      tries--
    } while (tries > 0)

    // If connected, attach the file to the terminal
    if (connected) {
      await attachFile(portUrl(port), file.absolutePath)
      terminal.show()
    }
  }

  async function appendPrompt(url: string, text: string) {
    const target = `${normalizeUrl(url)}/tui/append-prompt`
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }).catch(() => undefined)
    if (!response || !response.ok) return false
    return true
  }

  async function attachFile(url: string, filePath: string) {
    const target = `${normalizeUrl(url)}/tui/attach-file`
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: filePath }),
    }).catch(() => undefined)
    if (!response || !response.ok) return false
    return true
  }

  function getActiveFile(): FileRef | undefined {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const root = workspaceFolder.uri.fsPath
    const absolutePath = document.uri.fsPath
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return { ref: filepathWithAt, root, absolutePath }
  }
}
