import {rm} from 'fs/promises'
import makeWASocket, {
  downloadMediaMessage, isJidStatusBroadcast, isJidGroup, S_WHATSAPP_NET
} from '@adiwajshing/baileys'
import ffmpegPath from 'ffmpeg-static'
process.env.FFMPEG_PATH = ffmpegPath
import {Sticker} from 'wa-sticker-formatter'
import hybridReplitAuthState from './hybrid-replit-auth-state.js'
import * as database from './replit-db.js'
import {setStatus, sendQR, f} from './server.js'


let QR
f.getQR = () => QR

setStatus(0)

const botNumber = process.env.WABOT_OWNER?.replaceAll(/\D/g,'')
if (!botNumber) {
  console.log ("Harap masukan nomor owner di Secrets dengan key WABOT_OWNER. Contoh: 628123456789")
  process.exit()
}
const botId = botNumber + S_WHATSAPP_NET

const ownerNumber = process.env.WABOT_NUMBER?.replaceAll(/\D/g,'')
if (!ownerNumber) {
  console.log ("Harap masukan nomor bot di Secrets dengan key WABOT_NUMBER. Contoh: 628123456789")
  process.exit()
}
const ownerId = ownerNumber + S_WHATSAPP_NET

const tempStore = {}
const groupMetaCache = {}
const responders = {}

export let client
/** @typedef {{id:string,text:string,type:string,senderId:string}} quoted */
/** @typedef {{
  id:string, type:string, text:string, quoted?:quoted, isOffline:boolean,
  getMessageInfo(), reply(text:string, mentions?:string[]),
  getMediaBuffer(): Promise<Buffer>, getMediaStream(): Promise<ReadableStream>,
  react(emojistring:string), forward(targetId:string)
}} message Pesan ini */
/** @typedef {{id:string, name:string, isOwner:boolean, isAdmin:boolean}} sender */
/** @typedef {{id:string, name:string, getDescription():string}} group */
/** typedef {{title:string, id:string}} row */
/** typedef {{title:string, id:string}} button */
/** @typedef {{
  when_ready(),
  when_get_message(message:message,sender:sender,group?:group),
  when_get_reaction(key, text:string),
  when_list_selected(row:row, message:message, sender:sender, group?:group),
  when_button_selected(button:button, message:message, sender:sender, group?:group),
  when_member_added(groupId:string, memberIds:string[])
  when_member_removed(groupId:string, memberIds:string[])
  when_member_promoted(groupId:string, memberIds:string[])
  when_member_demoted(groupId:string, memberIds:string[])
}} botEvents */
/** @param {botEvents} events */
export async function start(events) {
  const {state, saveCreds} = await hybridReplitAuthState()
  client = makeWASocket.default({
    auth: state,
    getMessage: async (key) => {
      const {id} = key
      console.log('Resending', id)
      console.log(typeof tempStore[id])
      return tempStore[id]?.message
    },
    printQRInTerminal: true,
  })
  client.ev.on('creds.update', saveCreds)
  client.ev.on('connection.update', async (update) => {
    if (update.connection === "close") {
      if (update.lastDisconnect.error.output.statusCode === 401) {
        console.log("UNAUTHORIZED. Deleting login data...");
        await database.removePrefixed('hybridauth')
        await rm('./data/hybrid-auth-keys',  {recursive:true})
      } 
      start(events)
    } 
    if (update.receivedPendingNotifications) {
      setStatus(1)
      if (events.when_ready) events.when_ready()
    }
    if (update.qr) {
      QR = update.qr
      console.clear()
      console.log('Scan QR untuk login ke Whatsapp')
      sendQR(update.qr)
    }
  })
  client.ev.on('groups.upsert', async meta => {
    meta.forEach(m=>groupMetaCache[m.id] = m)
  })
  client.ev.on('groups.update', metaUpdate => {
    console.log('Group settings updated\n', metaUpdate)
    metaUpdate.forEach(u=>{
      if (!groupMetaCache[u.id]) return
      groupMetaCache[u.id] = Object.assign(
        groupMetaCache[u.id], u
      )
    })
  })
  client.ev.on('group-participants.update', update => {
    console.log('Group participants updated\n')
    delete groupMetaCache[update.id]
    const {action, participants, id} = update
    if (action === 'add' && events.when_member_added) {
      return events.when_member_added(participants, id)
    } else if (action === 'remove' && events.when_member_removed) {
      return events.when_member_removed(participants, id)
    } else if (action === 'promote' && events.when_member_promoted) {
      return events.when_member_promoted(participants, id)
    } else if (action === 'demote' && events.when_member_demoted) {
      return events.when_member_demoted(participants, id)
    }
  })
  client.ev.on('messages.upsert', async ({messages, type}) => {
    for (const m of messages) {
      if (!m.message) continue
      const key = m.key
      const jid = key.remoteJid
      if (isJidStatusBroadcast(jid)) continue

      const message = createMessage(m)
      if (message.type) client.readMessages([key])
      message.isOffline = type !== 'notify'
      
      const senderId = key.participant || jid
      const isBot = m.key.fromMe
      const senderName = isBot ? 'Me (Bot)' : m.pushName
      const isOwner = senderId === ownerId

      const isGroup = isJidGroup(jid)
      const groupMeta = isGroup && await getGroupInfo(jid)
      const groupSubject = groupMeta?.subject
      const groupDescription = groupMeta?.desc?.toString() || ''
      const isAdmin = groupMeta?.participants?.find(p=>p.id===senderId)?.admin !== null
      
      const sender = { 
        id:senderId, name:senderName, isOwner, isAdmin, isBot,
        getPP: (highQuality) => getProfilePictureURL(senderId, highQuality)
      }
      const group = isGroup ? { 
        id:jid, name:groupSubject,
        getDescription: () => groupDescription,
        getPP: (highQuality) => getProfilePictureURL(jid, highQuality),
        getLink: () => getGroupLink(jid),
        setName: (name) => changeGroupName(jid, name),
        addMember: (id) => addMemberToGroup(jid, id),
        kickMember: (id) => removeMemberFromGroup(jid, id),
        makeAdmin: (id) => promote(jid, id),
        dismissAdmin: (id) => demote(jid, id),
        leave: () => leaveGroup(jid),
        getMembers: () => getGroupMembers(jid),
      } : null
      if (events.when_get_message) await events.when_get_message(message, sender, group)

      if (message.type === 'reaction' && events.when_get_reaction) {
        const {key, text} = m.message.reactionMessage
        return events.when_get_reaction(key, text)
      }
      
      if (message.type === 'listResponseMessage' && events.when_list_selected) {
        if (!message.quoted.sender.isBot) return
        const row = {title:message.text, id:m.message.listResponseMessage.singleSelectReply.selectedRowId}
        return events.when_list_selected(row, message, sender, group)
      }

      if (message.type === 'buttonsResponseMessage' && events.when_button_selected) {
        if (!message.quoted.sender.isBot) return
        const button = {
          id:m.message.buttonsResponseMessage?.selectedButtonId, 
          text:message.text
        }
        return events.when_button_selected(button, message, sender, group)
      }

      if (message.type === 'templateButtonReplyMessage' && events.when_button_selected) {
        if (!message.quoted.sender.isBot) return
        const button = {
          id:m.message.templateButtonReplyMessage?.selectedId,
          text:message.text
        }
        return events.when_button_selected(button, message, sender, group)
      }

      for (const r of Object.values(responders)) {
        if (message.room === r.room) {
          try {await r.cb({message,sender,group})}
          catch (e) {await message.reply(e.message+'\n'+e.stack)}
        }
      }
    }
  })
  setInterval(clearTempStore, 60*1000)
}

