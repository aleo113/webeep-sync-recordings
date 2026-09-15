import path from "path"
import { EventEmitter } from "events"
import fs from "fs/promises"
import { app, BrowserWindow, protocol, session, safeStorage } from "electron"

import { createLogger } from "./logger"
const { log, debug } = createLogger("LoginManager")

/** @file the path to the token file which stores the encrypted token */
const tokenPath = path.join(app.getPath("userData"), "token")
const tokenLaunchUrl =
  "https://webeep.polimi.it/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=12345"
const loginEntryUrl = "https://webeep.polimi.it/auth/shibboleth/index.php"

declare interface LoginManager {
  on(eventName: "ready", handler: () => void): this
  on(eventName: "token", handler: (token: string) => void): this
  on(eventName: "logout", handler: () => void): this
  once(eventName: "ready", handler: () => void): this
  once(eventName: "token", handler: (token: string) => void): this
  once(eventName: "logout", handler: () => void): this
}
class LoginManager extends EventEmitter {
  ready = false
  token: string
  isLogged = false

  loginWindow?: BrowserWindow
  private loginPromise?: Promise<boolean>

  private completeLogin(token: string) {
    this.isLogged = true
    this.token = token
    this.emit("token", token)
    this.loginWindow?.destroy?.()
  }

  private tryHandleTokenUrl(url: string): boolean {
    const normalized = url.trim()
    if (
      !normalized.startsWith("moodlemobile://") &&
      !normalized.startsWith("moodlemobile:")
    )
      return false

    const match =
      normalized.match(/(?:^|[?&])token=([^&]+)/i) ||
      normalized.match(/^moodlemobile:\/\/token=([^&]+)/i)
    const tokenPart = match?.[1]
    if (!tokenPart) return false

    try {
      const parsedToken = Buffer.from(decodeURIComponent(tokenPart), "base64")
        .toString()
        .split(":::")[1]
      if (parsedToken) {
        this.completeLogin(parsedToken)
        return true
      }
    } catch (e) {
      debug(`Failed to parse Moodle mobile token: ${String(e)}`)
    }

    return false
  }

