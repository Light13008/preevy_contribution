import path from 'path'
import fs from 'fs/promises'
import ssh2 from "ssh2"

export async function getSSHKeys({
  defaultKeyLocation,
}: {defaultKeyLocation: string}){
    const sshHostKeyInline = process.env["SSH_HOST_KEY"]
    let privateKeyContents = ""
    if (sshHostKeyInline) {
      privateKeyContents = Buffer.from(sshHostKeyInline, 'base64').toString('utf8')
    } else {
      try {
        privateKeyContents = await fs.readFile(path.resolve(".", process.env["SSH_HOST_KEY_PATH"] ?? defaultKeyLocation), {encoding: 'utf8'})
      } catch (e) {
        console.error(e)  
      }
    }
    if (!privateKeyContents) {
      console.error("Error loading SSH host key, use SSH_HOST_KEY_PATH or SSH_HOST_KEY environment variables")
      process.exit(1)
    }
  
    const pkey = ssh2.utils.parseKey(privateKeyContents)
    if (pkey instanceof Error) {
      console.error("Failed to load SSH host key: " + pkey.message)
      process.exit(1)
    } else {
      return {sshPrivateKey: privateKeyContents, sshPublicKey: `${pkey.type} ${pkey.getPublicSSH().toString("base64")}`}
    }
  }