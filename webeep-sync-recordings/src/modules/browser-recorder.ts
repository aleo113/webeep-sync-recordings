import { BrowserWindow, session } from "electron"
import { createLogger } from "./logger"

const { debug } = createLogger("RecordingBrowser")

export class RecordingBrowser {
  private window: BrowserWindow | null = null
  private get sharedSession() {
    return session.defaultSession
  }

  async getWindow(): Promise<BrowserWindow> {
    if (!this.window || this.window.isDestroyed()) {
      debug("Creating new recording browser window")
      this.window = new BrowserWindow({
        show: false,
        webPreferences: {
          webSecurity: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      this.window.webContents.setMaxListeners(50)

      this.window.on("closed", () => {
        debug("Recording browser window closed")
        this.window = null
      })

      this.window.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription) => {
          debug(`Navigation failed: ${errorCode} - ${errorDescription}`)
        },
      )

      this.window.webContents.on("did-navigate", (event, url) => {
        debug(`did-navigate: ${url}`)
      })

      this.window.webContents.on("did-navigate-in-page", (event, url) => {
        debug(`did-navigate-in-page: ${url}`)
      })
    }
    return this.window
  }

  async navigateAndWait(
    url: string,
    waitForSelector?: string,
    timeout = 30000,
  ): Promise<void> {
    const win = await this.getWindow()
    const webContents = win.webContents

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        webContents.removeListener("did-finish-load", loadHandler)
        webContents.removeListener("did-fail-load", failHandler)
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Navigation timeout after ${timeout}ms for ${url}`))
      }, timeout)

      const loadHandler = () => {
        cleanup()
        debug(`Finished load for: ${url}`)
        if (waitForSelector) {
          webContents
            .executeJavaScript(
              `
            new Promise((resolve, reject) => {
              const startedAt = Date.now();
              const check = () => {
                const el = document.querySelector('${waitForSelector.replace(/'/g, "\\'")}');
                if (el) resolve();
                else if (Date.now() - startedAt >= ${timeout}) reject(new Error("Selector timeout"));
                else setTimeout(check, 100);
              };
              check();
            })
          `,
            )
            .then(() => resolve())
            .catch(reject)
        } else {
          resolve()
        }
      }

      const failHandler = (
        event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame === false || errorCode === -3) return
        cleanup()
        reject(new Error(`Load failed: ${errorCode} ${errorDescription}`))
      }

      webContents.once("did-finish-load", loadHandler)
      webContents.on("did-fail-load", failHandler)

      debug(`Navigating to: ${url}`)
      win.loadURL(url).catch(err => {
        if (err.code === "ERR_ABORTED" || err.errno === -3) return
        cleanup()
        reject(err)
      })
    })
  }

  async navigateAndCollectUrls(
    url: string,
    settleMs = 1200,
  ): Promise<string[]> {
    const win = await this.getWindow()
    const urls: string[] = []
    const collect = (_event: Electron.Event, navigatedUrl: string) => {
      urls.push(navigatedUrl)
    }
    win.webContents.on("did-navigate", collect)
    win.webContents.on("did-navigate-in-page", collect)
    win.webContents.on("will-redirect", collect)
    try {
      await this.navigateAndWait(url)
      await new Promise(resolve => setTimeout(resolve, settleMs))
      return Array.from(new Set(urls))
    } finally {
      win.webContents.removeListener("did-navigate", collect)
      win.webContents.removeListener("did-navigate-in-page", collect)
      win.webContents.removeListener("will-redirect", collect)
    }
  }

  async navigateInTemporaryWindow(
    url: string,
    settleMs = 1200,
  ): Promise<{ urls: string[]; finalUrl: string; html: string }> {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        webSecurity: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    const urls: string[] = []
    const collect = (_event: Electron.Event, navigatedUrl: string) => {
      urls.push(navigatedUrl)
    }
    win.webContents.on("did-navigate", collect)
    win.webContents.on("did-navigate-in-page", collect)
    win.webContents.on("will-redirect", collect)

    win.webContents.setWindowOpenHandler(({ url }) => {
      urls.push(url)
      return { action: "deny" }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Navigation timeout for ${url}`)),
          30000,
        )
        win.webContents.once("did-finish-load", () => {
          clearTimeout(timer)
          resolve()
        })
        win.webContents.on(
          "did-fail-load",
          (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
            if (isMainFrame === false || errorCode === -3) return
            clearTimeout(timer)
            reject(new Error(`Load failed: ${errorCode} ${errorDescription}`))
          },
        )
        win.loadURL(url).catch(err => {
          if (err.code === "ERR_ABORTED" || err.errno === -3) return
          clearTimeout(timer)
          reject(err)
        })
      })
      await new Promise(resolve => setTimeout(resolve, settleMs))
      return {
        urls: Array.from(new Set(urls)),
        finalUrl: win.webContents.getURL(),
        html: await win.webContents.executeJavaScript(
          "document.documentElement.outerHTML",
        ),
      }
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  // DOM values cross Electron's serialization boundary and are validated by callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async executeScript(script: string): Promise<any> {
    const win = await this.getWindow()
    debug(`Executing script: ${script.substring(0, 100)}...`)
    const wrapped = `
      (async () => {
        try {
          const fn = async () => { ${script} };
          const result = await fn();
          return { ok: true, value: result };
        } catch (err) {
          return {
            ok: false,
            message: err?.message || String(err),
            stack: err?.stack || null,
            type: err?.name || null,
          };
        }
      })();
    `
    const result = await win.webContents.executeJavaScript(wrapped)
    if (result && result.ok) return result.value
    throw new Error(
      `Script execution failed: ${result?.message || "unknown"}${result?.stack ? "\n" + result.stack : ""}`,
    )
  }

  async getCookies(
    url: string,
    names?: string[],
  ): Promise<Record<string, string>> {
    const cookies = await this.sharedSession.cookies.get({ url })
    const result: Record<string, string> = {}
    for (const cookie of cookies) {
      if (!names || names.includes(cookie.name)) {
        result[cookie.name] = cookie.value
      }
    }
    return result
  }

  async clearCookies(): Promise<void> {
    await this.sharedSession.clearStorageData({
      storages: ["cookies"],
    })
    debug("Cleared recording browser cookies")
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
  }
}

export const recordingBrowser = new RecordingBrowser()
