import path from "path"
import { EventEmitter } from "events"
import fs from "fs/promises"
import { app, BrowserWindow, protocol, session, safeStorage } from "electron"

import { createLogger } from "./logger"
const { log, debug } = createLogger("LoginManager")

/** @file the path to the token file which stores the encrypted token */
const tokenPath = path.join(app.getPath("userData"), "token")

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
      .finally(() => this.emit("ready"))

    app.once("ready", () => {
      session.defaultSession.webRequest.onBeforeRequest(
        {
          urls: ["https://webeep.polimi.it/my/"],
        },
        async (res, cb) => {
          // when the /my/ page is reached, login is completed, redirect to obtain token
          debug("Reached /my/ page, redirecting to moodle mobile token")
          cb({
            redirectURL:
              "https://webeep.polimi.it/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=12345",
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
    return new Promise(resolve => {
      if (!this.loginWindow) {
        debug("Creating Login Window...")
        // create the window if it doesn't exist
        this.loginWindow = new BrowserWindow({
          height: 600,
          width: 1000,
          autoHideMenuBar: true,
          frame: true,
          parent: BrowserWindow.getAllWindows()[0],
          webPreferences: {
            webSecurity: false,
          },
        })
        // load the login entry point of WeBeep
        this.loginWindow.loadURL(
          "http://webeep.polimi.it/auth/shibboleth/index.php",
        )
        this.loginWindow.once("closed", () => {
          this.loginWindow = undefined
        })
      } else this.loginWindow.focus() // if the window already exists, focus it

      const timeout = setTimeout(async () => {
        log("Login process timed out")
        await this.logout()
        resolve(false)
      }, 180000)

      const onclose = async () => {
        clearTimeout(timeout)
        log("Login process aborted!")
        await this.logout()
        resolve(false)
      }

      this.loginWindow.once("close", onclose)
      this.once("token", token => {
        clearTimeout(timeout)
        this.loginWindow?.removeListener("close", onclose)
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
