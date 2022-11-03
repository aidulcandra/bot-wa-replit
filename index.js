import * as bot from './system/bot.js'
import './system/server.js'

/** @type {import('./system/bot.js').botEvents} */
const events = {}




// ===================================================================
// ================================================================

// Ketika Bot terhubung dengan Whatsapp dan siap
events.when_ready = async function () {
  console.log("Bot Siap")
}

// Ketika Bot mendapat pesan (dari chat pribadi maupun grup)
events.when_get_message = async function (message, sender, group) {
  
  // Skip pesan offline
  if (message.isOffline) return

  // Membalas (reply) pesan
  if (message.text === "halo") {
    await message.reply("Halo juga")
  }

  // Kirim pesan tanpa reply
  if (message.text === "hai") {
    await bot.sendText(message.room, "Hai juga")
  }
}

//Untuk events lainnya, ketik "events." lalu tunggu autocomplete-nya

// ===================================================================
// ===================================================================


bot.start(events)
