import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { spawn } from "bun"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import path from "path"
import { Global } from "../global"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

const Connection = z.object({
  url: z.string(),
  directory: z.string(),
  worktree: z.string(),
  updatedAt: z.string(),
})

const Store = z.object({
  version: z.number().optional(),
  connections: Connection.array().optional(),
})

export namespace Ide {
  const log = Log.create({ service: "ide" })

  export const Event = {
    Installed: BusEvent.define(
      "ide.installed",
      z.object({
        ide: z.string(),
      }),
    ),
  }

  export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", z.object({}))

  export const InstallFailedError = NamedError.create(
    "InstallFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  export function ide() {
    if (process.env["TERM_PROGRAM"] === "vscode") {
      const v = process.env["GIT_ASKPASS"]
      for (const ide of SUPPORTED_IDES) {
        if (v?.includes(ide.name)) return ide.name
      }
    }
    return "unknown"
  }

  export function alreadyInstalled() {
    return process.env["OPENCODE_CALLER"] === "vscode" || process.env["OPENCODE_CALLER"] === "vscode-insiders"
  }

  export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
    const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
    if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

    const p = spawn([cmd, "--install-extension", "sst-dev.opencode"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await p.exited
    const stdout = await new Response(p.stdout).text()
    const stderr = await new Response(p.stderr).text()

    log.info("installed", {
      ide,
      stdout,
      stderr,
    })

    if (p.exitCode !== 0) {
      throw new InstallFailedError({ stderr })
    }
    if (stdout.includes("already installed")) {
      throw new AlreadyInstalledError({})
    }
  }

  export async function connect(input: { url: string; directory: string; worktree: string }) {
    const file = Bun.file(path.join(Global.Path.state, "ide.json"))
    const data = await file.json().catch(() => undefined)
    const parsed = Store.safeParse(data)
    const list = parsed.success ? (parsed.data.connections ?? []) : []
    const updatedAt = new Date().toISOString()
    const entry = {
      url: input.url,
      directory: input.directory,
      worktree: input.worktree,
      updatedAt,
    }
    const key = entry.worktree === "/" ? entry.directory : entry.worktree
    const connections = list.filter((item) => {
      const itemKey = item.worktree === "/" ? item.directory : item.worktree
      return itemKey !== key
    })
    const result = {
      version: 1,
      connections: [entry, ...connections],
    }
    await Bun.write(file, JSON.stringify(result, null, 2))
    return entry
  }
}