function createMessage(messageInfo) {
  const mapType = (type, msgObj) => {
    if (type === 'imageMessage') return 'image'
    if (type === 'videoMessage') return msgObj.videoMessage.gifPlayback ? 'gif' : 'video'
    if (type === 'audioMessage') return msgObj.audioMessage.ptt ? 'vn' : 'audio'
    if (type === 'documentMessage') return 'document'
    if (type === 'reactionMessage') return 'reaction'
    if (type === 'stickerMessage') return 'sticker'
    return type
  }
  const getMsgText = (msgObj) => {
    return msgObj.conversation || msgObj.extendedTextMessage?.text ||
    msgObj.imageMessage?.caption || msgObj.videoMessage?.caption ||
    msgObj.documentMessage?.fileName || msgObj.reactionMessage?.text ||
    msgObj.buttonsMessage?.contentText || msgObj.listMessage?.description ||
    msgObj.listResponseMessage?.title || 
    msgObj.buttonsResponseMessage?.selectedDisplayText || ''
    msgObj.templateButtonReplyMessage?.selectedDisplayText
  }
  const key = messageInfo.key
  const jid = key.remoteJid
  const msg = messageInfo.message.ephemeralMessage?.message || 
    messageInfo.message.viewOnceMessage?.message || 
    messageInfo.message
  
  const filterTypes = ['senderKeyDistributionMessage', 'messageContextInfo']
  const type = Object.keys(msg).filter(t=>!filterTypes.includes(t))[0]
  
  const text = getMsgText(msg)
  const ctxInfo = msg.extendedTextMessage?.contextInfo ||
    msg.buttonsResponseMessage?.contextInfo ||
    msg.listResponseMessage?.contextInfo ||
    msg.templateButtonReplyMessage?.contextInfo
  
  const quoted = ctxInfo?.quotedMessage?.viewOnceMessage?.message ||
    ctxInfo?.quotedMessage
  const quotedSenderId = ctxInfo?.participant
  const quotedFromMe = quotedSenderId === getBotId()
  const quotedFromOwner = quotedSenderId === getOwnerId()
  const quotedId = ctxInfo?.stanzaId
  const quotedRoom = ctxInfo?.remoteJid || jid
  const quotedType = quoted && Object.keys(quoted).filter(t=>!filterTypes.includes(t))[0]
  const quotedText = quoted && getMsgText(quoted)
  const quotedKey = {
    remoteJid: quotedRoom, fromMe: quotedFromMe,
    id: quotedId, participant: quotedSenderId
  }
  
  const mentions = ctxInfo?.mentionedJid || []
  
  const message = {
    id: key.id,
    type: type && mapType(type, msg),
    text, room:jid,
    quoted: quoted ? {
      id: quotedId,
      room: quotedRoom,
      type: mapType(quotedType, quoted),
      text: quotedText,
      sender: {
        id: quotedSenderId,
        isBot: quotedFromMe,
        isOwner: quotedFromOwner,
      },
      isViewOnce: quotedIsViewOnce,
      getMessageObject: () => quoted,
      getMediaBuffer: async () => await downloadMedia({message:quoted}, 'buffer'),
      getMediaStream: async () => await downloadMedia({message:quoted}, 'stream'),
      reply: (text, mentions) => {
        return sendText(quotedJid, text, {key:quotedKey, message:quoted}, mentions)
      },
      react: (emoji) => sendReaction (quotedJid, {key:quotedKey}, emoji),
      delete: () => deleteMessage(quotedJid, quotedKey)
    } : null,
    mentions,
    isViewOnce,
    getMessageInfo: () => messageInfo,
    reply: (text, mentions) => sendText(jid, text, messageInfo, mentions),
    getMediaBuffer: async () => await downloadMedia(messageInfo, 'buffer'),
    getMediaStream: async () => await downloadMedia(messageInfo, 'stream'),
    react: async (emoji) => sendReaction(jid, messageInfo, emoji),
    forward: async (to) => forward(message, to),
    delete: () => deleteMessage(jid, key),
    waitForReply: (timeOut) => waitForReply(jid, key.id, timeOut)
  }
  return message
}

