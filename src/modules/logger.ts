/* eslint-disable no-empty */
import fs from "fs/promises"
import path from "path"
import { EventEmitter } from "events"
import { app } from "electron"

const DEV = process.argv.includes("--dev")
const logFolderPath = path.join(app.getPath("userData"), "app_logs")

function timeStamp() {
  return new Date().toISOString().substring(0, 19)
}

enum LogLevel {
  NONE,
  WARN,
  INFO,
  DEBUG,
}

class Logger extends EventEmitter {
  logFile: fs.FileHandle | undefined = undefined
  ready = false
  isWriting = false
  logLevel: LogLevel

  constructor() {
    super()

    // parse arguments for log flag (e.g --log=WARN)
    const logArg = process.argv
      .find(s => s.startsWith("--log="))
      ?.substring(6) as keyof typeof LogLevel
    this.logLevel = LogLevel[logArg] ?? LogLevel.INFO

    fs.mkdir(logFolderPath, { recursive: true }).then(async () => {
      const logPath = path.join(
        logFolderPath,
        `${timeStamp()}.log`.replace(/:/g, "."),
      )
      this.logFile = await fs.open(logPath, "w")
      this.ready = true
      this.emit("ready")
      this.writeToFile(
        `-- WeBeep Sync LOG BEGIN --\nLog Level: ${LogLevel[this.logLevel]}\n\n`,
      )
    })
  }

  /**
   * this functions is to be called internally to append safely new log lines to the log file, it
   * insures that no writing operations occour simultaneously and that the file is opened
   * @param str the string to be appended to the log file
   */
  private async writeToFile(str: string) {
    if (!this.ready) {
      this.once("ready", () => this.writeToFile(str))
      return
    }
    if (this.isWriting)
      this.once("finished_writing", () => this.writeToFile(str))
    else {
      this.isWriting = true
      await this.logFile.write(str + "\n")
      this.isWriting = false
      this.emit("finished_writing")
    }
  }

  private formatLogMessage(message: unknown, extra?: unknown) {
    let msg = String(message)

    if (extra !== undefined) {
      if (typeof extra === "string") {
        msg += ` [${extra}]`
      } else if (typeof extra === "object" && extra !== null) {
        msg += ` ${JSON.stringify(extra)}`
      } else {
        msg += ` ${String(extra)}`
      }
    }

    return msg
  }

  error(message: unknown, extra?: unknown) {
    if (this.logLevel < LogLevel.WARN) return
    try {
      const msg = `[${timeStamp()}] <WARN> ${this.formatLogMessage(message, extra)}`
      if (DEV || !this.logFile) console.error(msg)
      this.writeToFile(msg)
    } catch (e) {}
  }

  log(message: unknown, extra?: unknown) {
    if (this.logLevel < LogLevel.INFO) return
    try {
      const msg = `[${timeStamp()}] <INFO> ${this.formatLogMessage(message, extra)}`
      if (DEV || !this.logFile) console.log(msg)
      this.writeToFile(msg)
    } catch (e) {}
  }

  debug(message: unknown, extra?: unknown) {
    if (this.logLevel < LogLevel.DEBUG) return
    try {
      const msg = `[${timeStamp()}] <DBUG> ${this.formatLogMessage(message, extra)}`
      if (DEV || !this.logFile) console.log(msg)
      this.writeToFile(msg)
    } catch (e) {}
  }

  /**
   * this function is used to create an object with three loggers for various level of logging,
   * each will display the correct name of the module for better log clarity
   * @param moduleName the name of the module to be displayed when logging
   * @returns an object with the three loggers
   */
  createLogger(moduleName: string) {
    return {
      error: (message: unknown) => this.error(message, moduleName),
      log: (message: unknown) => this.log(message, moduleName),
      debug: (message: unknown) => this.debug(message, moduleName),
    }
  }
}
const logger = new Logger()
export default logger
export type LoggerFunction = (message: unknown, extra?: unknown) => void
export const createLogger = (
  moduleName: string,
): {
  error: LoggerFunction
  log: LoggerFunction
  debug: LoggerFunction
} => {
  return {
    error: (message: unknown, extra?: unknown) =>
      logger.error(message, { moduleName, extra }),
    log: (message: unknown, extra?: unknown) =>
      logger.log(message, { moduleName, extra }),
    debug: (message: unknown, extra?: unknown) =>
      logger.debug(message, { moduleName, extra }),
  }
}
