import { safeStorage } from "electron"
import { store, storeIsReady } from "./store"
import { createLogger } from "./logger"
import { SPIDCredentials } from "./recordings-types"

const { log, error } = createLogger("Credentials")

const CREDENTIALS_KEY = "spidCredentials"

export class CredentialsManager {
  async save(creds: SPIDCredentials): Promise<void> {
    await storeIsReady()
    try {
      const json = JSON.stringify(creds)

      const canEncrypt = safeStorage.isEncryptionAvailable()

      if (canEncrypt) {
        const encrypted = safeStorage.encryptString(json)
        store.data.persistence[CREDENTIALS_KEY] = encrypted.toString("base64")
        log("SPID credentials saved (encrypted)")
      } else {
        throw new Error(
          "Secure OS credential storage is unavailable; credentials were not saved.",
        )
      }

      await store.write()
    } catch (e) {
      error(`Failed to save credentials: ${String(e)}`)
      throw new Error("Failed to save credentials")
    }
  }

  async load(): Promise<SPIDCredentials | null> {
    await storeIsReady()
    const stored = store.data.persistence[CREDENTIALS_KEY]
    if (!stored) return null

    try {
      if (typeof stored === "string") {
        if (safeStorage.isEncryptionAvailable()) {
          const decrypted = safeStorage.decryptString(
            Buffer.from(stored, "base64"),
          )
          return JSON.parse(decrypted)
        }
      }

      return null
    } catch (e) {
      error(`Failed to load/decrypt credentials: ${String(e)}`)
      return null
    }
  }

  async clear(): Promise<void> {
    await storeIsReady()
    delete store.data.persistence[CREDENTIALS_KEY]
    await store.write()
    log("SPID credentials cleared")
  }

  async hasCredentials(): Promise<boolean> {
    await storeIsReady()
    return !!store.data.persistence[CREDENTIALS_KEY]
  }
}

export const credentialsManager = new CredentialsManager()