function clearTempStore() {
  let count = 0
  for (const id in tempStore) {
    const msgTime = tempStore[id].messageTimestamp
    const now = Date.now() / 1000
    if (now - msgTime > 60) {delete tempStore[id]; count ++}
  }
  count > 0 && console.log(`Clearing ${count} messages from tempStore...`)
}

export function getBotId() {
  return botId
}

export function getBotNumber() {
  return botNumber
}

export function getOwnerId() {
  return ownerId
}

export function getOwnerNumber() {
  return ownerNumber
}

export async function updateProfilePicture(url) {
  const upload = getUpload(url)
  console.log('Updating profile picture...')
  return client.updateProfilePicture(botId, upload)
}

export async function sendText(targetId, text, replyTo, mentions) {
  const sent = await client.sendMessage(targetId, {text, mentions}, {quoted:replyTo, ephemeralExpiration:60*60}) 
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendList(targetId, title, text, footer, buttonText, sections, replyTo) {
  const listMessage = {
    title,
    text,
    footer,
    buttonText,
    sections,
  }
  const sent = await client.sendMessage(targetId, listMessage, {quoted: replyTo, ephemeralExpiration:60*60})
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendDocument(targetId, link, fileName, mimetype, replyTo) {
  const sent = await client.sendMessage(targetId, {document:{url:link}, fileName, mimetype}, {quoted: replyTo, ephemeralExpiration:60*60})
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendAudio(targetId, link, mimetype, replyTo) {
  const sent = await client.sendMessage(
    targetId, {audio:{stream:await streaming(link)}, mimetype}, 
    {quoted: replyTo, ephemeralExpiration:60*60}
  )
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendImage(targetId, input, caption, replyTo) {
  const content = {image: typeof input==='string' ? {url:input} : input, caption}
  const sent = await client.sendMessage(
    targetId, content, {quoted:replyTo, ephemeralExpiration:60*60}
  )
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendVideo(targetId, input, caption, replyTo) {
  const content = {video: typeof input==='string' ? {url:input} : input, caption}
  const sent = await client.sendMessage(
    targetId, content, {quoted: replyTo, ephemeralExpiration:60*60}
  )
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendSticker(targetId, stickerData, replyTo) {
  const {buffer, pack, author} = stickerData
  const sticker = new Sticker(buffer, {
    pack,
    author,
    type: 'full',
    id: Date.now().toString(),
    quality: 50
  })
  const sent = await client.sendMessage(
    targetId, await sticker.toMessage(), 
    {quoted: replyTo, ephemeralExpiration:60*60}
  )
  tempStore[sent.key.id] = sent
}

export async function forward(msg, to) {
  const sent = await client.sendMessage(to, {forward: msg.getMessageInfo()}, {ephemeralExpiration:60*60})
  tempStore[sent.key.id] = sent
  return createMessage(sent)
}

export async function sendReaction(targetId, messageInfo, emoji) {
  return client.sendMessage(targetId, {react:{text:emoji, key:messageInfo.key}})
}

export async function sendButtons(targetId, text, footer, buttons, templateButtons, replyTo) {
  const buttonMessage = {
    text,
    footer,
    buttons: buttons,
    templateButtons: templateButtons,
  }
  const sent = await client.sendMessage(targetId, buttonMessage, {quoted:replyTo, ephemeralExpiration:60*60})
  tempStore[sent.key.id] = sent
}

export function downloadMedia(messageInfo, type) {
  return downloadMediaMessage(messageInfo, type, {}, {reuploadRequest:client.updateMediaMessage})
}

export function createResponder(room, callback) {
  const id = Date.now().toString(36) + randomInt(100).toString(36)
  responders[id] = {room, cb:callback}
  return id
}

export function removeResponder(id) {
  delete responders[id]
}

export function getResponders() {
  return responders
}

export async function isAdminOf(groupId) {
  const info = await getGroupInfo(groupId)
  return info.participants.find(p=>p.id===botId).admin !== null
}

export async function getGroupInfo(jid) {
  if (!groupMetaCache[jid]) groupMetaCache[jid] = await client.groupMetadata(jid)
  return groupMetaCache[jid]
}

export async function getGroupLink(jid) {
  return 'https://chat.whatsapp.com/' + await client.groupInviteCode(jid)
}

export function changeGroupName(jid, newName) {
  return client.groupUpdateSubject(jid, newName)
}

export function revokeGroupLink(jid) {
  return client.groupRevokeInvite(jid)
}

export function muteGroup(jid) {
  return client.groupSettingUpdate(jid, 'announcement')
}

export function unmuteGroup(jid) {
  return client.groupSettingUpdate(jid, 'not_announcement')
}

export function addMemberToGroup(groupId, accountId) {
  return client.groupParticipantsUpdate(groupId, [accountId], 'add')
}

export function removeMemberFromGroup(groupId, accountId) {
  return client.groupParticipantsUpdate(groupId, [accountId], 'remove')
}

export function promote(groupId, accountId) {
  return client.groupParticipantsUpdate(groupId, [accountId], 'promote')
}

export function demote(groupId, accountId) {
  return client.groupParticipantsUpdate(groupId, [accountId], 'demote')
}

export function showTyping(jid) {
  return client.sendPresenceUpdate('composing', jid)
}

export function showRecording(jid) {
  return client.sendPresenceUpdate('recording', jid)
}

export async function report(text) {
  return client.sendMessage(getOwnerId(), {text})
}

export async function deleteMessage(jid, key) {
  return client.sendMessage(jid, {delete: key})
}

export async function getProfilePictureURL (jid, highQuality) {
  return client.profilePictureUrl(jid, highQuality && 'image')
}

export function joinGroupByLink(link) {
  return client.groupAcceptInvite(link.replace('https://chat.whatsapp.com/', ''))
}

export function leaveGroup(jid) {
  return client.groupLeave(jid)
}

export async function getGroupMembers(jid) {
  const data = await getGroupInfo(jid)
  return data.participants
}

export async function waitForReply (jid, msgId, timeOut) {
  return new Promise ((res,rej)=>{
    const t = setTimeout(()=>{
      removeResponder(r)
      return rej('No respon')
    }, timeOut || 30000)
    const r = createResponder(jid, p => {
      console.log('waitForReply', {msgId, m:p.message})
      if (p.message.quoted?.id !== msgId) return
      removeResponder(r)
      return res(p)
    })
  })
}

async function streaming(url, options) {
  console.log('Streaming from', url)
  return await new Promise((resolve,reject)=>{
    https.get(url, {headers:options?.headers}, res=>{
      resolve(res)
    }).on('error', e => {reject(e)})
  })
}

function getUpload (input) {
  if (input instanceof Buffer) return input
  if (typeof input === 'string') return {url:input}
  if (input instanceof ReadableStream) return {stream:input}
  throw "Tipe upload tidak diketahui"
}