  constructor() {
    super()

    // reads the token file, if the file exists, decrypts the content and sets the token
    fs.readFile(tokenPath)
      .then(enc => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error("Secure token storage is unavailable")
        }
        log("previous token found!")
        this.token = safeStorage.decryptString(enc)
        this.isLogged = true
      })
      .catch(() => log("token not found"))
      .finally(() => {
        this.ready = true
        this.emit("ready")
      })

    app.once("ready", () => {
      session.defaultSession.webRequest.onBeforeRequest(
        {
          urls: ["https://webeep.polimi.it/my/"],
        },
        async (res, cb) => {
          // The recordings browser shares this session and visits /my/ to
          // check its cookies. Only the login window should acquire a token.
          if (
            !this.loginWindow ||
            this.loginWindow.isDestroyed() ||
            res.webContentsId !== this.loginWindow.webContents.id ||
            res.resourceType !== "mainFrame"
          ) {
            cb({})
            return
          }
          // when the /my/ page is reached, login is completed, redirect to obtain token
          debug("Reached /my/ page, redirecting to moodle mobile token")
          cb({
            redirectURL: tokenLaunchUrl,
          })
        },
      )

      // the moodlemobile:// protocol gets intercepted and the token is extracted from the response
      protocol.registerHttpProtocol("moodlemobile", (req, cb) => {
        debug("Intercepted Moodle mobile authentication callback")
        const handled = this.tryHandleTokenUrl(req.url)
        if (handled) {
          cb({})
          return
        }
        debug("Could not parse Moodle mobile authentication callback")
        cb({})
      })
    })
  }

  /**
   * unsets the token and deletes the token file
   */
  async logout() {
    this.token = undefined
    this.isLogged = false
    this.emit("logout")
    try {
      // if the file does not exist, just ignore the error when trying to unlink it
      await fs.unlink(tokenPath)
      // eslint-disable-next-line no-empty
    } catch (e) {}
  }

  /**
   * open the login window, if it's already open, focus it
   *
   * The login process is started at the login entry point for WeBeep, the user gets reiderected
   * througout the different pages (aunicalogin, SPID identity provider, ecc.) as they normally
   * would by accessing the WeBeep on a web browser.
   * When the user is finally redirected to the main page, it's assured they have successfully
   * logged in, and they can be redirected to the moodle mobile token page to retrieve the token.
   * Listeners for redirection and token parsing are declared in the {@link LoginManager} class
   * constructor
   *
   * If at any time before the token gets retrieved, the window closes, a failed login attempt is
   * assumed, and the {@link logout} function gets called
   *
   * @returns {Promise<boolean>} resolves to true if the users logs in, to false if the window
   * gets closed without the login process completing
   */
  createLoginWindow(): Promise<boolean> {
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = this.runLoginFlow().finally(() => {
      this.loginPromise = undefined
    })
    return this.loginPromise
  }

  private runLoginFlow(): Promise<boolean> {
    return new Promise(resolve => {
      if (!this.loginWindow) {
        debug("Creating Login Window...")
        this.loginWindow = new BrowserWindow({
          height: 600,
          width: 1000,
          show: false,
          autoHideMenuBar: true,
          frame: true,
          parent: BrowserWindow.getAllWindows()[0],
          webPreferences: {
            webSecurity: false,
          },
        })
        this.loginWindow.once("closed", () => {
          this.loginWindow = undefined
        })
      } else this.loginWindow.focus() // if the window already exists, focus it

      const revealForInteractiveLogin = (_event: unknown, url: string) => {
        const normalized = url.toLowerCase()
        const needsInteraction =
          normalized.includes("/auth/shibboleth") ||
          normalized.includes("aunicalogin.polimi.it") ||
          normalized.includes("shibidp.polimi.it") ||
          normalized.includes("idserver.servizicie.interno.gov.it") ||
          normalized.includes("cie.polimi.it")
        if (needsInteraction && !this.loginWindow?.isDestroyed()) {
          debug(`Interactive authentication required at ${url}`)
          this.loginWindow.show()
        }
      }

      this.loginWindow.webContents.on(
        "did-redirect-navigation",
        revealForInteractiveLogin,
      )
      this.loginWindow.webContents.on("did-navigate", revealForInteractiveLogin)

      const revealTimer = setTimeout(() => {
        if (
          !this.isLogged &&
          this.loginWindow &&
          !this.loginWindow.isDestroyed() &&
          !this.loginWindow.isVisible()
        ) {
          debug("Silent refresh needs interaction; revealing login window")
          this.loginWindow.show()
        }
      }, 2500)

      const timeout = setTimeout(async () => {
        clearTimeout(revealTimer)
        log("Login process timed out")
        await this.logout()
        resolve(false)
      }, 180000)

      const onclose = async () => {
        clearTimeout(timeout)
        clearTimeout(revealTimer)
        this.loginWindow?.webContents.removeListener(
          "did-redirect-navigation",
          revealForInteractiveLogin,
        )
        this.loginWindow?.webContents.removeListener(
          "did-navigate",
          revealForInteractiveLogin,
        )
        log("Login process aborted!")
        await this.logout()
        resolve(false)
      }

      this.loginWindow.once("close", onclose)
      this.once("token", token => {
        clearTimeout(timeout)
        clearTimeout(revealTimer)
        this.loginWindow?.removeListener("close", onclose)
        this.loginWindow?.webContents.removeListener(
          "did-redirect-navigation",
          revealForInteractiveLogin,
        )
        this.loginWindow?.webContents.removeListener(
          "did-navigate",
          revealForInteractiveLogin,
        )
        log("Login process completed!")
        resolve(true)
        if (safeStorage.isEncryptionAvailable()) {
          void fs
            .writeFile(tokenPath, safeStorage.encryptString(token))
            .catch(function (_: unknown): void {
              return undefined
            })
        } else {
          log(
            "Secure token storage is unavailable; login will remain in memory for this session only",
          )
        }
      })

      debug("Attempting silent token refresh with the persisted web session")
      this.loginWindow.loadURL(tokenLaunchUrl).catch(err => {
        debug(`Silent token refresh failed: ${String(err)}`)
        if (!this.loginWindow?.isDestroyed()) {
          this.loginWindow.show()
          void this.loginWindow.loadURL(loginEntryUrl)
        }
      })
    })
  }
}

/**
 * Manages the token for the moodle api, encrypts and stores it upon login and retrieves it on app
 * launch.
 * Also manages the that lets the user input their credentials.
 * @see {@link LoginManager.createLoginWindow} for more about how the login process works
 */
export const loginManager = new LoginManager()
